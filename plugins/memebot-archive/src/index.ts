import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Context, h, Schema } from 'koishi'
import { ArchivePreflight, BackupContext, BackupStatusSink, PersistentArchiveBackupQueue, WorkPreviewStore } from './extensions'
import { S3R2Store } from './s3'

export { ArchivePreflight, PersistentArchiveBackupQueue, WorkPreviewStore } from './extensions'

export const name = 'memebot-archive'
export const inject = ['database', 'console']

export interface Config {
  administrators: Array<{ qq: string }>
  managementGroups: Array<{ qq: string }>
  localPath: string
  paperMaxMb: number
  workMaxMb: number
  r2: {
    enabled: boolean
    accountId: string
    bucketName: string
    accessKeyId: string
    secretAccessKey: string
    objectPrefix: string
  }
}

const qqTable = () => Schema.array(Schema.object({ qq: Schema.string().description('QQ 号') }))

export const Config: Schema<Config> = Schema.object({
  administrators: qqTable().default([]).description('显式授权的管理员 QQ'),
  managementGroups: qqTable().default([]).description('允许执行管理动作的 QQ 群'),
  localPath: Schema.string().default('data/memebot-archive').description('附件本地存储目录'),
  paperMaxMb: Schema.number().default(100).min(1).description('Paper PDF 最大大小（MB）'),
  workMaxMb: Schema.number().default(500).min(1).description('Work ZIP 最大大小（MB）'),
  r2: Schema.object({
    enabled: Schema.boolean().default(false),
    accountId: Schema.string().default(''),
    bucketName: Schema.string().default(''),
    accessKeyId: Schema.string().default(''),
    secretAccessKey: Schema.string().role('secret').default(''),
    objectPrefix: Schema.string().default('memebot-archive'),
  }).default({ enabled: false, accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '', objectPrefix: 'memebot-archive' }),
})

export interface Attachment {
  relativePath: string
  contentType: string
  size: number
  checksum: string
  r2?: { objectKey: string; syncState: 'synced' | 'pending' | 'failed'; lastAttempt?: string; error?: string }
}

export interface NewspaperIssue {
  id: string
  issueNumber: string
  month: string
  title: string
  description?: string
  sourceLink?: string
  attachment?: Attachment
  publishedAt: Date
  updatedAt?: Date
  lifecycle?: 'active' | 'removed'
  backupState?: 'disabled' | 'pending' | 'failed' | 'complete'
  backupError?: string
}

export interface Work {
  id: string
  title: string
  author: string
  description?: string
  attachment?: Attachment
  publishedAt: Date
  updatedAt?: Date
  lifecycle?: 'active' | 'removed'
  backupState?: 'disabled' | 'pending' | 'failed' | 'complete'
  backupError?: string
}

export interface ArchiveDatabase {
  issues: NewspaperIssue[]
  works: Work[]
}

declare module 'koishi' {
  interface Tables {
    archivePaper: {
      id: string
      issueNumber: string
      month: string
      title: string
      description: string
      sourceLink: string
      attachment: string
      lifecycle: 'active' | 'removed'
      backupState: 'disabled' | 'pending' | 'failed' | 'complete'
      backupError: string
      publishedAt: Date
      updatedAt: Date
    }
    archiveSequence: { kind: string; value: number }
    archiveWork: {
      id: string
      title: string
      author: string
      description: string
      attachment: string
      lifecycle: 'active' | 'removed'
      backupState: 'disabled' | 'pending' | 'failed' | 'complete'
      backupError: string
      publishedAt: Date
      updatedAt: Date
    }
    archiveBackupJob: {
      id: string
      recordKind: 'paper' | 'work'
      recordId: string
      attachment: string
      manifest: string
      state: 'pending' | 'failed' | 'complete'
      attempts: number
      nextAttemptAt: Date
      error: string
    }
  }
}

export interface ArchiveMetadataRepository {
  loadPapers(): Promise<NewspaperIssue[]>
  nextPaperId(): Promise<string>
  createPaper(paper: NewspaperIssue): Promise<void>
  updatePaper(paper: NewspaperIssue): Promise<void>
  loadWorks(): Promise<Work[]>
  nextWorkId(): Promise<string>
  createWork(work: Work): Promise<void>
  updateWork(work: Work): Promise<void>
  updateBackupState(kind: 'paper' | 'work', id: string, state: 'pending' | 'failed' | 'complete', error?: string): Promise<void>
}

export class KoishiArchiveMetadataRepository implements ArchiveMetadataRepository {
  constructor(private readonly ctx: Context) {}
  async loadPapers() {
    const rows = await this.ctx.model.get('archivePaper', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), issueNumber: String(row.issueNumber), month: String(row.month), title: String(row.title),
      description: String(row.description || '') || undefined, sourceLink: String(row.sourceLink || '') || undefined,
      attachment: row.attachment ? JSON.parse(String(row.attachment)) : undefined,
      lifecycle: (row.lifecycle || 'active') as 'active' | 'removed',
      backupState: (row.backupState || 'disabled') as NewspaperIssue['backupState'], backupError: String(row.backupError || '') || undefined,
      publishedAt: new Date(row.publishedAt as string | number), updatedAt: new Date(row.updatedAt as string | number),
    }))
  }
  async nextPaperId() {
    const rows = await this.ctx.model.get('archiveSequence', { kind: 'paper' }) as unknown as Array<{ value: number }>
    const value = (rows[0]?.value ?? 0) + 1
    if (rows[0]) await this.ctx.model.set('archiveSequence', { kind: 'paper' }, { value })
    else await this.ctx.model.create('archiveSequence', { kind: 'paper', value })
    return `P${value}`
  }
  async createPaper(paper: NewspaperIssue) {
    const now = paper.updatedAt ?? paper.publishedAt
    await this.ctx.model.create('archivePaper', {
      id: paper.id, issueNumber: paper.issueNumber, month: paper.month, title: paper.title,
      description: paper.description ?? '', sourceLink: paper.sourceLink ?? '', attachment: JSON.stringify(paper.attachment),
      lifecycle: paper.lifecycle ?? 'active', backupState: paper.backupState ?? 'disabled', backupError: paper.backupError ?? '', publishedAt: paper.publishedAt, updatedAt: now,
    })
  }
  async updatePaper(paper: NewspaperIssue) {
    await this.ctx.model.set('archivePaper', { id: paper.id }, {
      issueNumber: paper.issueNumber, month: paper.month, title: paper.title,
      description: paper.description ?? '', sourceLink: paper.sourceLink ?? '', attachment: JSON.stringify(paper.attachment),
      lifecycle: paper.lifecycle ?? 'active', backupState: paper.backupState ?? 'disabled', backupError: paper.backupError ?? '', updatedAt: paper.updatedAt ?? new Date(),
    })
  }
  async loadWorks() {
    const rows = await this.ctx.model.get('archiveWork', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), title: String(row.title), author: String(row.author), description: String(row.description || '') || undefined,
      attachment: row.attachment ? JSON.parse(String(row.attachment)) : undefined, lifecycle: (row.lifecycle || 'active') as 'active' | 'removed',
      backupState: (row.backupState || 'disabled') as Work['backupState'], backupError: String(row.backupError || '') || undefined,
      publishedAt: new Date(row.publishedAt as string | number), updatedAt: new Date(row.updatedAt as string | number),
    }))
  }
  async nextWorkId() {
    const rows = await this.ctx.model.get('archiveSequence', { kind: 'work' }) as unknown as Array<{ value: number }>
    const value = (rows[0]?.value ?? 0) + 1
    if (rows[0]) await this.ctx.model.set('archiveSequence', { kind: 'work' }, { value })
    else await this.ctx.model.create('archiveSequence', { kind: 'work', value })
    return `W${value}`
  }
  async createWork(work: Work) {
    await this.ctx.model.create('archiveWork', {
      id: work.id, title: work.title, author: work.author, description: work.description ?? '', attachment: JSON.stringify(work.attachment), lifecycle: work.lifecycle ?? 'active',
      backupState: work.backupState ?? 'disabled', backupError: work.backupError ?? '', publishedAt: work.publishedAt, updatedAt: work.updatedAt ?? work.publishedAt,
    })
  }
  async updateWork(work: Work) {
    await this.ctx.model.set('archiveWork', { id: work.id }, {
      title: work.title, author: work.author, description: work.description ?? '', attachment: JSON.stringify(work.attachment), lifecycle: work.lifecycle ?? 'active',
      backupState: work.backupState ?? 'disabled', backupError: work.backupError ?? '', updatedAt: work.updatedAt ?? new Date(),
    })
  }
  async updateBackupState(kind: 'paper' | 'work', id: string, state: 'pending' | 'failed' | 'complete', error?: string) {
    const table = kind === 'paper' ? 'archivePaper' : 'archiveWork'
    await this.ctx.model.set(table, { id }, { backupState: state, backupError: error ?? '', updatedAt: new Date() } as any)
  }
}

export interface R2Store {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
  delete(key: string): Promise<void>
}

export interface ArchiveBackupQueue {
  enqueue(attachment: Attachment, context?: BackupContext): Promise<void>
  runDue?(): Promise<void>
  retryNow?(recordId?: string): Promise<void>
  counts?(): Promise<{ pending: number; failed: number; complete: number }>
}

export interface MessageSender {
  forward?(session: unknown, item: NewspaperIssue | Work): Promise<unknown>
  ordinary(session: unknown, item: NewspaperIssue | Work): Promise<unknown>
}

export interface ArchiveSession {
  userId?: string
  guildId?: string
  authority?: number
  isDirect?: boolean
  send?: (content: unknown) => Promise<unknown> | unknown
  elements?: Array<{ type?: string; attrs?: Record<string, string>; children?: unknown }>
}

export interface AttachmentInput {
  data: Uint8Array | string
  filename: string
  contentType?: string
}

export interface IssueInput {
  month: string
  issueNumber: string
  title: string
  description?: string
  sourceLink?: string
  attachment?: AttachmentInput
}

export interface WorkInput {
  title: string
  author: string
  description?: string
  attachment?: AttachmentInput
}

function validatePaperMetadata(input: Pick<IssueInput, 'title' | 'issueNumber' | 'month' | 'description' | 'sourceLink'>) {
  const title = input.title?.trim()
  const issueNumber = input.issueNumber?.trim()
  if (!title) throw new Error('Paper 标题不能为空')
  if (!issueNumber) throw new Error('Paper 期号不能为空')
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new Error('Paper 出刊月份必须使用 YYYY-MM')
  const sourceLink = input.sourceLink?.trim()
  if (sourceLink && !/^https?:\/\//i.test(sourceLink)) throw new Error('Paper 来源链接必须以 http:// 或 https:// 开头')
  return { title, issueNumber, month: input.month, description: input.description?.trim() || undefined, sourceLink: sourceLink || undefined }
}

function validatePdfAttachment(input: AttachmentInput, maxMb: number) {
  const type = input.contentType?.toLowerCase()
  if ((type && type !== 'application/pdf') || !input.filename.toLowerCase().endsWith('.pdf')) throw new Error('Newspaper Issue attachment must be a PDF')
  const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
  const header = new TextDecoder().decode(data.slice(0, 8))
  const trailer = new TextDecoder().decode(data.slice(Math.max(0, data.byteLength - 1024)))
  if (!header.startsWith('%PDF-') || !trailer.includes('%%EOF')) throw new Error('Paper attachment is not a valid PDF')
  if (data.byteLength > maxMb * 1024 * 1024) throw new Error(`Paper PDF 大小超过 ${maxMb} MB 限制`)
  return data
}

function validateWorkMetadata(input: Pick<WorkInput, 'title' | 'author' | 'description'>) {
  const title = input.title?.trim()
  const author = input.author?.trim()
  if (!title) throw new Error('Work 标题不能为空')
  if (!author) throw new Error('Work 作者不能为空')
  return { title, author, description: input.description?.trim() || undefined }
}

function workBytes(input: AttachmentInput, maxMb: number) {
  const type = input.contentType?.toLowerCase()
  if ((type && !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(type)) || !input.filename.toLowerCase().endsWith('.zip')) throw new Error('Work Package 必须是 ZIP')
  const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
  if (data.byteLength > maxMb * 1024 * 1024) throw new Error(`Work ZIP 大小超过 ${maxMb} MB 限制`)
  return data
}

export class MemoryR2Store implements R2Store {
  readonly objects = new Map<string, Uint8Array>()
  async put(key: string, data: Uint8Array) { this.objects.set(key, data) }
  async get(key: string) { return this.objects.get(key) }
  async delete(key: string) { this.objects.delete(key) }
}

export class LocalAttachmentStore {
  constructor(readonly root: string, readonly r2?: R2Store, readonly objectPrefix = 'memebot-archive') {}

  async save(id: string, input: AttachmentInput): Promise<Attachment> {
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const relativePath = join(id, safeName).replaceAll('\\', '/')
    const fullPath = this.fullPath(relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, data)
    const checksum = createHash('sha256').update(data).digest('hex')
    const attachment: Attachment = {
      relativePath, contentType: input.contentType ?? 'application/octet-stream', size: data.byteLength, checksum,
      r2: this.r2 ? { objectKey: `${this.objectPrefix.replace(/^\/+|\/+$/g, '')}/${relativePath}`, syncState: 'pending' } : undefined,
    }
    return attachment
  }

  async read(attachment: Attachment): Promise<Uint8Array> {
    try { return new Uint8Array(await readFile(this.fullPath(attachment.relativePath))) } catch (error) {
      if (!this.r2) throw error
      const data = await this.r2.get(attachment.r2?.objectKey ?? `memebot-archive/${attachment.relativePath}`)
      if (!data) throw error
      await mkdir(dirname(this.fullPath(attachment.relativePath)), { recursive: true })
      await writeFile(this.fullPath(attachment.relativePath), data)
      return data
    }
  }

  async sync(attachment: Attachment, data?: Uint8Array): Promise<Attachment> {
    if (!this.r2 || !attachment.r2) return attachment
    attachment.r2.lastAttempt = new Date().toISOString()
    try {
      data ??= new Uint8Array(await readFile(this.fullPath(attachment.relativePath)))
      await this.r2.put(attachment.r2.objectKey, data, attachment.contentType)
      attachment.r2.syncState = 'synced'
      delete attachment.r2.error
    } catch (error) {
      attachment.r2.syncState = 'failed'
      attachment.r2.error = error instanceof Error ? error.message : String(error)
    }
    return attachment
  }
  private fullPath(relativePath: string) {
    const root = resolve(this.root)
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(root + sep)) throw new Error('unsafe attachment path')
    return target
  }
}

export class ImmediateArchiveBackupQueue implements ArchiveBackupQueue {
  constructor(private readonly local: LocalAttachmentStore) {}
  async enqueue(attachment: Attachment) { await this.local.sync(attachment) }
}

export class ArchiveService {
  readonly db: ArchiveDatabase
  readonly local: LocalAttachmentStore
  readonly config: Config
  private paperSequence = 0
  private workSequence = 0
  private readonly metadata?: ArchiveMetadataRepository
  private readonly backupQueue?: ArchiveBackupQueue
  readonly previews: WorkPreviewStore
  readonly fallbackEvents: Array<{ id: string; kind: 'issue' | 'work'; reason: string }> = []

  constructor(options: { config?: Partial<Config>; db?: Partial<ArchiveDatabase>; local?: LocalAttachmentStore; r2?: R2Store; metadata?: ArchiveMetadataRepository; backupQueue?: ArchiveBackupQueue; previews?: WorkPreviewStore }) {
    this.config = {
      administrators: [], managementGroups: [], localPath: 'data/memebot-archive', paperMaxMb: 100, workMaxMb: 500,
      r2: { enabled: false, accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '', objectPrefix: 'memebot-archive' },
      ...options.config,
    }
    this.db = { issues: options.db?.issues ?? [], works: options.db?.works ?? [] }
    this.local = options.local ?? new LocalAttachmentStore(this.config.localPath, options.r2, this.config.r2.objectPrefix)
    this.previews = options.previews ?? new WorkPreviewStore(join(this.config.localPath, '.previews'))
    this.metadata = options.metadata
    this.backupQueue = options.backupQueue ?? (options.r2 ? new ImmediateArchiveBackupQueue(this.local) : undefined)
  }

  async initialize() {
    if (!this.metadata) return
    const [papers, works] = await Promise.all([this.metadata.loadPapers(), this.metadata.loadWorks()])
    const addedPapers = this.db.issues.filter(item => !papers.some(paper => paper.id === item.id))
    const addedWorks = this.db.works.filter(item => !works.some(work => work.id === item.id))
    this.db.issues.splice(0, this.db.issues.length, ...papers, ...addedPapers)
    this.db.works.splice(0, this.db.works.length, ...works, ...addedWorks)
  }

  isAdmin(session: ArchiveSession): boolean {
    const identity = (session.authority ?? 0) >= 4 || (!!session.userId && this.config.administrators.some(item => item.qq === session.userId))
    const location = !session.guildId || !this.config.managementGroups.length || this.config.managementGroups.some(item => item.qq === session.guildId)
    return identity && location
  }

  private id(prefix: 'P' | 'W') { return prefix === 'P' ? `P${++this.paperSequence}` : `W${++this.workSequence}` }
  previewIssue(input: IssueInput) { return { ...input, kind: 'Newspaper Issue' as const, preview: true } }
  previewWork(input: WorkInput) { return { ...input, kind: 'Work' as const, preview: true } }

  async publishIssue(session: ArchiveSession, input: IssueInput): Promise<NewspaperIssue> {
    this.requireAdmin(session)
    const validated = validatePaperMetadata(input)
    if (!input.attachment) throw new Error('Newspaper Issue PDF attachment required')
    validatePdfAttachment(input.attachment, this.config.paperMaxMb)
    const id = this.metadata ? await this.metadata.nextPaperId() : this.id('P')
    const attachmentInput = input.attachment
    const issue: NewspaperIssue = { id, ...validated, publishedAt: new Date(), updatedAt: new Date(), lifecycle: 'active', backupState: this.backupQueue ? 'pending' : 'disabled' }
    if (attachmentInput) issue.attachment = await this.local.save(id, attachmentInput)
    if (this.metadata) await this.metadata.createPaper(issue)
    this.db.issues.push(issue)
    if (issue.attachment && this.backupQueue) {
      await this.backupQueue.enqueue(issue.attachment, { recordKind: 'paper', recordId: issue.id, manifest: this.manifest(issue) })
      if (this.backupQueue.runDue) void this.backupQueue.runDue()
    }
    return issue
  }

  async publishWork(session: ArchiveSession, input: WorkInput): Promise<Work> {
    this.requireAdmin(session)
    const validated = validateWorkMetadata(input)
    if (!input.attachment) throw new Error('Work Package ZIP attachment required')
    const data = workBytes(input.attachment, this.config.workMaxMb)
    const id = this.metadata ? await this.metadata.nextWorkId() : this.id('W')
    await this.previews.build(id, data)
    const work: Work = { id, ...validated, publishedAt: new Date(), updatedAt: new Date(), lifecycle: 'active', backupState: this.backupQueue ? 'pending' : 'disabled' }
    work.attachment = await this.local.save(id, { ...input.attachment, data })
    if (this.metadata) await this.metadata.createWork(work)
    this.db.works.push(work)
    if (this.backupQueue) {
      await this.backupQueue.enqueue(work.attachment, { recordKind: 'work', recordId: work.id, manifest: this.manifest(work) })
      if (this.backupQueue.runDue) void this.backupQueue.runDue()
    }
    return work
  }

  async updateIssue(session: ArchiveSession, id: string, patch: Partial<Omit<IssueInput, 'attachment'>>, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const issue = this.getIssue(id)
    if (!issue) throw new Error('Newspaper Issue not found')
    Object.assign(issue, validatePaperMetadata({ ...issue, ...patch }))
    issue.updatedAt = new Date()
    if (this.metadata) await this.metadata.updatePaper(issue)
    return issue
  }
  async replaceIssueAttachment(session: ArchiveSession, id: string, attachmentInput: AttachmentInput) {
    this.requireAdmin(session)
    const issue = this.getIssue(id)
    if (!issue) throw new Error('Newspaper Issue not found')
    validatePdfAttachment(attachmentInput, this.config.paperMaxMb)
    issue.attachment = await this.local.save(issue.id, attachmentInput)
    if (this.backupQueue) await this.backupQueue.enqueue(issue.attachment)
    issue.updatedAt = new Date()
    if (this.metadata) await this.metadata.updatePaper(issue)
    return issue
  }
  async updateWork(session: ArchiveSession, id: string, patch: Partial<Omit<WorkInput, 'attachment'>>, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const work = this.db.works.find(item => item.id === id)
    if (!work) throw new Error('Work not found')
    Object.assign(work, validateWorkMetadata({ ...work, ...patch }))
    work.updatedAt = new Date()
    if (this.metadata) await this.metadata.updateWork(work)
    return work
  }
  async replaceWorkAttachment(session: ArchiveSession, id: string, attachmentInput: AttachmentInput) {
    this.requireAdmin(session)
    const work = this.getWork(id)
    if (!work) throw new Error('Work not found')
    const data = workBytes(attachmentInput, this.config.workMaxMb)
    await this.previews.build(work.id, data)
    work.attachment = await this.local.save(work.id, { ...attachmentInput, data })
    work.updatedAt = new Date(); work.backupState = this.backupQueue ? 'pending' : 'disabled'; delete work.backupError
    if (this.metadata) await this.metadata.updateWork(work)
    if (this.backupQueue) { await this.backupQueue.enqueue(work.attachment, { recordKind: 'work', recordId: work.id, manifest: this.manifest(work) }); if (this.backupQueue.runDue) void this.backupQueue.runDue() }
    return work
  }
  async removeIssue(session: ArchiveSession, id: string, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const issue = this.getIssue(id)
    if (!issue) throw new Error('Newspaper Issue not found')
    issue.lifecycle = 'removed'; issue.updatedAt = new Date()
    if (this.metadata) await this.metadata.updatePaper(issue)
    return issue
  }
  async removeWork(session: ArchiveSession, id: string, confirmation?: string) { this.requireConfirmation(session, confirmation); const work = this.getWork(id); if (!work) throw new Error('Work not found'); work.lifecycle = 'removed'; work.updatedAt = new Date(); if (this.metadata) await this.metadata.updateWork(work); return work }

  listIssues(month?: string) { return this.db.issues.filter(item => item.lifecycle !== 'removed' && (!month || item.month === month)).sort((a, b) => b.month.localeCompare(a.month) || b.title.localeCompare(a.title)) }
  searchIssues(query?: string) {
    const text = query?.trim().toLocaleLowerCase()
    return this.listIssues().filter(item => !text || `${item.month} ${item.issueNumber} ${item.title} ${item.description ?? ''}`.toLocaleLowerCase().includes(text))
  }
  getIssue(id: string) { return this.db.issues.find(item => item.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && item.lifecycle !== 'removed') }
  getWork(id: string) { return this.db.works.find(item => item.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && item.lifecycle !== 'removed') }
  searchWorks(filters: { author?: string; text?: string } = {}) {
    const text = filters.text?.toLocaleLowerCase()
    return this.db.works.filter(item => item.lifecycle !== 'removed' && (!filters.author || item.author.localeCompare(filters.author, undefined, { sensitivity: 'base' }) === 0) && (!text || `${item.title} ${item.author} ${item.description ?? ''}`.toLocaleLowerCase().includes(text))).sort((a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title))
  }

  async retryPending() {
    if (this.backupQueue?.retryNow) { await this.backupQueue.retryNow(); return }
    for (const item of [...this.db.issues, ...this.db.works]) {
      if (item.attachment?.r2 && item.attachment.r2.syncState !== 'synced') await (this.backupQueue?.enqueue(item.attachment) ?? this.local.sync(item.attachment))
    }
  }
  async recover(item: NewspaperIssue | Work) { return item.attachment ? this.local.read(item.attachment) : undefined }
  async rebuildWorkPreview(id: string) {
    const work = this.getWork(id)
    if (!work?.attachment) throw new Error('Work 不存在或没有 ZIP')
    return this.previews.build(work.id, await this.local.read(work.attachment))
  }

  async sendIssue(session: ArchiveSession, id: string, sender: MessageSender) { return this.send(session, this.getIssue(id), sender, 'issue') }
  async sendWork(session: ArchiveSession, id: string, sender: MessageSender) { return this.send(session, this.getWork(id), sender, 'work') }
  private async send(session: ArchiveSession, item: NewspaperIssue | Work | undefined, sender: MessageSender, kind: 'issue' | 'work') {
    if (!item) throw new Error(`${kind} not found`)
    if (sender.forward) try { return await sender.forward(session, item) } catch { /* fall through */ }
    this.fallbackEvents.push({ id: item.id, kind, reason: 'forward-message unavailable or failed' })
    return sender.ordinary(session, item)
  }
  requireAdmin(session: ArchiveSession) { if (!this.isAdmin(session)) throw new Error('archive administrator permission required') }
  private requireConfirmation(session: ArchiveSession, confirmation?: string) { this.requireAdmin(session); if (confirmation !== 'Y') throw new Error('confirmation requires exact Y') }
  private remove<T extends { id: string }>(items: T[], id: string, label: string) { const index = items.findIndex(item => item.id === id); if (index < 0) throw new Error(`${label} not found`); return items.splice(index, 1)[0] }
  private manifest(item: NewspaperIssue | Work) {
    const { attachment, ...metadata } = item
    return { ...metadata, attachment: attachment && { relativePath: attachment.relativePath, contentType: attachment.contentType, size: attachment.size, checksum: attachment.checksum } }
  }
}

function commandSession(session: any): ArchiveSession {
  return {
    userId: session.userId,
    guildId: session.guildId,
    authority: session.authority ?? session.user?.authority,
    isDirect: !session.guildId,
    send: session.send?.bind(session),
  }
}

function payload(value: string | undefined): any {
  if (!value) throw new Error('请输入 JSON 元数据。')
  try { return JSON.parse(value) } catch { throw new Error('元数据必须是合法 JSON。') }
}

function decodeConsoleAttachment(input: AttachmentInput): AttachmentInput {
  if (typeof input.data !== 'string' || !input.data.startsWith('data:')) return input
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(input.data)
  if (!match) throw new Error('上传内容必须是 base64 data URL。')
  return { ...input, contentType: input.contentType || match[1] || 'application/octet-stream', data: new Uint8Array(Buffer.from(match[2], 'base64')) }
}

export class ArchiveConsoleFeatures {
  constructor(
    private readonly ctx: Context,
    private readonly service: ArchiveService,
    private readonly ready: Promise<void>,
    private readonly preflight?: ArchivePreflight,
    private readonly queue?: ArchiveBackupQueue,
  ) {}
  register() {
    const consoleService = (this.ctx as any).console
    if (!consoleService?.addListener) return
    consoleService.addEntry?.({ dev: resolve(__dirname, '../client/index.ts'), prod: resolve(__dirname, '../dist') })
    consoleService.addListener('memebot/archive/status', async () => {
      const health = this.preflight ? await this.preflight.check() : { state: 'ready' as const, lastCheck: new Date().toISOString(), stores: { local: { ok: true }, r2: { enabled: false } } }
      const queue = this.queue?.counts ? await this.queue.counts() : { pending: 0, failed: 0, complete: 0 }
      try { await this.ready; return { ...health, queue } } catch (error) { return { ...health, state: 'unavailable', error: error instanceof Error ? error.message : String(error), queue } }
    })
    consoleService.addListener('memebot/archive/recheck', async () => this.preflight?.check(), { authority: 4 })
    consoleService.addListener('memebot/archive/backup/retry', async (recordId?: string) => { await this.queue?.retryNow?.(recordId); return this.queue?.counts?.() }, { authority: 4 })
    consoleService.addListener('memebot/archive/papers', async (query?: string) => { await this.ready; return this.service.searchIssues(query) })
    consoleService.addListener('memebot/archive/paper/create', async (input: IssueInput) => {
      await this.ready
      return this.service.publishIssue({ authority: 4 }, { ...input, attachment: input.attachment && decodeConsoleAttachment(input.attachment) })
    }, { authority: 4 })
    consoleService.addListener('memebot/archive/paper/edit', async (id: string, patch: Partial<IssueInput>) => { await this.ready; return this.service.updateIssue({ authority: 4 }, id, patch, 'Y') }, { authority: 4 })
    consoleService.addListener('memebot/archive/paper/upload', async (id: string, attachment: AttachmentInput) => {
      await this.ready
      return this.service.replaceIssueAttachment({ authority: 4 }, id, decodeConsoleAttachment(attachment))
    }, { authority: 4 })
    const attachment = async (id: string) => {
      await this.ready
      const paper = this.service.getIssue(id)
      if (!paper?.attachment) throw new Error('Paper 不存在或没有附件')
      const data = await this.service.recover(paper)
      return { filename: paper.attachment.relativePath.split('/').pop(), contentType: paper.attachment.contentType, data: Buffer.from(data!).toString('base64') }
    }
    consoleService.addListener('memebot/archive/paper/preview', attachment)
    consoleService.addListener('memebot/archive/paper/download', attachment)
    consoleService.addListener('memebot/archive/works', async (query?: string) => { await this.ready; return this.service.searchWorks({ text: query }) })
    consoleService.addListener('memebot/archive/work/create', async (input: WorkInput) => {
      await this.ready
      return this.service.publishWork({ authority: 4 }, { ...input, attachment: input.attachment && decodeConsoleAttachment(input.attachment) })
    }, { authority: 4 })
    consoleService.addListener('memebot/archive/work/edit', async (id: string, patch: Partial<WorkInput>) => { await this.ready; return this.service.updateWork({ authority: 4 }, id, patch, 'Y') }, { authority: 4 })
    consoleService.addListener('memebot/archive/work/upload', async (id: string, input: AttachmentInput) => { await this.ready; return this.service.replaceWorkAttachment({ authority: 4 }, id, decodeConsoleAttachment(input)) }, { authority: 4 })
    consoleService.addListener('memebot/archive/work/tree', async (id: string) => { await this.ready; const tree = await this.service.previews.tree(id); return tree.length ? tree : this.service.rebuildWorkPreview(id) })
    consoleService.addListener('memebot/archive/work/preview', async (id: string, path: string) => { await this.ready; return this.service.previews.preview(id, path) })
    consoleService.addListener('memebot/archive/work/file', async (id: string, path: string) => { await this.ready; const data = await this.service.previews.download(id, path); return { filename: path.split('/').pop(), data: Buffer.from(data).toString('base64') } })
    consoleService.addListener('memebot/archive/work/download', async (id: string) => {
      await this.ready
      const work = this.service.getWork(id); if (!work?.attachment) throw new Error('Work 不存在或没有 ZIP')
      const data = await this.service.recover(work)
      return { filename: work.attachment.relativePath.split('/').pop(), contentType: work.attachment.contentType, data: Buffer.from(data!).toString('base64') }
    })
  }
}

export function apply(ctx: Context, config: Config) {
  const suppliedR2 = config?.r2
  config = {
    administrators: config?.administrators ?? [], managementGroups: config?.managementGroups ?? [], localPath: config?.localPath || 'data/memebot-archive',
    paperMaxMb: config?.paperMaxMb || 100, workMaxMb: config?.workMaxMb || 500,
    r2: {
      enabled: suppliedR2?.enabled ?? false,
      accountId: suppliedR2?.accountId ?? '',
      bucketName: suppliedR2?.bucketName ?? '',
      accessKeyId: suppliedR2?.accessKeyId ?? '',
      secretAccessKey: suppliedR2?.secretAccessKey ?? '',
      objectPrefix: suppliedR2?.objectPrefix || 'memebot-archive',
    },
  }
  if (config.r2.enabled) {
    const missing = (['accountId', 'bucketName', 'accessKeyId', 'secretAccessKey'] as const).filter(key => !config.r2[key])
    if (missing.length) throw new Error(`R2 已启用但配置不完整：${missing.join(', ')}`)
  }
  ctx.model.extend('archivePaper', {
    id: 'string', issueNumber: 'string', month: 'string', title: 'string', description: 'text', sourceLink: 'string', attachment: 'text', lifecycle: 'string', backupState: 'string', backupError: 'text', publishedAt: 'timestamp', updatedAt: 'timestamp',
  }, { primary: 'id' })
  ctx.model.extend('archiveWork', { id: 'string', title: 'string', author: 'string', description: 'text', attachment: 'text', lifecycle: 'string', backupState: 'string', backupError: 'text', publishedAt: 'timestamp', updatedAt: 'timestamp' }, { primary: 'id' })
  ctx.model.extend('archiveSequence', { kind: 'string', value: 'unsigned' }, { primary: 'kind' })
  ctx.model.extend('archiveBackupJob', { id: 'string', recordKind: 'string', recordId: 'string', attachment: 'text', manifest: 'text', state: 'string', attempts: 'unsigned', nextAttemptAt: 'timestamp', error: 'text' }, { primary: 'id' })
  const metadata = new KoishiArchiveMetadataRepository(ctx)
  const r2 = config.r2.enabled ? new S3R2Store(config.r2) : undefined
  const local = new LocalAttachmentStore(config.localPath, r2, config.r2.objectPrefix)
  let service!: ArchiveService
  const sink: BackupStatusSink = { update: async (kind, id, state, error) => {
    await metadata.updateBackupState(kind, id, state, error)
    const item = kind === 'paper' ? service?.getIssue(id) : service?.getWork(id)
    if (item) { item.backupState = state; item.backupError = error }
  } }
  const queue = r2 ? new PersistentArchiveBackupQueue(ctx, local, r2, sink) : undefined
  service = new ArchiveService({ config, metadata, local, backupQueue: queue })
  const preflight = new ArchivePreflight(config.localPath, r2, [config.r2.accessKeyId, config.r2.secretAccessKey])
  const initialized = service.initialize()
  const ready = Promise.all([initialized, preflight.check()]).then(([, health]) => { if (health.state === 'unavailable') throw new Error(health.stores.local.error || '本地存储不可用') })
  void ready.catch(() => undefined)
  new ArchiveConsoleFeatures(ctx, service, ready, preflight, queue).register()
  if (queue) ctx.setInterval(() => { void queue.runDue() }, 60_000)
  ;(ctx as any).archive = service
  const root = ctx.command('archive [id:text]', '搜索或获取 Paper 归档')
  root.action(async ({ session }, id) => {
    await ready
    if (!id) return '请使用 /archive search paper [查询]、/archive search works [查询]，或 /archive P/W编号。'
    if (/^w\d+$/i.test(id)) {
      const work = service.getWork(id)
      if (!work?.attachment) return 'Work 不存在。'
      const data = await service.recover(work)
      await session?.send(`${work.id} ${work.author} - ${work.title}\n${work.description ?? ''}`.trim())
      return h.file(`data:${work.attachment.contentType};base64,${Buffer.from(data!).toString('base64')}`, { filename: work.attachment.relativePath.split('/').pop() || `${work.id}.zip` })
    }
    const paper = service.getIssue(id)
    if (!paper) return 'Paper 不存在。'
    const detail = `${paper.id} ${paper.month} 第${paper.issueNumber}期 ${paper.title}\n${paper.description ?? ''}`.trim()
    if (!paper.attachment) return detail
    const data = await service.recover(paper)
    const filename = paper.attachment.relativePath.split('/').pop() || `${paper.id}.pdf`
    const url = `data:${paper.attachment.contentType};base64,${Buffer.from(data!).toString('base64')}`
    await session?.send(detail)
    return h.file(url, { filename })
  })
  root.subcommand('.search paper [query:text]', '按月份、期号、标题或描述搜索 Paper').action(async (_meta, query) => {
    await ready
    const items = service.searchIssues(query)
    return items.length ? items.map(item => `${item.id} ${item.month} 第${item.issueNumber}期 ${item.title}`).join('\n') : '没有找到 Paper。'
  })
  const guidedPrompt = async (session: any, label: string, optional = false) => {
    await session.send(label + (optional ? '（发送 - 跳过）' : ''))
    const value = (await session.prompt(300000))?.trim()
    if (!value) throw new Error('操作已超时或输入为空。')
    return optional && value === '-' ? '' : value
  }
  root.subcommand('.publish.paper', '引导发布一个 Paper PDF').action(async ({ session }) => {
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    service.requireAdmin(archiveSession)
    try {
      const title = await guidedPrompt(session, '请输入 Paper 标题。')
      const issueNumber = await guidedPrompt(session, '请输入期号。')
      const month = await guidedPrompt(session, '请输入出刊月份（YYYY-MM）。')
      const description = await guidedPrompt(session, '请输入描述。', true)
      const sourceLink = await guidedPrompt(session, '请输入来源链接。', true)
      await session.send('请发送一个 PDF 附件；也可发送 PDF 下载地址。')
      const uploadSession = await session.prompt((incoming: any) => incoming, { timeout: 300000 })
      if (!uploadSession) throw new Error('等待 PDF 已超时。')
      const element = (uploadSession.elements || []).find((item: any) => item.type === 'file')
      const pdfUrl = element?.attrs?.src || element?.attrs?.url || String(uploadSession.content || '').trim()
      if (!pdfUrl) throw new Error('没有收到 PDF 附件或下载地址。')
      const response = await fetch(pdfUrl)
      if (!response.ok) throw new Error(`PDF 下载失败：${response.status}`)
      const input: IssueInput = {
        title, issueNumber, month, description: description || undefined, sourceLink: sourceLink || undefined,
        attachment: { filename: element?.attrs?.filename || element?.attrs?.title || `${title}.pdf`, contentType: element?.attrs?.mime || response.headers.get('content-type') || 'application/pdf', data: new Uint8Array(await response.arrayBuffer()) },
      }
      await session.send(`Paper 预览\n标题：${title}\n期号：${issueNumber}\n月份：${month}\n请发送“确认”发布，其他输入取消。`)
      if ((await session.prompt(300000))?.trim() !== '确认') return '已取消发布。'
      const paper = await service.publishIssue(archiveSession, input)
      return `已发布 Paper ${paper.id}。`
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  root.subcommand('.publish.works', '引导发布一个 ZIP Work Package').action(async ({ session }) => {
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    service.requireAdmin(archiveSession)
    try {
      const title = await guidedPrompt(session, '请输入 Work 标题。')
      const author = await guidedPrompt(session, '请输入作者。')
      const description = await guidedPrompt(session, '请输入描述。', true)
      await session.send('请发送一个 ZIP Work Package；也可发送 ZIP 下载地址。')
      const uploadSession = await session.prompt((incoming: any) => incoming, { timeout: 300000 })
      if (!uploadSession) throw new Error('等待 ZIP 已超时。')
      const element = (uploadSession.elements || []).find((item: any) => item.type === 'file')
      const zipUrl = element?.attrs?.src || element?.attrs?.url || String(uploadSession.content || '').trim()
      if (!zipUrl) throw new Error('没有收到 ZIP 附件或下载地址。')
      const response = await fetch(zipUrl)
      if (!response.ok) throw new Error(`ZIP 下载失败：${response.status}`)
      const input: WorkInput = {
        title, author, description: description || undefined,
        attachment: { filename: element?.attrs?.filename || element?.attrs?.title || `${title}.zip`, contentType: element?.attrs?.mime || response.headers.get('content-type') || 'application/zip', data: new Uint8Array(await response.arrayBuffer()) },
      }
      await session.send(`Work 预览\n标题：${title}\n作者：${author}\n请发送“确认”发布，其他输入取消。`)
      if ((await session.prompt(300000))?.trim() !== '确认') return '已取消发布。'
      const work = await service.publishWork(archiveSession, input)
      return `已发布 Work ${work.id}。`
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  root.subcommand('.edit.paper <id:string>', '引导编辑 Paper 元数据').action(async ({ session }, id) => {
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    service.requireAdmin(archiveSession)
    const paper = service.getIssue(id)
    if (!paper) return 'Paper 不存在。'
    const field = await guidedPrompt(session, `当前：${paper.title} ${paper.issueNumber} ${paper.month}\n请选择字段：标题、期号、月份、描述、来源。`)
    const map: Record<string, keyof Pick<IssueInput, 'title' | 'issueNumber' | 'month' | 'description' | 'sourceLink'>> = { 标题: 'title', 期号: 'issueNumber', 月份: 'month', 描述: 'description', 来源: 'sourceLink' }
    const key = map[field]
    if (!key) return '未知字段。'
    const value = await guidedPrompt(session, '请输入新值。', key === 'description' || key === 'sourceLink')
    await session.send(`将 ${field} 修改为：${value || '（空）'}\n请发送“确认”继续。`)
    if ((await session.prompt(300000))?.trim() !== '确认') return '已取消编辑。'
    const updated = await service.updateIssue(archiveSession, id, { [key]: value }, 'Y')
    return `已更新 Paper ${updated.id}。`
  })
  root.subcommand('.issues [month:text]', '按月份浏览 Paper').action(async (_meta, month) => {
    await ready
    const items = service.listIssues(month)
    return items.length ? items.map(item => `${item.id} ${item.month} ${item.title}`).join('\n') : '没有找到 Newspaper Issue。'
  })
  root.subcommand('.works [query:text]', '查询 Work').action(async ({ session }, query) => {
    const items = service.searchWorks({ text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.search works [query:text]', '按标题、作者或描述搜索 Work').action(async (_meta, query) => {
    const items = service.searchWorks({ text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.work-query [author:text] [query:text]', '按作者或文本查询 Work').action(async ({ session }, author, query) => {
    const items = service.searchWorks({ author, text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.issue-preview <metadata:text>', '预览 Newspaper Issue 元数据').action(({ session }, metadata) => {
    service.requireAdmin(commandSession(session))
    return JSON.stringify(service.previewIssue(payload(metadata)))
  })
  root.subcommand('.work-preview <metadata:text>', '预览 Work 元数据').action(({ session }, metadata) => {
    service.requireAdmin(commandSession(session))
    return JSON.stringify(service.previewWork(payload(metadata)))
  })
  root.subcommand('.issue-publish <metadata:text>', '发布 Newspaper Issue').action(async ({ session }, metadata) => {
    await ready
    const item = await service.publishIssue(commandSession(session), payload(metadata))
    return `已发布 Newspaper Issue ${item.id}。`
  })
  root.subcommand('.work-publish <metadata:text>', '发布 Work').action(async ({ session }, metadata) => {
    const item = await service.publishWork(commandSession(session), payload(metadata))
    return `已发布 Work ${item.id}。`
  })
  root.subcommand('.issue-edit <id:string> <confirmation:string> <patch:text>', '编辑 Newspaper Issue 元数据').action(async ({ session }, id, confirmation, patch) => {
    return `已更新 Newspaper Issue ${(await service.updateIssue(commandSession(session), id, payload(patch), confirmation)).id}。`
  })
  root.subcommand('.work-edit <id:string> <confirmation:string> <patch:text>', '编辑 Work 元数据').action(async ({ session }, id, confirmation, patch) => {
    return `已更新 Work ${(await service.updateWork(commandSession(session), id, payload(patch), confirmation)).id}。`
  })
  root.subcommand('.issue-remove <id:string> <confirmation:string>', '删除 Newspaper Issue').action(async ({ session }, id, confirmation) => {
    await service.removeIssue(commandSession(session), id, confirmation)
    return `已删除 Newspaper Issue ${id}。`
  })
  root.subcommand('.work-remove <id:string> <confirmation:string>', '删除 Work').action(async ({ session }, id, confirmation) => {
    await service.removeWork(commandSession(session), id, confirmation)
    return `已删除 Work ${id}。`
  })
  root.subcommand('.retry', '重试附件 R2 同步').action(async ({ session }) => { service.requireAdmin(commandSession(session)); await service.retryPending(); return '已重试待同步附件。' })
  return service
}

export default { name, inject, Config, apply }
