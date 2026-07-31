import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Schema } from 'koishi'

export const name = 'memebot-archive'

export interface Config {
  adminUserIds: string[]
  adminGroupIds: string[]
  minAuthority: number
  localPath: string
  r2Binding?: string
}

export const Config: Schema<Config> = Schema.object({
  adminUserIds: Schema.array(String).default([]).description('管理员用户 ID 白名单'),
  adminGroupIds: Schema.array(String).default([]).description('管理员群组 ID 白名单'),
  minAuthority: Schema.number().default(4).description('最低 Koishi authority'),
  localPath: Schema.string().default('data/memebot-archive').description('附件本地存储目录'),
  r2Binding: Schema.string().default('archiveBucket').description('可选的 R2 binding 名称'),
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
  month: string
  title: string
  description?: string
  sourceLink?: string
  attachment?: Attachment
  publishedAt: Date
}

export interface Work {
  id: string
  title: string
  author: string
  month: string
  description?: string
  link?: string
  attachment?: Attachment
  publishedAt: Date
}

export interface ArchiveDatabase {
  issues: NewspaperIssue[]
  works: Work[]
}

export interface R2Store {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
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
  title: string
  description?: string
  sourceLink?: string
  attachment?: AttachmentInput
}

export interface WorkInput {
  title: string
  author: string
  month: string
  description?: string
  link?: string
  attachment?: AttachmentInput
}

export class MemoryR2Store implements R2Store {
  readonly objects = new Map<string, Uint8Array>()
  async put(key: string, data: Uint8Array) { this.objects.set(key, data) }
  async get(key: string) { return this.objects.get(key) }
}

export class LocalAttachmentStore {
  constructor(readonly root: string, readonly r2?: R2Store) {}

  async save(id: string, input: AttachmentInput): Promise<Attachment> {
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const relativePath = join(id, safeName).replaceAll('\\', '/')
    const fullPath = join(this.root, relativePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, data)
    const checksum = createHash('sha256').update(data).digest('hex')
    const attachment: Attachment = {
      relativePath, contentType: input.contentType ?? 'application/octet-stream', size: data.byteLength, checksum,
      r2: this.r2 ? { objectKey: `memebot-archive/${relativePath}`, syncState: 'pending' } : undefined,
    }
    if (this.r2) await this.sync(attachment, data)
    return attachment
  }

  async read(attachment: Attachment): Promise<Uint8Array> {
    try { return new Uint8Array(await readFile(join(this.root, attachment.relativePath))) } catch (error) {
      if (!this.r2) throw error
      const data = await this.r2.get(attachment.r2?.objectKey ?? `memebot-archive/${attachment.relativePath}`)
      if (!data) throw error
      await mkdir(dirname(join(this.root, attachment.relativePath)), { recursive: true })
      await writeFile(join(this.root, attachment.relativePath), data)
      return data
    }
  }

  async sync(attachment: Attachment, data?: Uint8Array): Promise<Attachment> {
    if (!this.r2 || !attachment.r2) return attachment
    attachment.r2.lastAttempt = new Date().toISOString()
    try {
      data ??= new Uint8Array(await readFile(join(this.root, attachment.relativePath)))
      await this.r2.put(attachment.r2.objectKey, data, attachment.contentType)
      attachment.r2.syncState = 'synced'
      delete attachment.r2.error
    } catch (error) {
      attachment.r2.syncState = 'failed'
      attachment.r2.error = error instanceof Error ? error.message : String(error)
    }
    return attachment
  }
}

export class ArchiveService {
  readonly db: ArchiveDatabase
  readonly local: LocalAttachmentStore
  readonly config: Config
  private sequence = 0
  readonly fallbackEvents: Array<{ id: string; kind: 'issue' | 'work'; reason: string }> = []

  constructor(options: { config?: Partial<Config>; db?: Partial<ArchiveDatabase>; local?: LocalAttachmentStore; r2?: R2Store }) {
    this.config = { adminUserIds: [], adminGroupIds: [], minAuthority: 4, localPath: 'data/memebot-archive', ...options.config }
    this.db = { issues: options.db?.issues ?? [], works: options.db?.works ?? [] }
    this.local = options.local ?? new LocalAttachmentStore(this.config.localPath, options.r2)
  }

  isAdmin(session: ArchiveSession): boolean {
    if ((session.authority ?? 0) < this.config.minAuthority) return false
    const users = this.config.adminUserIds
    const groups = this.config.adminGroupIds
    if (!users.length && !groups.length) return true
    return (!!session.userId && users.includes(session.userId)) || (!!session.guildId && groups.includes(session.guildId))
  }

  private id(prefix: string) { this.sequence += 1; return `${prefix}-${Date.now().toString(36)}-${this.sequence.toString(36)}` }
  previewIssue(input: IssueInput) { return { ...input, kind: 'Newspaper Issue' as const, preview: true } }
  previewWork(input: WorkInput) { return { ...input, kind: 'Work' as const, preview: true } }

  async publishIssue(session: ArchiveSession, input: IssueInput): Promise<NewspaperIssue> {
    this.requireAdmin(session)
    if (!input.attachment) throw new Error('Newspaper Issue PDF attachment required')
    const type = input.attachment.contentType?.toLowerCase()
    if (type && type !== 'application/pdf' && !input.attachment.filename.toLowerCase().endsWith('.pdf')) {
      throw new Error('Newspaper Issue attachment must be a PDF')
    }
    const id = this.id('issue')
    const { attachment: attachmentInput, ...metadata } = input
    const issue: NewspaperIssue = { id, ...metadata, publishedAt: new Date() }
    if (attachmentInput) issue.attachment = await this.local.save(id, attachmentInput)
    this.db.issues.push(issue)
    return issue
  }

  async publishWork(session: ArchiveSession, input: WorkInput): Promise<Work> {
    this.requireAdmin(session)
    const id = this.id('work')
    const { attachment: attachmentInput, ...metadata } = input
    const work: Work = { id, ...metadata, publishedAt: new Date() }
    if (attachmentInput) work.attachment = await this.local.save(id, attachmentInput)
    this.db.works.push(work)
    return work
  }

  updateIssue(session: ArchiveSession, id: string, patch: Partial<Omit<IssueInput, 'attachment'>>, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const issue = this.db.issues.find(item => item.id === id)
    if (!issue) throw new Error('Newspaper Issue not found')
    Object.assign(issue, patch)
    return issue
  }
  updateWork(session: ArchiveSession, id: string, patch: Partial<Omit<WorkInput, 'attachment'>>, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const work = this.db.works.find(item => item.id === id)
    if (!work) throw new Error('Work not found')
    Object.assign(work, patch)
    return work
  }
  removeIssue(session: ArchiveSession, id: string, confirmation?: string) { this.requireConfirmation(session, confirmation); return this.remove(this.db.issues, id, 'Newspaper Issue') }
  removeWork(session: ArchiveSession, id: string, confirmation?: string) { this.requireConfirmation(session, confirmation); return this.remove(this.db.works, id, 'Work') }

  listIssues(month?: string) { return this.db.issues.filter(item => !month || item.month === month).sort((a, b) => b.month.localeCompare(a.month) || b.title.localeCompare(a.title)) }
  getIssue(id: string) { return this.db.issues.find(item => item.id === id) }
  getWork(id: string) { return this.db.works.find(item => item.id === id) }
  searchWorks(filters: { month?: string; author?: string; text?: string } = {}) {
    const text = filters.text?.toLocaleLowerCase()
    return this.db.works.filter(item => (!filters.month || item.month === filters.month) && (!filters.author || item.author.localeCompare(filters.author, undefined, { sensitivity: 'base' }) === 0) && (!text || `${item.title} ${item.author} ${item.description ?? ''}`.toLocaleLowerCase().includes(text))).sort((a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title))
  }

  async retryPending() {
    for (const item of [...this.db.issues, ...this.db.works]) {
      if (item.attachment?.r2 && item.attachment.r2.syncState !== 'synced') await this.local.sync(item.attachment)
    }
  }
  async recover(item: NewspaperIssue | Work) { return item.attachment ? this.local.read(item.attachment) : undefined }

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

export function apply(ctx: Context, config: Config) {
  const service = new ArchiveService({ config })
  ;(ctx as any).archive = service
  const root = ctx.command('archive', '月度报纸与作品归档')
  root.subcommand('.issues [month:text]', '按月份浏览 Newspaper Issue').action(async ({ session }, month) => {
    const items = service.listIssues(month)
    return items.length ? items.map(item => `${item.id} ${item.month} ${item.title}`).join('\n') : '没有找到 Newspaper Issue。'
  })
  root.subcommand('.works [query:text]', '查询 Work').action(async ({ session }, query) => {
    const items = service.searchWorks({ text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title} (${item.month})`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.work-query [month:text] [author:text] [query:text]', '按月份、作者或文本查询 Work').action(async ({ session }, month, author, query) => {
    const items = service.searchWorks({ month, author, text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title} (${item.month})`).join('\n') : '没有找到 Work。'
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
    const item = await service.publishIssue(commandSession(session), payload(metadata))
    return `已发布 Newspaper Issue ${item.id}。`
  })
  root.subcommand('.work-publish <metadata:text>', '发布 Work').action(async ({ session }, metadata) => {
    const item = await service.publishWork(commandSession(session), payload(metadata))
    return `已发布 Work ${item.id}。`
  })
  root.subcommand('.issue-edit <id:string> <confirmation:string> <patch:text>', '编辑 Newspaper Issue 元数据').action(({ session }, id, confirmation, patch) => {
    return `已更新 Newspaper Issue ${service.updateIssue(commandSession(session), id, payload(patch), confirmation).id}。`
  })
  root.subcommand('.work-edit <id:string> <confirmation:string> <patch:text>', '编辑 Work 元数据').action(({ session }, id, confirmation, patch) => {
    return `已更新 Work ${service.updateWork(commandSession(session), id, payload(patch), confirmation).id}。`
  })
  root.subcommand('.issue-remove <id:string> <confirmation:string>', '删除 Newspaper Issue').action(({ session }, id, confirmation) => {
    service.removeIssue(commandSession(session), id, confirmation)
    return `已删除 Newspaper Issue ${id}。`
  })
  root.subcommand('.work-remove <id:string> <confirmation:string>', '删除 Work').action(({ session }, id, confirmation) => {
    service.removeWork(commandSession(session), id, confirmation)
    return `已删除 Work ${id}。`
  })
  root.subcommand('.retry', '重试附件 R2 同步').action(async ({ session }) => { service.requireAdmin(commandSession(session)); await service.retryPending(); return '已重试待同步附件。' })
  return service
}
