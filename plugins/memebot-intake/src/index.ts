import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Context, Schema } from 'koishi'

export const name = 'memebot-intake'
export const inject = ['database']

export type IntakeType = 'submission' | 'feedback' | 'suggestion'
export function draftKey(userId: string, conversationId: string) { return `${userId}\u0000${conversationId}` }
export type IntakeStatus =
  | 'pending-review' | 'approved' | 'rejected'
  | 'pending' | 'processing' | 'resolved' | 'closed'
  | 'accepted' | 'declined'

export interface Attachment { name?: string; url?: string; type?: string; relativePath?: string; size?: number; checksum?: string }
export interface DraftMessage { body: string; attachments: Attachment[]; createdAt: number }
export interface IntakeDraft {
  key: string
  type: IntakeType
  submitterId: string
  sourceSession: string
  messages: DraftMessage[]
  updatedAt: number
}
export interface DraftCounts { messages: number; images: number; attachments: number }
export interface IntakeRecord {
  id: string
  type: IntakeType
  submitterId: string
  sourceSession: string
  body: string
  attachments: Attachment[]
  createdAt: number
  updatedAt: number
  status: IntakeStatus
  notes: string[]
}

declare module 'koishi' {
  interface Tables {
    intake: {
      id: string
      type: IntakeType
      submitterId: string
      sourceSession: string
      body: string
      attachments: string
      createdAt: Date
      updatedAt: Date
      status: IntakeStatus
      notes: string
    }
    intakeDraft: {
      key: string
      type: IntakeType
      submitterId: string
      sourceSession: string
      messages: string
      updatedAt: Date
    }
    intakeSequence: { type: IntakeType; value: number }
  }
}

export interface QqTarget { qq: string }
export interface TargetConfig { users?: QqTarget[]; groups?: QqTarget[] }
export interface Config {
  targets: { submission: TargetConfig; feedback: TargetConfig; suggestion: TargetConfig }
  administrators: QqTarget[]
  managementGroups: QqTarget[]
  attachmentPath: string
}

const qqTable = () => Schema.array(Schema.object({ qq: Schema.string().description('QQ 号') }))
const targetSchema = () => Schema.object({ users: qqTable().default([]), groups: qqTable().default([]) })

export const Config: Schema<Config> = Schema.object({
  targets: Schema.object({
    submission: targetSchema().default({ users: [], groups: [] }),
    feedback: targetSchema().default({ users: [], groups: [] }),
    suggestion: targetSchema().default({ users: [], groups: [] }),
  }).default({ submission: { users: [], groups: [] }, feedback: { users: [], groups: [] }, suggestion: { users: [], groups: [] } }),
  administrators: qqTable().default([]).description('可管理本插件的 QQ 用户'),
  managementGroups: qqTable().default([]).description('允许执行管理动作的 QQ 群'),
  attachmentPath: Schema.string().default('data/memebot-intake').description('Intake 附件本地目录'),
})

const initialStatus: Record<IntakeType, IntakeStatus> = { submission: 'pending-review', feedback: 'pending', suggestion: 'pending-review' }
const transitions: Record<IntakeType, Record<IntakeStatus, IntakeStatus[]>> = {
  submission: { 'pending-review': ['approved', 'rejected'], approved: ['closed', 'pending-review'], rejected: ['closed', 'pending-review'], closed: ['pending-review'], pending: [], processing: [], resolved: [], accepted: [], declined: [] },
  feedback: { pending: ['processing', 'closed'], processing: ['resolved', 'closed'], resolved: ['closed', 'pending'], closed: ['pending'], 'pending-review': [], approved: [], rejected: [], accepted: [], declined: [] },
  suggestion: { 'pending-review': ['accepted', 'declined'], accepted: ['closed', 'pending-review'], declined: ['closed', 'pending-review'], closed: ['pending-review'], pending: [], processing: [], resolved: [], approved: [], rejected: [] },
}

export function canTransition(type: IntakeType, from: IntakeStatus, to: IntakeStatus) {
  return transitions[type][from]?.includes(to) ?? false
}

export function isAdmin(session: { userId?: string; guildId?: string; user?: { authority?: number } }, config: Config) {
  const identity = (session.user?.authority ?? 0) >= 4 || (!!session.userId && config.administrators.some(item => item.qq === session.userId))
  const allowedLocation = !session.guildId || !config.managementGroups.length || config.managementGroups.some(item => item.qq === session.guildId)
  return identity && allowedLocation
}

export class IntakeStore {
  private records = new Map<string, IntakeRecord>()
  private sequence = 0
  constructor(private readonly now: () => number = Date.now) {}
  create(input: Omit<IntakeRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'notes'>) {
    const id = `${input.type === 'submission' ? '投稿' : input.type === 'feedback' ? '反馈' : '建议'}#${++this.sequence}`
    const time = this.now()
    const record: IntakeRecord = { ...input, id, createdAt: time, updatedAt: time, status: initialStatus[input.type], notes: [] }
    this.records.set(id, record)
    return record
  }
  get(id: string) { return this.records.get(id) }
  list(type?: IntakeType) { return [...this.records.values()].filter((r) => !type || r.type === type).sort((a, b) => b.createdAt - a.createdAt) }
  updateStatus(id: string, status: IntakeStatus) {
    const record = this.records.get(id)
    if (!record) throw new Error('记录不存在')
    if (!canTransition(record.type, record.status, status)) throw new Error(`不允许从 ${record.status} 变更为 ${status}`)
    record.status = status; record.updatedAt = this.now(); return record
  }
  addNote(id: string, note: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('记录不存在')
    record.notes.push(note); record.updatedAt = this.now(); return record
  }
}

export class IntakeService {
  constructor(private readonly ctx: Context, private readonly now: () => Date = () => new Date()) {}
  async create(input: Omit<IntakeRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'notes'>) {
    const prefix = input.type === 'submission' ? '投稿' : input.type === 'feedback' ? '反馈' : '建议'
    const rows = await this.ctx.model.get('intakeSequence', { type: input.type }) as unknown as Array<{ type: IntakeType; value: number }>
    const sequence = (rows[0]?.value ?? 0) + 1
    if (rows[0]) await this.ctx.model.set('intakeSequence', { type: input.type }, { value: sequence })
    else await this.ctx.model.create('intakeSequence', { type: input.type, value: sequence })
    const id = `${prefix}#${sequence}`
    const date = this.now()
    await this.ctx.model.create('intake', { ...input, id, createdAt: date, updatedAt: date, status: initialStatus[input.type], attachments: JSON.stringify(input.attachments), notes: '[]' })
    return this.get(id) as Promise<IntakeRecord>
  }
  async get(id: string) {
    const rows = await this.ctx.model.get('intake', { id }) as unknown as Array<Record<string, unknown>>
    return rows[0] && deserialize(rows[0])
  }
  async list(type?: IntakeType) {
    const rows = await this.ctx.model.get('intake', type ? { type } : {}) as unknown as Array<Record<string, unknown>>
    return rows.map(deserialize).sort((a, b) => b.createdAt - a.createdAt)
  }
  async listFor(submitterId: string) {
    const rows = await this.ctx.model.get('intake', { submitterId }) as unknown as Array<Record<string, unknown>>
    return rows.map(deserialize).sort((a, b) => b.createdAt - a.createdAt)
  }
  async updateStatus(id: string, status: IntakeStatus) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    if (!canTransition(record.type, record.status, status)) throw new Error(`不允许从 ${record.status} 变更为 ${status}`)
    const updatedAt = this.now()
    await this.ctx.model.set('intake', { id }, { status, updatedAt })
    return { ...record, status, updatedAt: updatedAt.getTime() }
  }
  async addNote(id: string, note: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    const notes = [...record.notes, note]
    const updatedAt = this.now()
    await this.ctx.model.set('intake', { id }, { notes: JSON.stringify(notes), updatedAt })
    return { ...record, notes, updatedAt: updatedAt.getTime() }
  }
}

const draftLifetime = 30 * 60 * 1000

export class IntakeAttachmentStore {
  constructor(readonly root: string) {}
  async copy(attachment: Attachment, draft: Pick<IntakeDraft, 'submitterId' | 'sourceSession'>): Promise<Attachment> {
    if (!attachment.url) throw new Error('附件缺少可下载地址。')
    const response = await fetch(attachment.url)
    if (!response.ok) throw new Error(`附件下载失败：${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    const checksum = createHash('sha256').update(data).digest('hex')
    let sourceName = attachment.name || 'attachment'
    try { sourceName = attachment.name || basename(new URL(attachment.url).pathname) || 'attachment' } catch { /* keep fallback */ }
    const safeName = sourceName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment'
    const scope = createHash('sha256').update(`${draft.submitterId}\0${draft.sourceSession}`).digest('hex').slice(0, 16)
    const relativePath = `${scope}/${Date.now()}-${checksum.slice(0, 12)}-${safeName}`
    await mkdir(join(this.root, scope), { recursive: true })
    await writeFile(join(this.root, relativePath), data)
    return { name: attachment.name, type: attachment.type, relativePath, size: data.byteLength, checksum }
  }
}

function deserializeDraft(row: Record<string, unknown>): IntakeDraft {
  return { ...row, messages: JSON.parse(String(row.messages || '[]')), updatedAt: new Date(row.updatedAt as string | number).getTime() } as IntakeDraft
}

export function countDraft(draft: Pick<IntakeDraft, 'messages'>): DraftCounts {
  return draft.messages.reduce((counts, message) => {
    counts.messages += 1
    counts.images += message.attachments.filter(item => item.type === 'img').length
    counts.attachments += message.attachments.filter(item => item.type !== 'img').length
    return counts
  }, { messages: 0, images: 0, attachments: 0 })
}

export class IntakeDraftService {
  constructor(
    private readonly ctx: Context,
    private readonly records: IntakeService,
    private readonly attachments: IntakeAttachmentStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async get(userId: string, sourceSession: string): Promise<IntakeDraft | undefined> {
    const key = draftKey(userId, sourceSession)
    const rows = await this.ctx.model.get('intakeDraft', { key }) as unknown as Array<Record<string, unknown>>
    if (!rows[0]) return undefined
    const draft = deserializeDraft(rows[0])
    if (this.now().getTime() - draft.updatedAt < draftLifetime) return draft
    await this.ctx.model.remove('intakeDraft', { key })
    return undefined
  }
  async start(type: IntakeType, userId: string, sourceSession: string): Promise<IntakeDraft> {
    if (await this.get(userId, sourceSession)) throw new Error('当前会话已有草稿，请先发送“提交”或“取消”。')
    const draft: IntakeDraft = { key: draftKey(userId, sourceSession), type, submitterId: userId, sourceSession, messages: [], updatedAt: this.now().getTime() }
    await this.ctx.model.create('intakeDraft', { ...draft, messages: '[]', updatedAt: new Date(draft.updatedAt) })
    return draft
  }
  async append(userId: string, sourceSession: string, body: string, incoming: Attachment[]): Promise<DraftCounts> {
    const draft = await this.get(userId, sourceSession)
    if (!draft) throw new Error('草稿不存在或已过期，请重新开始。')
    const stored: Attachment[] = []
    for (const attachment of incoming) stored.push(await this.attachments.copy(attachment, draft))
    const message: DraftMessage = { body: body.trim(), attachments: stored, createdAt: this.now().getTime() }
    draft.messages.push(message)
    draft.updatedAt = message.createdAt
    await this.ctx.model.set('intakeDraft', { key: draft.key }, { messages: JSON.stringify(draft.messages), updatedAt: new Date(draft.updatedAt) })
    return countDraft(draft)
  }
  async cancel(userId: string, sourceSession: string) {
    const draft = await this.get(userId, sourceSession)
    if (!draft) return false
    await this.ctx.model.remove('intakeDraft', { key: draft.key })
    return true
  }
  async submit(userId: string, sourceSession: string): Promise<IntakeRecord> {
    const draft = await this.get(userId, sourceSession)
    if (!draft) throw new Error('草稿不存在或已过期，请重新开始。')
    if (!draft.messages.length) throw new Error('草稿还是空的，请先发送内容。')
    const record = await this.records.create({
      type: draft.type,
      submitterId: draft.submitterId,
      sourceSession: draft.sourceSession,
      body: draft.messages.map(item => item.body).filter(Boolean).join('\n\n'),
      attachments: draft.messages.flatMap(item => item.attachments),
    })
    await this.ctx.model.remove('intakeDraft', { key: draft.key })
    return record
  }
}

function extractAttachments(session: any): Attachment[] {
  return (session.elements || []).filter((element: any) => element.type === 'img' || element.type === 'audio' || element.type === 'video' || element.type === 'file').map((element: any) => ({ url: element.attrs?.src || element.attrs?.url || '', name: element.attrs?.title || element.attrs?.filename, type: element.type })).filter((item: Attachment) => item.url)
}

function deserialize(row: Record<string, unknown>): IntakeRecord {
  return { ...row, createdAt: new Date(row.createdAt as string | number).getTime(), updatedAt: new Date(row.updatedAt as string | number).getTime(), attachments: JSON.parse(String(row.attachments || '[]')), notes: JSON.parse(String(row.notes || '[]')) } as IntakeRecord
}

function formatRecord(record: IntakeRecord) {
  return `[${record.id}] ${record.type} ${record.status}\n提交者 QQ: ${record.submitterId}\n内容: ${record.body || '（仅附件）'}\n附件: ${record.attachments.length}\n时间: ${new Date(record.createdAt).toISOString()}${record.notes.length ? `\n备注: ${record.notes.join(' | ')}` : ''}`
}

function conversationId(session: any) {
  return session.cid || `${session.platform || 'qq'}:${session.guildId ? `group:${session.guildId}:${session.channelId || session.guildId}` : `private:${session.channelId || session.userId}`}`
}

function configuredTargets(target: TargetConfig): string[] {
  return [...(target.users || []).map(item => `qq:${item.qq}`), ...(target.groups || []).map(item => `qq:${item.qq}`)]
}

export function apply(ctx: Context, config: Config) {
  const inputConfig = config || {} as Config
  config = {
    targets: {
      submission: { users: [], groups: [], ...inputConfig.targets?.submission },
      feedback: { users: [], groups: [], ...inputConfig.targets?.feedback },
      suggestion: { users: [], groups: [], ...inputConfig.targets?.suggestion },
    },
    administrators: inputConfig.administrators || [],
    managementGroups: inputConfig.managementGroups || [],
    attachmentPath: inputConfig.attachmentPath || 'data/memebot-intake',
  }
  ctx.model.extend('intake', { id: 'string', type: 'string', submitterId: 'string', sourceSession: 'string', body: 'text', attachments: 'text', createdAt: 'timestamp', updatedAt: 'timestamp', status: 'string', notes: 'text' }, { primary: 'id' })
  ctx.model.extend('intakeDraft', { key: 'string', type: 'string', submitterId: 'string', sourceSession: 'string', messages: 'text', updatedAt: 'timestamp' }, { primary: 'key' })
  ctx.model.extend('intakeSequence', { type: 'string', value: 'unsigned' }, { primary: 'type' })
  const store = new IntakeService(ctx)
  const drafts = new IntakeDraftService(ctx, store, new IntakeAttachmentStore(config.attachmentPath))

  const notify = async (record: IntakeRecord) => {
    const targets = configuredTargets(config.targets[record.type])
    try {
      await ctx.broadcast(targets, formatRecord(record))
      return `已提交 ${record.id}，管理员通知已送达。`
    } catch {
      return `已提交 ${record.id}；记录已保存，但管理员通知暂时延迟。`
    }
  }
  const start = async (session: any, type: IntakeType) => {
    if (!configuredTargets(config.targets[type]).length) return '此类型尚未配置通知目标，暂时无法开始收集。'
    try {
      await drafts.start(type, session.userId, conversationId(session))
      return '已开始收集。请连续发送文字、图片或附件；单独发送“提交”完成，发送“取消”放弃。'
    } catch (error) { return (error as Error).message }
  }

  const root = ctx.command('intake [id:text]', '查看自己的受理记录；管理员可查看全部记录')
  root.action(async ({ session }, id) => {
    if (!session) return '无法识别当前用户。'
    const userId = session.userId || ''
    const administrator = isAdmin(session as any, config)
    if (id) {
      const record = await store.get(id)
      return record && (administrator || record.submitterId === userId) ? formatRecord(record) : '记录不存在或无权查看。'
    }
    const records = administrator ? await store.list() : await store.listFor(userId)
    return records.length ? records.map(record => `${record.id} ${record.status}`).join('\n') : '暂无记录。'
  })
  ctx.command('intake.submit', '开始收集投稿').alias('submit').action(({ session }) => start(session, 'submission'))
  ctx.command('intake.feedback', '开始收集反馈').alias('feedback').action(({ session }) => start(session, 'feedback'))
  ctx.command('intake.suggest', '开始收集建议').alias('suggest').action(({ session }) => start(session, 'suggestion'))

  ctx.middleware(async (session, next) => {
    const userId = session.userId || ''
    const source = conversationId(session)
    if (!await drafts.get(userId, source)) return next()
    const content = (session.content || '').trim()
    if (content === '取消') return await drafts.cancel(userId, source) ? '草稿已取消。' : '草稿不存在或已过期。'
    if (content === '提交') {
      try { return await notify(await drafts.submit(userId, source)) } catch (error) { return (error as Error).message }
    }
    const attachments = extractAttachments(session)
    if (!content && !attachments.length) return '没有收到可保存的文字或附件。'
    try {
      const counts = await drafts.append(userId, source, content, attachments)
      return `已收集：${counts.messages} 条消息，${counts.images} 张图片，${counts.attachments} 个其他附件。`
    } catch (error) { return (error as Error).message }
  })

  const admin = (name: string, action: (session: any, ...args: string[]) => any) => ctx.command(name).action(({ session }, ...args) => {
    if (!session || !isAdmin(session as any, config)) return '没有权限。'
    return action(session, ...(args as string[]))
  })
  admin('intake.admin.list [type]', async (_s, type) => (await store.list(type as IntakeType | undefined)).map(formatRecord).join('\n\n') || '暂无记录。')
  admin('intake.admin.get <id>', async (_s, id) => { const r = await store.get(id); return r ? formatRecord(r) : '记录不存在。' })
  admin('intake.admin.status <id> <status>', async (_s, id, status) => { try { const record = await store.updateStatus(id, status as IntakeStatus); await ctx.broadcast([`qq:${record.submitterId}`], `受理 ${record.id} 状态已更新为：${record.status}`); return formatRecord(record) } catch (e) { return (e as Error).message } })
  admin('intake.admin.note <id> <note:text>', async (_s, id, note) => { try { return formatRecord(await store.addNote(id, note)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.close <id>', async (_s, id) => { try { const record = await store.updateStatus(id, 'closed'); await ctx.broadcast([`qq:${record.submitterId}`], `受理 ${record.id} 已关闭`); return formatRecord(record) } catch (e) { return (e as Error).message } })
  admin('intake.admin.reopen <id>', async (_s, id) => { const r = await store.get(id); if (!r) return '记录不存在。'; const status = r.type === 'feedback' ? 'pending' : 'pending-review'; try { const record = await store.updateStatus(id, status); await ctx.broadcast([`qq:${record.submitterId}`], `受理 ${record.id} 已重新打开`); return formatRecord(record) } catch (e) { return (e as Error).message } })
  ;(ctx as any).intake = store
  ;(ctx as any).intakeDrafts = drafts
}

export default { name, inject, Config, apply }
