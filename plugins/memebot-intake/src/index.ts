import { Context, Schema } from 'koishi'

export const name = 'memebot-intake'

export type IntakeType = 'submission' | 'feedback' | 'suggestion'
export type IntakeStatus =
  | 'pending-review' | 'approved' | 'rejected'
  | 'pending' | 'processing' | 'resolved' | 'closed'
  | 'accepted' | 'declined'

export interface Attachment { name?: string; url: string; type?: string }
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
  }
}

export interface TargetConfig { users?: string[]; groups?: string[] }
export interface Config {
  targets: { submission: TargetConfig; feedback: TargetConfig; suggestion: TargetConfig }
  adminUsers: string[]
  adminGroups: string[]
}

export const Config: Schema<Config> = Schema.object({
  targets: Schema.object({
    submission: Schema.object({ users: Schema.array(String).default([]), groups: Schema.array(String).default([]) }).default({ users: [], groups: [] }),
    feedback: Schema.object({ users: Schema.array(String).default([]), groups: Schema.array(String).default([]) }).default({ users: [], groups: [] }),
    suggestion: Schema.object({ users: Schema.array(String).default([]), groups: Schema.array(String).default([]) }).default({ users: [], groups: [] }),
  }).default({ submission: { users: [], groups: [] }, feedback: { users: [], groups: [] }, suggestion: { users: [], groups: [] } }),
  adminUsers: Schema.array(String).default([]),
  adminGroups: Schema.array(String).default([]),
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
  return (session.user?.authority ?? 0) >= 4 || (!!session.userId && config.adminUsers.includes(session.userId)) || (!!session.guildId && config.adminGroups.includes(session.guildId))
}

export class IntakeStore {
  private records = new Map<string, IntakeRecord>()
  private sequence = 0
  constructor(private readonly now: () => number = Date.now) {}
  create(input: Omit<IntakeRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'notes'>) {
    const id = `${input.type === 'submission' ? 'SUB' : input.type === 'feedback' ? 'FDB' : 'SUG'}-${String(++this.sequence).padStart(6, '0')}`
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
    const prefix = input.type === 'submission' ? 'SUB' : input.type === 'feedback' ? 'FDB' : 'SUG'
    const existing = await this.ctx.model.get('intake', { type: input.type }) as unknown as Array<{ id: string }>
    const sequence = existing.reduce((max, row) => Math.max(max, Number(row.id.split('-').pop()) || 0), 0) + 1
    const id = `${prefix}-${String(sequence).padStart(6, '0')}`
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

function extractAttachments(session: any): Attachment[] {
  return (session.elements || []).filter((element: any) => element.type === 'img' || element.type === 'audio' || element.type === 'video' || element.type === 'file').map((element: any) => ({ url: element.attrs?.src || element.attrs?.url || '', name: element.attrs?.title || element.attrs?.filename, type: element.type })).filter((item: Attachment) => item.url)
}

function deserialize(row: Record<string, unknown>): IntakeRecord {
  return { ...row, createdAt: new Date(row.createdAt as string | number).getTime(), updatedAt: new Date(row.updatedAt as string | number).getTime(), attachments: JSON.parse(String(row.attachments || '[]')), notes: JSON.parse(String(row.notes || '[]')) } as IntakeRecord
}

function formatRecord(record: IntakeRecord) {
  return `[${record.id}] ${record.type} ${record.status}\n提交者: ${record.submitterId}\n内容: ${record.body}\n时间: ${new Date(record.createdAt).toISOString()}${record.notes.length ? `\n备注: ${record.notes.join(' | ')}` : ''}`
}

export function apply(ctx: Context, config: Config) {
  const inputConfig = config || {} as Config
  config = { targets: { submission: { users: [], groups: [], ...inputConfig.targets?.submission }, feedback: { users: [], groups: [], ...inputConfig.targets?.feedback }, suggestion: { users: [], groups: [], ...inputConfig.targets?.suggestion } }, adminUsers: inputConfig.adminUsers || [], adminGroups: inputConfig.adminGroups || [] }
  ctx.model.extend('intake', { id: 'string', type: 'string', submitterId: 'string', sourceSession: 'string', body: 'text', attachments: 'text', createdAt: 'timestamp', updatedAt: 'timestamp', status: 'string', notes: 'text' })
  const store = new IntakeService(ctx)
  const submit = async (session: any, type: IntakeType, body?: string) => {
    const text = (body || session.content || '').trim()
    if (!text) return '请提供受理内容。'
    const record = await store.create({ type, submitterId: session.userId, sourceSession: session.cid || session.channelId || (session.guildId ? `group:${session.guildId}` : `dm:${session.userId}`), body: text, attachments: extractAttachments(session) })
    await session.send?.(`已受理 ${record.id}，当前状态：${record.status}。`)
    const target = config.targets[type]
    const targets = [...(target.users || []).map((id) => `qq:${id}`), ...(target.groups || []).map((id) => `qq:${id}`)]
    if (targets.length) await ctx.broadcast(targets, formatRecord(record))
    return undefined
  }
  ctx.command('intake.submit <body:text>', '提交内容').action(({ session }, body) => submit(session, 'submission', body))
  ctx.command('intake.feedback <body:text>', '提交反馈工单').action(({ session }, body) => submit(session, 'feedback', body))
  ctx.command('intake.suggest <body:text>', '提交建议').action(({ session }, body) => submit(session, 'suggestion', body))

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
}

export default { name, Config, apply }
