import { createHash } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, h, Schema } from 'koishi'

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
export interface IntakeAuditEvent {
  action: 'claim' | 'transfer' | 'clear-assignment' | 'status' | 'close' | 'reopen' | 'acceptance-notified'
  actorId?: string
  from?: string
  to?: string
  at: number
}
export interface IntakeRecord {
  id: string
  type: IntakeType
  submitterId: string
  sourceSession: string
  body: string
  messages?: DraftMessage[]
  attachments: Attachment[]
  createdAt: number
  updatedAt: number
  status: IntakeStatus
  notes: string[]
  active: boolean
  assigneeId?: string
  acceptanceNotified: boolean
  closedAt?: number
  audit: IntakeAuditEvent[]
}

type IntakeCreateInput = Omit<IntakeRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'notes' | 'active' | 'assigneeId' | 'acceptanceNotified' | 'closedAt' | 'audit'>

declare module 'koishi' {
  interface Tables {
    intake: {
      id: string
      type: IntakeType
      submitterId: string
      sourceSession: string
      body: string
      messages: string
      attachments: string
      createdAt: Date
      updatedAt: Date
      status: IntakeStatus
      notes: string
      active: boolean
      assigneeId: string
      acceptanceNotified: boolean
      closedAt: Date | null
      audit: string
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
    intakeOutbox: {
      id: string
      recordId: string
      submitterId: string
      target: string
      record: string
      summaryMessageId: string
      forwardMessageId: string
      state: 'pending' | 'delivered'
      attempts: number
      nextAttemptAt: Date
      delayedReported: boolean
      eventualReported: boolean
    }
    intakeMessageMap: { messageId: string; recordId: string }
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
  suggestion: { 'pending-review': ['processing', 'accepted', 'declined'], accepted: ['pending-review'], declined: ['pending-review'], closed: ['pending-review'], pending: [], processing: ['accepted', 'declined'], resolved: [], approved: [], rejected: [] },
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
  create(input: IntakeCreateInput) {
    const id = `${input.type === 'submission' ? '投稿' : input.type === 'feedback' ? '反馈' : '建议'}#${++this.sequence}`
    const time = this.now()
    const record: IntakeRecord = { ...input, id, createdAt: time, updatedAt: time, status: initialStatus[input.type], notes: [], active: true, acceptanceNotified: false, audit: [] }
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
  private readonly claimLocks = new Map<string, Promise<void>>()
  constructor(private readonly ctx: Context, private readonly now: () => Date = () => new Date()) {}
  async create(input: IntakeCreateInput) {
    const prefix = input.type === 'submission' ? '投稿' : input.type === 'feedback' ? '反馈' : '建议'
    const rows = await this.ctx.model.get('intakeSequence', { type: input.type }) as unknown as Array<{ type: IntakeType; value: number }>
    const sequence = (rows[0]?.value ?? 0) + 1
    if (rows[0]) await this.ctx.model.set('intakeSequence', { type: input.type }, { value: sequence })
    else await this.ctx.model.create('intakeSequence', { type: input.type, value: sequence })
    const id = `${prefix}#${sequence}`
    const date = this.now()
    await this.ctx.model.create('intake', {
      ...input, id, createdAt: date, updatedAt: date, status: initialStatus[input.type], messages: JSON.stringify(input.messages || []), attachments: JSON.stringify(input.attachments), notes: '[]',
      active: true, assigneeId: '', acceptanceNotified: false, closedAt: null, audit: '[]',
    })
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
  async listActive(type?: IntakeType) { return (await this.list(type)).filter(record => record.active) }
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
  private async mutate(id: string, patch: Partial<IntakeRecord>, event: Omit<IntakeAuditEvent, 'at'>) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    const at = this.now()
    const audit = [...record.audit, { ...event, at: at.getTime() }]
    const persisted: Record<string, unknown> = { ...patch, audit: JSON.stringify(audit), updatedAt: at }
    if ('closedAt' in patch) persisted.closedAt = patch.closedAt == null ? null : new Date(patch.closedAt)
    if ('assigneeId' in patch) persisted.assigneeId = patch.assigneeId ?? ''
    await this.ctx.model.set('intake', { id }, persisted)
    return { ...record, ...patch, audit, updatedAt: at.getTime() }
  }
  async claim(id: string, assigneeId: string) {
    const previous = this.claimLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.claimLocks.set(id, tail)
    await previous
    try {
      const record = await this.get(id)
      if (!record) throw new Error('记录不存在')
      if (record.assigneeId) return record
      const status = record.type === 'feedback' || record.type === 'suggestion' ? 'processing' : record.status
      return await this.mutate(id, { assigneeId, status }, { action: 'claim', actorId: assigneeId, to: assigneeId })
    } finally {
      release()
      if (this.claimLocks.get(id) === tail) this.claimLocks.delete(id)
    }
  }
  async transfer(id: string, assigneeId: string, actorId: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    return this.mutate(id, { assigneeId }, { action: 'transfer', actorId, from: record.assigneeId, to: assigneeId })
  }
  async clearAssignment(id: string, actorId: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    return this.mutate(id, { assigneeId: undefined }, { action: 'clear-assignment', actorId, from: record.assigneeId })
  }
  async markAcceptanceNotified(id: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    if (record.acceptanceNotified) return record
    return this.mutate(id, { acceptanceNotified: true }, { action: 'acceptance-notified' })
  }
  async reserveAcceptanceNotice(id: string) {
    const previous = this.claimLocks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.claimLocks.set(id, tail)
    await previous
    try {
      const record = await this.get(id)
      if (!record || record.acceptanceNotified) return false
      await this.mutate(id, { acceptanceNotified: true }, { action: 'acceptance-notified' })
      return true
    } finally {
      release()
      if (this.claimLocks.get(id) === tail) this.claimLocks.delete(id)
    }
  }
  async setHandlingStatus(id: string, status: IntakeStatus, actorId: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    if (!canTransition(record.type, record.status, status)) throw new Error(`不允许从 ${record.status} 变更为 ${status}`)
    return this.mutate(id, { status }, { action: 'status', actorId, from: record.status, to: status })
  }
  async close(id: string, actorId: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    if (!record.active) return record
    return this.mutate(id, { active: false, closedAt: this.now().getTime() }, { action: 'close', actorId })
  }
  async reopen(id: string, actorId: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    if (record.active) return record
    return this.mutate(id, { active: true, closedAt: undefined }, { action: 'reopen', actorId })
  }
  async clearAttachments(id: string) {
    const record = await this.get(id)
    if (!record) throw new Error('记录不存在')
    await this.ctx.model.set('intake', { id }, { attachments: '[]', updatedAt: this.now() })
    return { ...record, attachments: [] }
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
  async remove(attachment: Attachment) {
    if (!attachment.relativePath) return
    const root = resolve(this.root)
    const target = resolve(root, attachment.relativePath)
    if (target !== root && !target.startsWith(root + sep)) throw new Error('附件路径不安全')
    await unlink(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  }
}

export class IntakeRetentionService {
  constructor(private readonly records: IntakeService, private readonly attachments: Pick<IntakeAttachmentStore, 'remove'>, private readonly now: () => Date = () => new Date()) {}
  async run() {
    const cutoff = this.now().getTime() - 90 * 24 * 60 * 60 * 1000
    for (const record of await this.records.list()) {
      if (record.active || !record.closedAt || record.closedAt > cutoff || !record.attachments.length) continue
      for (const attachment of record.attachments) await this.attachments.remove(attachment)
      await this.records.clearAttachments(record.id)
    }
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
      messages: draft.messages,
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
  return {
    ...row,
    createdAt: new Date(row.createdAt as string | number).getTime(),
    updatedAt: new Date(row.updatedAt as string | number).getTime(),
    closedAt: row.closedAt ? new Date(row.closedAt as string | number).getTime() : undefined,
    attachments: JSON.parse(String(row.attachments || '[]')),
    messages: JSON.parse(String(row.messages || '[]')),
    notes: JSON.parse(String(row.notes || '[]')),
    active: row.active == null ? true : Boolean(row.active),
    assigneeId: String(row.assigneeId || '') || undefined,
    acceptanceNotified: Boolean(row.acceptanceNotified),
    audit: JSON.parse(String(row.audit || '[]')),
  } as IntakeRecord
}

export function formatRecord(record: IntakeRecord) {
  return `[${record.id}] ${record.type} ${record.status}${record.active ? '' : '（已关闭）'}\n提交者 QQ: ${record.submitterId}\n内容: ${record.body || '（仅附件）'}\n附件: ${record.attachments.length}\n时间: ${new Date(record.createdAt).toISOString()}${record.assigneeId ? `\n认领人 QQ: ${record.assigneeId}` : ''}${record.notes.length ? `\n备注: ${record.notes.join(' | ')}` : ''}`
}

export function formatManagementSummary(record: IntakeRecord) {
  return `[${record.id}] ${record.type} ${record.status}\n提交者 QQ: ${record.submitterId}\n提交时间: ${new Date(record.createdAt).toISOString()}\n请引用本消息并发送“认领”`
}

export interface IntakeNotificationTransport {
  sendSummary(target: string, content: string): Promise<string>
  sendForward(target: string, record: IntakeRecord): Promise<string>
  notifySubmitter(userId: string, content: string): Promise<void>
}

interface IntakeOutboxRow {
  id: string
  recordId: string
  submitterId: string
  target: string
  record: string
  summaryMessageId: string
  forwardMessageId: string
  state: 'pending' | 'delivered'
  attempts: number
  nextAttemptAt: Date
  delayedReported: boolean
  eventualReported: boolean
}

const retryDelays = [60_000, 5 * 60_000, 30 * 60_000]
function retryDelay(attempts: number) { return attempts <= retryDelays.length ? retryDelays[attempts - 1] : 6 * 60 * 60_000 }

export class IntakeNotificationOutbox {
  constructor(private readonly ctx: Context, private readonly transport: IntakeNotificationTransport, private readonly now: () => Date = () => new Date()) {}
  async enqueueAndDeliver(record: IntakeRecord, targets: string[]) {
    for (const target of targets) {
      const id = createHash('sha256').update(`${record.id}\0${target}`).digest('hex')
      const existing = await this.ctx.model.get('intakeOutbox', { id }) as unknown as IntakeOutboxRow[]
      if (!existing[0]) await this.ctx.model.create('intakeOutbox', {
        id, recordId: record.id, submitterId: record.submitterId, target, record: JSON.stringify(record),
        summaryMessageId: '', forwardMessageId: '', state: 'pending', attempts: 0, nextAttemptAt: this.now(), delayedReported: false, eventualReported: false,
      })
    }
    const rows = await this.rowsFor(record.id)
    for (const row of rows) await this.deliver(row)
    const refreshed = await this.rowsFor(record.id)
    return { delivered: refreshed.length > 0 && refreshed.every(row => row.state === 'delivered') }
  }
  async retryDue() {
    const rows = await this.ctx.model.get('intakeOutbox', { state: 'pending' }) as unknown as IntakeOutboxRow[]
    for (const row of rows) if (new Date(row.nextAttemptAt).getTime() <= this.now().getTime()) await this.deliver(row)
  }
  async resolveMessage(messageId: string) {
    const rows = await this.ctx.model.get('intakeMessageMap', { messageId }) as unknown as Array<{ recordId: string }>
    return rows[0]?.recordId
  }
  private async rowsFor(recordId: string) {
    return await this.ctx.model.get('intakeOutbox', { recordId }) as unknown as IntakeOutboxRow[]
  }
  private async map(messageId: string, recordId: string) {
    const existing = await this.ctx.model.get('intakeMessageMap', { messageId }) as unknown as Array<{ messageId: string }>
    if (!existing[0]) await this.ctx.model.create('intakeMessageMap', { messageId, recordId })
  }
  private async deliver(row: IntakeOutboxRow) {
    if (row.state === 'delivered') return
    const record = JSON.parse(row.record) as IntakeRecord
    let summaryMessageId = row.summaryMessageId
    let forwardMessageId = row.forwardMessageId
    try {
      if (!summaryMessageId) {
        summaryMessageId = await this.transport.sendSummary(row.target, formatManagementSummary(record))
        await this.map(summaryMessageId, row.recordId)
        await this.ctx.model.set('intakeOutbox', { id: row.id }, { summaryMessageId })
      }
      if (!forwardMessageId) {
        forwardMessageId = await this.transport.sendForward(row.target, record)
        await this.map(forwardMessageId, row.recordId)
        await this.ctx.model.set('intakeOutbox', { id: row.id }, { forwardMessageId })
      }
      await this.ctx.model.set('intakeOutbox', { id: row.id }, { state: 'delivered' })
      const siblings = await this.rowsFor(row.recordId)
      if (siblings.every(item => item.state === 'delivered') && siblings.some(item => item.attempts > 0) && !siblings.some(item => item.eventualReported)) {
        await this.transport.notifySubmitter(row.submitterId, `${row.recordId} 的管理员通知现已送达。`)
        for (const sibling of siblings) await this.ctx.model.set('intakeOutbox', { id: sibling.id }, { eventualReported: true })
      }
    } catch (error) {
      const siblings = await this.rowsFor(row.recordId)
      const shouldReportDelay = !siblings.some(item => item.delayedReported)
      const attempts = row.attempts + 1
      const nextAttemptAt = new Date(this.now().getTime() + retryDelay(attempts))
      await this.ctx.model.set('intakeOutbox', { id: row.id }, { attempts, nextAttemptAt, delayedReported: true })
      if (shouldReportDelay) await this.transport.notifySubmitter(row.submitterId, `${row.recordId} 已保存，但管理员通知暂时延迟，将自动重试。`)
    }
  }
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
  ctx.model.extend('intake', {
    id: 'string', type: 'string', submitterId: 'string', sourceSession: 'string', body: 'text', messages: 'text', attachments: 'text', createdAt: 'timestamp', updatedAt: 'timestamp', status: 'string', notes: 'text',
    active: 'boolean', assigneeId: 'string', acceptanceNotified: 'boolean', closedAt: 'timestamp', audit: 'text',
  }, { primary: 'id' })
  ctx.model.extend('intakeDraft', { key: 'string', type: 'string', submitterId: 'string', sourceSession: 'string', messages: 'text', updatedAt: 'timestamp' }, { primary: 'key' })
  ctx.model.extend('intakeSequence', { type: 'string', value: 'unsigned' }, { primary: 'type' })
  ctx.model.extend('intakeOutbox', {
    id: 'string', recordId: 'string', submitterId: 'string', target: 'string', record: 'text', summaryMessageId: 'string', forwardMessageId: 'string', state: 'string', attempts: 'unsigned', nextAttemptAt: 'timestamp', delayedReported: 'boolean', eventualReported: 'boolean',
  }, { primary: 'id' })
  ctx.model.extend('intakeMessageMap', { messageId: 'string', recordId: 'string' }, { primary: 'messageId' })
  const store = new IntakeService(ctx)
  const attachmentStore = new IntakeAttachmentStore(config.attachmentPath)
  const drafts = new IntakeDraftService(ctx, store, attachmentStore)

  const messageId = (result: unknown) => {
    const value = Array.isArray(result) ? result[0] : result
    const id = typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as any).id || (value as any).messageId || '') : ''
    if (!id) throw new Error('QQ 平台未返回消息 ID')
    return id
  }
  const transport: IntakeNotificationTransport = {
    async sendSummary(target, content) { return messageId(await ctx.broadcast([target], content)) },
    async sendForward(target, record) {
      const nodes: any[] = []
      const messages = record.messages?.length ? record.messages : [{ body: record.body, attachments: record.attachments, createdAt: record.createdAt }]
      for (const message of messages) {
        if (message.body) nodes.push(h('message', {}, message.body))
        for (const attachment of message.attachments) {
          if (!attachment.relativePath) continue
          const url = pathToFileURL(resolve(config.attachmentPath, attachment.relativePath)).href
          nodes.push(h('message', {}, attachment.type === 'img' ? h.image(url) : h.file(url, { filename: attachment.name || basename(attachment.relativePath) })))
        }
      }
      return messageId(await ctx.broadcast([target], h('message', { forward: true }, nodes)))
    },
    async notifySubmitter(userId, content) { await ctx.broadcast([`qq:${userId}`], content) },
  }
  const outbox = new IntakeNotificationOutbox(ctx, transport)
  const retention = new IntakeRetentionService(store, attachmentStore)

  const notify = async (record: IntakeRecord) => {
    const targets = configuredTargets(config.targets[record.type])
    const result = await outbox.enqueueAndDeliver(record, targets)
    return result.delivered ? `已提交 ${record.id}，管理员通知已送达。` : `已提交 ${record.id}；记录已保存，但管理员通知暂时延迟。`
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
    const quoteId = (session as any).quote?.id || (session as any).quote?.messageId
    const quotedRecordId = quoteId && await outbox.resolveMessage(String(quoteId))
    if (quotedRecordId) {
      if (!isAdmin(session as any, config)) return '没有权限。'
      const action = (session.content || '').trim()
      const current = await store.get(quotedRecordId)
      if (!current) return '记录不存在。'
      try {
        if (action === '认领') {
          const claimed = await store.claim(current.id, userId)
          if (claimed.assigneeId !== userId) return `${claimed.id} 已由 ${claimed.assigneeId} 认领。`
          if (await store.reserveAcceptanceNotice(claimed.id)) await transport.notifySubmitter(claimed.submitterId, `${claimed.id} 已由管理员 ${userId} 认领；管理员将通过 QQ 直接联系你。`)
          return `已认领 ${claimed.id}。`
        }
        const transfer = /^转交\s+(\d+)$/.exec(action)
        if (transfer) return formatRecord(await store.transfer(current.id, transfer[1], userId))
        if (action === '取消认领') return formatRecord(await store.clearAssignment(current.id, userId))
        if (action === '关闭') return formatRecord(await store.close(current.id, userId))
        if (action === '重开') return formatRecord(await store.reopen(current.id, userId))
        const statusByAction: Partial<Record<IntakeType, Record<string, IntakeStatus>>> = {
          feedback: { 处理中: 'processing', 已解决: 'resolved' },
          submission: { 通过: 'approved', 拒绝: 'rejected' },
          suggestion: { 接受: 'accepted', 拒绝: 'declined' },
        }
        const status = statusByAction[current.type]?.[action]
        if (status) return formatRecord(await store.setHandlingStatus(current.id, status, userId))
        return '未知管理动作。请使用：认领、转交 QQ、取消认领、关闭、重开，或该类型的状态关键词。'
      } catch (error) { return (error as Error).message }
    }
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
  admin('intake.admin.list [type]', async (_s, type) => (await store.listActive(type as IntakeType | undefined)).map(formatRecord).join('\n\n') || '暂无记录。')
  admin('intake.admin.get <id>', async (_s, id) => { const r = await store.get(id); return r ? formatRecord(r) : '记录不存在。' })
  admin('intake.admin.status <id> <status>', async (s, id, status) => { try { return formatRecord(await store.setHandlingStatus(id, status as IntakeStatus, s.userId)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.note <id> <note:text>', async (_s, id, note) => { try { return formatRecord(await store.addNote(id, note)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.claim <id>', async (s, id) => { try { return formatRecord(await store.claim(id, s.userId)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.transfer <id> <qq>', async (s, id, qq) => { try { return formatRecord(await store.transfer(id, qq, s.userId)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.unassign <id>', async (s, id) => { try { return formatRecord(await store.clearAssignment(id, s.userId)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.close <id>', async (s, id) => { try { return formatRecord(await store.close(id, s.userId)) } catch (e) { return (e as Error).message } })
  admin('intake.admin.reopen <id>', async (s, id) => { try { return formatRecord(await store.reopen(id, s.userId)) } catch (e) { return (e as Error).message } })
  ctx.setInterval(() => { void outbox.retryDue() }, 60_000)
  ctx.setInterval(() => { void retention.run() }, 24 * 60 * 60_000)
  ctx.on('ready', () => { void outbox.retryDue(); void retention.run() })
  ;(ctx as any).intake = store
  ;(ctx as any).intakeDrafts = drafts
  ;(ctx as any).intakeOutbox = outbox
}

export default { name, inject, Config, apply }
