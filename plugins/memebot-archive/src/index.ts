import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Context, h, Schema } from 'koishi'
import { ArchiveBackupJob, ArchiveCleanupJob, ArchivePreflight, BackupContext, BackupStatusSink, PersistentArchiveBackupQueue, PersistentArchiveCleanupQueue, safeArchiveDiagnostic, WorkPreviewStore } from './extensions'
import { PayloadArchiveReadAdapter, PayloadArchiveReadError, sendPayloadWork, type PayloadArchiveReadConfig } from './payload-read'
import { S3R2Store } from './s3'

export { ArchivePreflight, PersistentArchiveBackupQueue, PersistentArchiveCleanupQueue, WorkPreviewStore } from './extensions'
export { PayloadArchiveReadAdapter, PayloadArchiveReadError, sendPayloadWork } from './payload-read'
export type { PayloadArchiveReadConfig } from './payload-read'

export const name = 'memebot-archive'
// Keep the legacy declaration exported for callers that inspect the plugin
// contract. The runtime declaration below makes Access optional for the
// Payload read-only mode while retaining it for the legacy local mode.
export const inject = ['database', 'console', 'access']
const runtimeInject = { optional: ['database', 'console', 'access'] }

export interface AccessSession {
  userId?: string
  guildId?: string
  channelId?: string
  user?: { authority?: number }
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'identity' | 'location'; message: string }

interface ArchiveAccessService {
  authorizeRead(session: AccessSession): Promise<AccessDecision>
  authorizeWrite(session: AccessSession): Promise<AccessDecision>
}

type ArchiveAccessContext = { access: ArchiveAccessService }

export interface Config {
  localPath: string
  paperMaxMb: number
  workMaxMb: number
  payload?: PayloadArchiveReadConfig
  r2: {
    enabled: boolean
    accountId: string
    bucketName: string
    accessKeyId: string
    secretAccessKey: string
    objectPrefix: string
  }
}

export const Config: Schema<Config> = Schema.object({
  localPath: Schema.string().default('data/memebot-archive').description('附件本地存储目录'),
  paperMaxMb: Schema.number().default(100).min(1).description('Paper PDF 最大大小（MB）'),
  workMaxMb: Schema.number().default(500).min(1).description('Work ZIP 最大大小（MB）'),
  payload: Schema.object({
    enabled: Schema.boolean().default(false).description('从独立 Payload Archive 读取 Work'),
    baseUrl: Schema.string().default('').description('Payload Archive 基础 URL'),
    serviceToken: Schema.string().role('secret').default('').description('Payload Archive machine credential'),
    timeoutMs: Schema.number().default(10_000).min(100).max(120_000),
  }).default({ enabled: false, baseUrl: '', serviceToken: '', timeoutMs: 10_000 }),
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
  lifecycle?: 'active' | 'removed' | 'purged'
  removedAt?: Date
  expiresAt?: Date
  purgedAt?: Date
  anonymizedAt?: Date
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
  lifecycle?: 'active' | 'removed' | 'purged'
  removedAt?: Date
  expiresAt?: Date
  purgedAt?: Date
  anonymizedAt?: Date
  backupState?: 'disabled' | 'pending' | 'failed' | 'complete'
  backupError?: string
}

export interface PublicationAppearance {
  paperId: string
  workId: string
  page?: string
  section?: string
  displayOrder: number
  createdAt: Date
  updatedAt: Date
}

export interface RetiredArchiveAttachment {
  id: string
  recordKind: ArchiveRecordKind
  recordId: string
  attachment: Attachment
  lifecycle: 'retired' | 'restored' | 'purged'
  removedAt: Date
  expiresAt: Date
  restoredAt?: Date
  purgedAt?: Date
}

export interface ArchiveLifecycleAuditEntry {
  id: string
  actor: string
  recordKind: ArchiveRecordKind
  recordId: string
  action: 'remove' | 'restore' | 'purge' | 'anonymize'
  details: string
  createdAt: Date
}

export type ArchiveRecordKind = 'paper' | 'work'

export interface ArchiveManifest {
  schemaVersion: 1
  recordKind: ArchiveRecordKind
  sequence: number
  record: NewspaperIssue | Work
  appearances: PublicationAppearance[]
}

export interface RestoreSelection {
  recordKind: ArchiveRecordKind
  recordId: string
  decision: 'local' | 'r2'
}

export interface RestorePreviewEntry {
  recordKind: ArchiveRecordKind
  recordId: string
  status: 'new' | 'unchanged' | 'changed' | 'conflicting'
  missingAttachment: boolean
  local?: NewspaperIssue | Work
  remote: NewspaperIssue | Work
}

export interface RestoreAuditEntry {
  id: string
  actor: string
  action: 'preview' | 'restore'
  result: 'complete' | 'failed'
  details: string
  createdAt: Date
}

export interface ArchiveDatabase {
  issues: NewspaperIssue[]
  works: Work[]
  appearances: PublicationAppearance[]
  retiredAttachments: RetiredArchiveAttachment[]
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
      lifecycle: 'active' | 'removed' | 'purged'
      removedAt: Date
      expiresAt: Date
      purgedAt: Date
      anonymizedAt: Date
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
      lifecycle: 'active' | 'removed' | 'purged'
      removedAt: Date
      expiresAt: Date
      purgedAt: Date
      anonymizedAt: Date
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
    archiveCleanupJob: {
      id: string
      recordKind: 'paper' | 'work'
      recordId: string
      objectKeys: string
      state: 'pending' | 'failed' | 'complete'
      attempts: number
      nextAttemptAt: Date
      error: string
    }
    archiveRetiredAttachment: {
      id: string
      recordKind: 'paper' | 'work'
      recordId: string
      attachment: string
      lifecycle: 'retired' | 'restored' | 'purged'
      removedAt: Date
      expiresAt: Date
      restoredAt: Date
      purgedAt: Date
    }
    archiveLifecycleAudit: {
      id: string
      actor: string
      recordKind: 'paper' | 'work'
      recordId: string
      action: 'remove' | 'restore' | 'purge' | 'anonymize'
      details: string
      createdAt: Date
    }
    archivePublicationAppearance: {
      paperId: string
      workId: string
      page: string
      section: string
      displayOrder: number
      createdAt: Date
      updatedAt: Date
    }
    archiveRestoreAudit: {
      id: string
      actor: string
      action: 'preview' | 'restore'
      result: 'complete' | 'failed'
      details: string
      createdAt: Date
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
  loadAppearances(): Promise<PublicationAppearance[]>
  upsertAppearance(appearance: PublicationAppearance): Promise<void>
  removeAppearance(paperId: string, workId: string): Promise<void>
  loadRetiredAttachments(): Promise<RetiredArchiveAttachment[]>
  createRetiredAttachment(item: RetiredArchiveAttachment): Promise<void>
  updateRetiredAttachment(item: RetiredArchiveAttachment): Promise<void>
  appendLifecycleAudit(entry: ArchiveLifecycleAuditEntry): Promise<void>
  loadLifecycleAudit(): Promise<ArchiveLifecycleAuditEntry[]>
  importRecord(kind: ArchiveRecordKind, item: NewspaperIssue | Work, manifest: ArchiveManifest): Promise<void>
  importRecords(records: Array<{ kind: ArchiveRecordKind; item: NewspaperIssue | Work; manifest: ArchiveManifest }>): Promise<void>
  appendRestoreAudit(entry: RestoreAuditEntry): Promise<void>
  loadRestoreAudit(): Promise<RestoreAuditEntry[]>
}

export class KoishiArchiveMetadataRepository implements ArchiveMetadataRepository {
  constructor(private readonly ctx: Context) {}
  async loadPapers() {
    const rows = await this.ctx.model.get('archivePaper', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), issueNumber: String(row.issueNumber), month: String(row.month), title: String(row.title),
      description: String(row.description || '') || undefined, sourceLink: String(row.sourceLink || '') || undefined,
      attachment: row.attachment ? JSON.parse(String(row.attachment)) : undefined,
      lifecycle: (row.lifecycle || 'active') as 'active' | 'removed' | 'purged',
      removedAt: row.removedAt ? new Date(row.removedAt as string | number) : undefined,
      expiresAt: row.expiresAt ? new Date(row.expiresAt as string | number) : undefined,
      purgedAt: row.purgedAt ? new Date(row.purgedAt as string | number) : undefined,
      anonymizedAt: row.anonymizedAt ? new Date(row.anonymizedAt as string | number) : undefined,
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
      lifecycle: paper.lifecycle ?? 'active', removedAt: paper.removedAt, expiresAt: paper.expiresAt, purgedAt: paper.purgedAt, anonymizedAt: paper.anonymizedAt,
      backupState: paper.backupState ?? 'disabled', backupError: paper.backupError ?? '', publishedAt: paper.publishedAt, updatedAt: now,
    })
  }
  async updatePaper(paper: NewspaperIssue) {
    await this.ctx.model.set('archivePaper', { id: paper.id }, {
      issueNumber: paper.issueNumber, month: paper.month, title: paper.title,
      description: paper.description ?? '', sourceLink: paper.sourceLink ?? '', attachment: JSON.stringify(paper.attachment),
      lifecycle: paper.lifecycle ?? 'active', removedAt: paper.removedAt, expiresAt: paper.expiresAt, purgedAt: paper.purgedAt, anonymizedAt: paper.anonymizedAt,
      backupState: paper.backupState ?? 'disabled', backupError: paper.backupError ?? '', updatedAt: paper.updatedAt ?? new Date(),
    })
  }
  async loadWorks() {
    const rows = await this.ctx.model.get('archiveWork', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), title: String(row.title), author: String(row.author), description: String(row.description || '') || undefined,
      attachment: row.attachment ? JSON.parse(String(row.attachment)) : undefined, lifecycle: (row.lifecycle || 'active') as 'active' | 'removed' | 'purged',
      removedAt: row.removedAt ? new Date(row.removedAt as string | number) : undefined,
      expiresAt: row.expiresAt ? new Date(row.expiresAt as string | number) : undefined,
      purgedAt: row.purgedAt ? new Date(row.purgedAt as string | number) : undefined,
      anonymizedAt: row.anonymizedAt ? new Date(row.anonymizedAt as string | number) : undefined,
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
      removedAt: work.removedAt, expiresAt: work.expiresAt, purgedAt: work.purgedAt, anonymizedAt: work.anonymizedAt,
      backupState: work.backupState ?? 'disabled', backupError: work.backupError ?? '', publishedAt: work.publishedAt, updatedAt: work.updatedAt ?? work.publishedAt,
    })
  }
  async updateWork(work: Work) {
    await this.ctx.model.set('archiveWork', { id: work.id }, {
      title: work.title, author: work.author, description: work.description ?? '', attachment: JSON.stringify(work.attachment), lifecycle: work.lifecycle ?? 'active',
      removedAt: work.removedAt, expiresAt: work.expiresAt, purgedAt: work.purgedAt, anonymizedAt: work.anonymizedAt,
      backupState: work.backupState ?? 'disabled', backupError: work.backupError ?? '', updatedAt: work.updatedAt ?? new Date(),
    })
  }
  async updateBackupState(kind: 'paper' | 'work', id: string, state: 'pending' | 'failed' | 'complete', error?: string) {
    const table = kind === 'paper' ? 'archivePaper' : 'archiveWork'
    await this.ctx.model.set(table, { id }, { backupState: state, backupError: error ?? '', updatedAt: new Date() } as any)
  }
  async loadAppearances() {
    const rows = await this.ctx.model.get('archivePublicationAppearance', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      paperId: String(row.paperId), workId: String(row.workId), page: String(row.page || '') || undefined, section: String(row.section || '') || undefined,
      displayOrder: Number(row.displayOrder || 0), createdAt: new Date(row.createdAt as string | number), updatedAt: new Date(row.updatedAt as string | number),
    }))
  }
  async upsertAppearance(appearance: PublicationAppearance) {
    const query = { paperId: appearance.paperId, workId: appearance.workId }
    const rows = await this.ctx.model.get('archivePublicationAppearance', query) as unknown[]
    const data = { page: appearance.page ?? '', section: appearance.section ?? '', displayOrder: appearance.displayOrder, updatedAt: appearance.updatedAt }
    if (rows[0]) await this.ctx.model.set('archivePublicationAppearance', query, data)
    else await this.ctx.model.create('archivePublicationAppearance', { ...query, ...data, createdAt: appearance.createdAt })
  }
  async removeAppearance(paperId: string, workId: string) {
    await this.ctx.model.remove('archivePublicationAppearance', { paperId, workId })
  }
  async loadRetiredAttachments() {
    const rows = await this.ctx.model.get('archiveRetiredAttachment', {}) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: String(row.id), recordKind: row.recordKind as ArchiveRecordKind, recordId: String(row.recordId), attachment: JSON.parse(String(row.attachment)),
      lifecycle: row.lifecycle as RetiredArchiveAttachment['lifecycle'], removedAt: new Date(row.removedAt as string | number), expiresAt: new Date(row.expiresAt as string | number),
      restoredAt: row.restoredAt ? new Date(row.restoredAt as string | number) : undefined, purgedAt: row.purgedAt ? new Date(row.purgedAt as string | number) : undefined,
    }))
  }
  async createRetiredAttachment(item: RetiredArchiveAttachment) {
    await this.ctx.model.create('archiveRetiredAttachment', { ...item, attachment: JSON.stringify(item.attachment), restoredAt: item.restoredAt, purgedAt: item.purgedAt })
  }
  async updateRetiredAttachment(item: RetiredArchiveAttachment) {
    await this.ctx.model.set('archiveRetiredAttachment', { id: item.id }, { attachment: JSON.stringify(item.attachment), lifecycle: item.lifecycle, restoredAt: item.restoredAt, purgedAt: item.purgedAt })
  }
  async appendLifecycleAudit(entry: ArchiveLifecycleAuditEntry) { await this.ctx.model.create('archiveLifecycleAudit', { ...entry }) }
  async loadLifecycleAudit() {
    const rows = await this.ctx.model.get('archiveLifecycleAudit', {}) as unknown as ArchiveLifecycleAuditEntry[]
    return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt) })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  }
  async importRecord(kind: ArchiveRecordKind, item: NewspaperIssue | Work, manifest: ArchiveManifest) {
    const existing = kind === 'paper'
      ? await this.ctx.model.get('archivePaper', { id: item.id })
      : await this.ctx.model.get('archiveWork', { id: item.id })
    const restored = { ...item, backupState: 'complete' as const, backupError: undefined }
    if (kind === 'paper') {
      if (existing[0]) await this.updatePaper(restored as NewspaperIssue)
      else await this.createPaper(restored as NewspaperIssue)
    } else if (existing[0]) await this.updateWork(restored as Work)
    else await this.createWork(restored as Work)
    const sequenceKind = kind === 'paper' ? 'paper' : 'work'
    const sequences = await this.ctx.model.get('archiveSequence', { kind: sequenceKind }) as unknown as Array<{ value: number }>
    if (!sequences[0]) await this.ctx.model.create('archiveSequence', { kind: sequenceKind, value: manifest.sequence })
    else if (sequences[0].value < manifest.sequence) await this.ctx.model.set('archiveSequence', { kind: sequenceKind }, { value: manifest.sequence })
    const attachment = restored.attachment
    if (attachment) {
      const id = createHash('sha256').update(`${kind}\0${item.id}\0${attachment.relativePath}`).digest('hex')
      const job = await this.ctx.model.get('archiveBackupJob', { id }) as unknown[]
      const data = { recordKind: kind, recordId: item.id, attachment: JSON.stringify(attachment), manifest: JSON.stringify(manifest), state: 'complete' as const, attempts: 0, nextAttemptAt: new Date(), error: '' }
      if (job[0]) await this.ctx.model.set('archiveBackupJob', { id }, data)
      else await this.ctx.model.create('archiveBackupJob', { id, ...data })
    }
  }
  async importRecords(records: Array<{ kind: ArchiveRecordKind; item: NewspaperIssue | Work; manifest: ArchiveManifest }>) {
    const importInto = async (repository: KoishiArchiveMetadataRepository) => {
      for (const record of records) await repository.importRecord(record.kind, record.item, record.manifest)
      const appearances = new Map<string, PublicationAppearance>()
      for (const record of records) for (const appearance of record.manifest.appearances) appearances.set(`${appearance.paperId}:${appearance.workId}`, appearance)
      for (const appearance of appearances.values()) {
        const [papers, works] = await Promise.all([repository.ctx.model.get('archivePaper', { id: appearance.paperId }), repository.ctx.model.get('archiveWork', { id: appearance.workId })])
        if (papers[0] && works[0]) await repository.upsertAppearance(appearance)
      }
    }
    const database = (this.ctx as any).database
    if (database?.withTransaction) {
      await database.withTransaction(async (transaction: any) => {
        const repository = new KoishiArchiveMetadataRepository({ model: transaction } as Context)
        await importInto(repository)
      })
      return
    }
    await importInto(this)
  }
  async appendRestoreAudit(entry: RestoreAuditEntry) { await this.ctx.model.create('archiveRestoreAudit', { ...entry }) }
  async loadRestoreAudit() {
    const rows = await this.ctx.model.get('archiveRestoreAudit', {}) as unknown as RestoreAuditEntry[]
    return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt) })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
  }
}

export interface R2Store {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
  delete(key: string): Promise<void>
  list?(prefix: string): Promise<string[]>
}

export interface ArchiveBackupQueue {
  enqueue(attachment: Attachment, context?: BackupContext): Promise<void>
  runDue?(): Promise<void>
  retryNow?(recordId?: string): Promise<void>
  counts?(): Promise<{ pending: number; failed: number; complete: number }>
  list?(recordId?: string): Promise<ArchiveBackupJob[]>
}

export interface ArchiveCleanupQueue {
  enqueue(recordKind: ArchiveRecordKind, recordId: string, objectKeys: string[]): Promise<void>
  runDue?(): Promise<void>
  retryNow?(recordId?: string): Promise<void>
  counts?(): Promise<{ pending: number; failed: number; complete: number }>
  list?(recordId?: string): Promise<ArchiveCleanupJob[]>
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

export interface AppearanceInput {
  workId?: string
  work?: WorkInput
  page?: string
  section?: string
  displayOrder?: number
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
  async list(prefix: string) { return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort() }
}

export class LocalAttachmentStore {
  constructor(readonly root: string, readonly r2?: R2Store, readonly objectPrefix = 'memebot-archive') {}

  async save(id: string, input: AttachmentInput, version?: string): Promise<Attachment> {
    const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const relativePath = join(id, version ? `${version}-${safeName}` : safeName).replaceAll('\\', '/')
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
      if (createHash('sha256').update(data).digest('hex') !== attachment.checksum) throw new Error(`R2 attachment checksum mismatch: ${attachment.relativePath}`)
      await this.restore(attachment, data)
      return data
    }
  }

  async exists(attachment: Attachment) {
    try { await access(this.fullPath(attachment.relativePath)); return true } catch { return false }
  }

  async restore(attachment: Attachment, data: Uint8Array) {
    const checksum = createHash('sha256').update(data).digest('hex')
    if (checksum !== attachment.checksum) throw new Error(`attachment checksum mismatch: ${attachment.relativePath}`)
    const target = this.fullPath(attachment.relativePath)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await writeFile(temporary, data)
    await rename(temporary, target)
  }

  async stageRestore(attachment: Attachment, data: Uint8Array) {
    const checksum = createHash('sha256').update(data).digest('hex')
    if (checksum !== attachment.checksum) throw new Error(`attachment checksum mismatch: ${attachment.relativePath}`)
    const target = this.fullPath(attachment.relativePath)
    await mkdir(dirname(target), { recursive: true })
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const temporary = `${target}.restore-${nonce}`; const backup = `${target}.restore-backup-${nonce}`
    await writeFile(temporary, data)
    let original = false; let committed = false
    return {
      commit: async () => {
        original = await this.fileExists(target)
        if (original) await rename(target, backup)
        try { await rename(temporary, target); committed = true } catch (error) { if (original) await rename(backup, target).catch(() => undefined); throw error }
      },
      rollback: async () => {
        if (committed) await unlink(target).catch(() => undefined)
        else await unlink(temporary).catch(() => undefined)
        if (original) await rename(backup, target).catch(() => undefined)
      },
      finish: async () => { await unlink(temporary).catch(() => undefined); await unlink(backup).catch(() => undefined) },
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
      attachment.r2.error = safeArchiveDiagnostic(error)
    }
    return attachment
  }
  async delete(attachment: Attachment) { await unlink(this.fullPath(attachment.relativePath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
  private fullPath(relativePath: string) {
    const root = resolve(this.root)
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(root + sep)) throw new Error('unsafe attachment path')
    return target
  }
  private async fileExists(path: string) { try { await access(path); return true } catch { return false } }
}

export class ImmediateArchiveBackupQueue implements ArchiveBackupQueue {
  constructor(private readonly local: LocalAttachmentStore) {}
  async enqueue(attachment: Attachment) { await this.local.sync(attachment) }
}

export class ArchiveService {
  // User-facing entry points authorize once through Access or Console before
  // entering this trusted domain layer, so an admitted interaction can finish
  // even if authorization changes while it is running.
  readonly db: ArchiveDatabase
  readonly local: LocalAttachmentStore
  readonly config: Config
  private paperSequence = 0
  private workSequence = 0
  private restoreAuditSequence = 0
  private lifecycleAuditSequence = 0
  private readonly metadata?: ArchiveMetadataRepository
  private readonly backupQueue?: ArchiveBackupQueue
  private readonly r2?: R2Store
  private readonly cleanupQueue?: ArchiveCleanupQueue
  private readonly now: () => Date
  readonly previews: WorkPreviewStore
  readonly fallbackEvents: Array<{ id: string; kind: 'issue' | 'work'; reason: string }> = []

  constructor(options: { config?: Partial<Config>; db?: Partial<ArchiveDatabase>; local?: LocalAttachmentStore; r2?: R2Store; metadata?: ArchiveMetadataRepository; backupQueue?: ArchiveBackupQueue; cleanupQueue?: ArchiveCleanupQueue; previews?: WorkPreviewStore; now?: () => Date }) {
    this.config = {
      localPath: 'data/memebot-archive', paperMaxMb: 100, workMaxMb: 500,
      r2: { enabled: false, accountId: '', bucketName: '', accessKeyId: '', secretAccessKey: '', objectPrefix: 'memebot-archive' },
      ...options.config,
    }
    this.db = { issues: options.db?.issues ?? [], works: options.db?.works ?? [], appearances: options.db?.appearances ?? [], retiredAttachments: options.db?.retiredAttachments ?? [] }
    this.local = options.local ?? new LocalAttachmentStore(this.config.localPath, options.r2, this.config.r2.objectPrefix)
    this.previews = options.previews ?? new WorkPreviewStore(join(this.config.localPath, '.previews'))
    this.metadata = options.metadata
    this.r2 = options.r2
    this.backupQueue = options.backupQueue ?? (options.r2 ? new ImmediateArchiveBackupQueue(this.local) : undefined)
    this.cleanupQueue = options.cleanupQueue
    this.now = options.now ?? (() => new Date())
  }

  async initialize() {
    if (!this.metadata) return
    const [papers, works, appearances, retiredAttachments] = await Promise.all([this.metadata.loadPapers(), this.metadata.loadWorks(), this.metadata.loadAppearances(), this.metadata.loadRetiredAttachments()])
    const addedPapers = this.db.issues.filter(item => !papers.some(paper => paper.id === item.id))
    const addedWorks = this.db.works.filter(item => !works.some(work => work.id === item.id))
    this.db.issues.splice(0, this.db.issues.length, ...papers, ...addedPapers)
    this.db.works.splice(0, this.db.works.length, ...works, ...addedWorks)
    this.db.appearances.splice(0, this.db.appearances.length, ...appearances)
    this.db.retiredAttachments.splice(0, this.db.retiredAttachments.length, ...retiredAttachments)
  }

  private id(prefix: 'P' | 'W') { return prefix === 'P' ? `P${++this.paperSequence}` : `W${++this.workSequence}` }
  previewIssue(input: IssueInput) { return { ...input, kind: 'Newspaper Issue' as const, preview: true } }
  previewWork(input: WorkInput) { return { ...input, kind: 'Work' as const, preview: true } }

  async publishIssue(session: ArchiveSession, input: IssueInput): Promise<NewspaperIssue> {
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
      await this.backupQueue.enqueue(issue.attachment, { recordKind: 'paper', recordId: issue.id, manifest: this.manifest('paper', issue) })
      if (this.backupQueue.runDue) void this.backupQueue.runDue()
    }
    return issue
  }

  async publishWork(session: ArchiveSession, input: WorkInput): Promise<Work> {
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
      await this.backupQueue.enqueue(work.attachment, { recordKind: 'work', recordId: work.id, manifest: this.manifest('work', work) })
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
    if (issue.attachment && this.backupQueue) issue.backupState = 'pending'
    if (this.metadata) await this.metadata.updatePaper(issue)
    if (issue.attachment && this.backupQueue) await this.enqueueBackup('paper', issue)
    return issue
  }
  async replaceIssueAttachment(session: ArchiveSession, id: string, attachmentInput: AttachmentInput) {
    const issue = this.getIssue(id)
    if (!issue) throw new Error('Newspaper Issue not found')
    validatePdfAttachment(attachmentInput, this.config.paperMaxMb)
    const previous = issue.attachment
    const replacement = await this.local.save(issue.id, attachmentInput, `v${this.now().getTime()}`)
    if (previous) await this.retireAttachment('paper', issue.id, previous)
    issue.attachment = replacement
    issue.updatedAt = new Date(); issue.backupState = this.backupQueue ? 'pending' : 'disabled'; delete issue.backupError
    if (this.metadata) await this.metadata.updatePaper(issue)
    if (this.backupQueue) await this.enqueueBackup('paper', issue)
    return issue
  }
  async updateWork(session: ArchiveSession, id: string, patch: Partial<Omit<WorkInput, 'attachment'>>, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const work = this.getWork(id)
    if (!work) throw new Error('Work not found')
    Object.assign(work, validateWorkMetadata({ ...work, ...patch }))
    work.updatedAt = new Date()
    if (work.attachment && this.backupQueue) work.backupState = 'pending'
    if (this.metadata) await this.metadata.updateWork(work)
    if (work.attachment && this.backupQueue) await this.enqueueBackup('work', work)
    return work
  }
  async replaceWorkAttachment(session: ArchiveSession, id: string, attachmentInput: AttachmentInput) {
    const work = this.getWork(id)
    if (!work) throw new Error('Work not found')
    const data = workBytes(attachmentInput, this.config.workMaxMb)
    await this.previews.build(work.id, data)
    const previous = work.attachment
    const replacement = await this.local.save(work.id, { ...attachmentInput, data }, `v${this.now().getTime()}`)
    if (previous) await this.retireAttachment('work', work.id, previous)
    work.attachment = replacement
    work.updatedAt = new Date(); work.backupState = this.backupQueue ? 'pending' : 'disabled'; delete work.backupError
    if (this.metadata) await this.metadata.updateWork(work)
    if (this.backupQueue) await this.enqueueBackup('work', work)
    return work
  }
  async removeIssue(session: ArchiveSession, id: string, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const issue = this.getIssue(id)
    if (!issue) throw new Error('Newspaper Issue not found')
    const removedAt = this.now()
    issue.lifecycle = 'removed'; issue.removedAt = removedAt; issue.expiresAt = new Date(removedAt.getTime() + 30 * 24 * 60 * 60_000); issue.updatedAt = removedAt
    if (this.metadata) await this.metadata.updatePaper(issue)
    if (issue.attachment && this.backupQueue) await this.enqueueBackup('paper', issue)
    await this.appendLifecycleAudit(session, 'paper', issue.id, 'remove', { expiresAt: issue.expiresAt })
    return issue
  }
  async removeWork(session: ArchiveSession, id: string, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const work = this.getWork(id)
    if (!work) throw new Error('Work not found')
    const removedAt = this.now()
    work.lifecycle = 'removed'; work.removedAt = removedAt; work.expiresAt = new Date(removedAt.getTime() + 30 * 24 * 60 * 60_000); work.updatedAt = removedAt
    if (this.metadata) await this.metadata.updateWork(work)
    if (work.attachment && this.backupQueue) await this.enqueueBackup('work', work)
    await this.appendLifecycleAudit(session, 'work', work.id, 'remove', { expiresAt: work.expiresAt })
    return work
  }

  listRemoved(session: ArchiveSession) {
    return [
      ...this.db.issues.filter(item => item.lifecycle === 'removed' || item.lifecycle === 'purged').map(item => ({ kind: 'paper' as const, id: item.id, title: item.title, lifecycle: item.lifecycle, removedAt: item.removedAt, expiresAt: item.expiresAt, purgedAt: item.purgedAt })),
      ...this.db.works.filter(item => item.lifecycle === 'removed' || item.lifecycle === 'purged').map(item => ({ kind: 'work' as const, id: item.id, title: item.title, author: item.author, lifecycle: item.lifecycle, removedAt: item.removedAt, expiresAt: item.expiresAt, purgedAt: item.purgedAt })),
    ].sort((a, b) => (b.removedAt?.getTime() ?? 0) - (a.removedAt?.getTime() ?? 0) || a.id.localeCompare(b.id))
  }

  async restoreRecord(session: ArchiveSession, id: string) {
    const item = id.toUpperCase().startsWith('P')
      ? this.db.issues.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && value.lifecycle === 'removed')
      : this.db.works.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && value.lifecycle === 'removed')
    if (!item) throw new Error('Removed Archive record not found')
    item.lifecycle = 'active'; delete item.removedAt; delete item.expiresAt; item.updatedAt = this.now()
    if (item.id.startsWith('P')) await this.metadata?.updatePaper(item as NewspaperIssue)
    else await this.metadata?.updateWork(item as Work)
    if (item.attachment && this.backupQueue) await this.enqueueBackup(item.id.startsWith('P') ? 'paper' : 'work', item)
    await this.appendLifecycleAudit(session, item.id.startsWith('P') ? 'paper' : 'work', item.id, 'restore')
    return item
  }

  async anonymizeRecord(session: ArchiveSession, id: string, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const kind: ArchiveRecordKind = id.toUpperCase().startsWith('P') ? 'paper' : 'work'
    const item = kind === 'paper'
      ? this.db.issues.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0)
      : this.db.works.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0)
    if (!item) throw new Error('Archive record not found')
    if (kind === 'paper') {
      const paper = item as NewspaperIssue
      paper.description = undefined; paper.sourceLink = undefined
      paper.anonymizedAt = this.now(); paper.updatedAt = paper.anonymizedAt
      await this.metadata?.updatePaper(paper)
    } else {
      const work = item as Work
      work.author = '已匿名'; work.description = undefined
      work.anonymizedAt = this.now(); work.updatedAt = work.anonymizedAt
      await this.metadata?.updateWork(work)
    }
    await this.appendLifecycleAudit(session, kind, item.id, 'anonymize')
    return item
  }

  async lifecycleHistory(session: ArchiveSession, recordId?: string) {
    const history = await this.metadata?.loadLifecycleAudit() ?? []
    return recordId ? history.filter(item => item.recordId.localeCompare(recordId, undefined, { sensitivity: 'base' }) === 0) : history
  }

  listRetiredAttachments(session: ArchiveSession, recordId?: string) {
    return this.db.retiredAttachments.filter(item => item.lifecycle === 'retired' && (!recordId || item.recordId.localeCompare(recordId, undefined, { sensitivity: 'base' }) === 0)).sort((a, b) => b.removedAt.getTime() - a.removedAt.getTime() || a.id.localeCompare(b.id))
  }

  async restoreRetiredAttachment(session: ArchiveSession, retiredId: string) {
    const retired = this.db.retiredAttachments.find(item => item.id === retiredId && item.lifecycle === 'retired')
    if (!retired || retired.expiresAt <= this.now()) throw new Error('Retired attachment not found or expired')
    const item = retired.recordKind === 'paper' ? this.getIssue(retired.recordId) : this.getWork(retired.recordId)
    if (!item?.attachment) throw new Error('Active Archive record not found')
    await this.retireAttachment(retired.recordKind, retired.recordId, item.attachment)
    item.attachment = retired.attachment; item.updatedAt = this.now(); item.backupState = this.backupQueue ? 'pending' : 'disabled'; delete item.backupError
    retired.lifecycle = 'restored'; retired.restoredAt = this.now()
    await this.metadata?.updateRetiredAttachment(retired)
    if (retired.recordKind === 'paper') await this.metadata?.updatePaper(item as NewspaperIssue)
    else {
      await this.previews.build(item.id, await this.local.read(item.attachment))
      await this.metadata?.updateWork(item as Work)
    }
    if (this.backupQueue) await this.enqueueBackup(retired.recordKind, item)
    return item
  }

  async purgeRecord(session: ArchiveSession, id: string, confirmation?: string) {
    this.requireConfirmation(session, confirmation)
    const item = id.toUpperCase().startsWith('P')
      ? this.db.issues.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && value.lifecycle === 'removed')
      : this.db.works.find(value => value.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && value.lifecycle === 'removed')
    if (!item) throw new Error('Removed Archive record not found')
    return this.purge(item, session.userId ?? `authority:${session.authority ?? 0}`)
  }

  async purgeExpired() {
    const expired = [...this.db.issues, ...this.db.works].filter(item => item.lifecycle === 'removed' && !!item.expiresAt && item.expiresAt <= this.now())
    for (const item of expired) await this.purge(item, 'system:expiry')
    const retired = this.db.retiredAttachments.filter(item => item.lifecycle === 'retired' && item.expiresAt <= this.now())
    for (const item of retired) {
      if (this.cleanupQueue && item.attachment.r2?.objectKey) await this.cleanupQueue.enqueue(item.recordKind, item.recordId, [item.attachment.r2.objectKey])
      await this.local.delete(item.attachment)
      item.lifecycle = 'purged'; item.purgedAt = this.now()
      await this.metadata?.updateRetiredAttachment(item)
    }
    if (retired.length && this.cleanupQueue?.runDue) await this.cleanupQueue.runDue()
    return expired.length + retired.length
  }

  private async purge(item: NewspaperIssue | Work, actor: string) {
    const kind: ArchiveRecordKind = item.id.startsWith('P') ? 'paper' : 'work'
    const attachment = item.attachment
    if (attachment && this.cleanupQueue) {
      const prefix = this.config.r2.objectPrefix.replace(/^\/+|\/+$/g, '')
      await this.cleanupQueue.enqueue(kind, item.id, [attachment.r2?.objectKey ?? '', `${prefix}/manifests/${kind}/${item.id}.json`])
    }
    if (attachment) await this.local.delete(attachment)
    if (kind === 'work') await this.previews.remove(item.id)
    item.attachment = undefined; item.lifecycle = 'purged'; item.purgedAt = this.now(); item.updatedAt = item.purgedAt
    if (kind === 'paper') await this.metadata?.updatePaper(item as NewspaperIssue)
    else await this.metadata?.updateWork(item as Work)
    await this.appendLifecycleAudit({ userId: actor }, kind, item.id, 'purge')
    if (this.cleanupQueue?.runDue) await this.cleanupQueue.runDue()
    return item
  }

  private async retireAttachment(recordKind: ArchiveRecordKind, recordId: string, attachment: Attachment) {
    const removedAt = this.now()
    const retired: RetiredArchiveAttachment = {
      id: `${recordId}-${removedAt.getTime()}-${attachment.checksum.slice(0, 12)}`, recordKind, recordId,
      attachment: { ...attachment, r2: attachment.r2 && { ...attachment.r2 } }, lifecycle: 'retired', removedAt,
      expiresAt: new Date(removedAt.getTime() + 30 * 24 * 60 * 60_000),
    }
    await this.metadata?.createRetiredAttachment(retired)
    this.db.retiredAttachments.push(retired)
    return retired
  }

  private async appendLifecycleAudit(session: ArchiveSession, recordKind: ArchiveRecordKind, recordId: string, action: ArchiveLifecycleAuditEntry['action'], details: Record<string, unknown> = {}) {
    if (!this.metadata) return
    const createdAt = this.now()
    await this.metadata.appendLifecycleAudit({
      id: `${createdAt.getTime()}-${String(++this.lifecycleAuditSequence).padStart(6, '0')}`,
      actor: session.userId ?? `authority:${session.authority ?? 0}`, recordKind, recordId, action, details: JSON.stringify(details), createdAt,
    })
  }

  listIssues(month?: string) { return this.db.issues.filter(item => item.lifecycle !== 'removed' && item.lifecycle !== 'purged' && (!month || item.month === month)).sort((a, b) => b.month.localeCompare(a.month) || b.title.localeCompare(a.title)) }
  searchIssues(query?: string) {
    const text = query?.trim().toLocaleLowerCase()
    return this.listIssues().filter(item => {
      if (!text) return true
      const related = this.db.appearances
        .filter(appearance => appearance.paperId === item.id)
        .map(appearance => this.getWork(appearance.workId))
        .filter((work): work is Work => !!work)
        .map(work => `${work.title} ${work.author} ${work.description ?? ''}`)
        .join(' ')
      return `${item.month} ${item.issueNumber} ${item.title} ${item.description ?? ''} ${related}`.toLocaleLowerCase().includes(text)
    })
  }
  getIssue(id: string) { return this.db.issues.find(item => item.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && item.lifecycle !== 'removed' && item.lifecycle !== 'purged') }
  getWork(id: string) { return this.db.works.find(item => item.id.localeCompare(id, undefined, { sensitivity: 'base' }) === 0 && item.lifecycle !== 'removed' && item.lifecycle !== 'purged') }
  searchWorks(filters: { author?: string; text?: string } = {}) {
    const text = filters.text?.toLocaleLowerCase()
    return this.db.works.filter(item => item.lifecycle !== 'removed' && item.lifecycle !== 'purged' && (!filters.author || item.author.localeCompare(filters.author, undefined, { sensitivity: 'base' }) === 0) && (!text || `${item.title} ${item.author} ${item.description ?? ''}`.toLocaleLowerCase().includes(text))).sort((a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title))
  }

  async associateWork(session: ArchiveSession, paperId: string, input: AppearanceInput) {
    const paper = this.getIssue(paperId)
    if (!paper) throw new Error('Paper not found')
    if (!!input.workId === !!input.work) throw new Error('请选择现有 Work 或创建一个完整新 Work')
    const work = input.work ? await this.publishWork(session, input.work) : this.getWork(input.workId!)
    if (!work) throw new Error('Work not found')
    const existing = this.db.appearances.find(item => item.paperId === paper.id && item.workId === work.id)
    const now = new Date()
    const displayOrder = input.displayOrder ?? existing?.displayOrder ?? (Math.max(0, ...this.db.appearances.filter(item => item.paperId === paper.id).map(item => item.displayOrder)) + 1)
    if (!Number.isSafeInteger(displayOrder) || displayOrder < 0) throw new Error('displayOrder 必须是非负整数')
    const appearance: PublicationAppearance = {
      paperId: paper.id, workId: work.id, page: input.page?.trim() || undefined, section: input.section?.trim() || undefined,
      displayOrder, createdAt: existing?.createdAt ?? now, updatedAt: now,
    }
    if (this.metadata) await this.metadata.upsertAppearance(appearance)
    if (existing) Object.assign(existing, appearance)
    else this.db.appearances.push(appearance)
    if (paper.attachment && this.backupQueue) await this.enqueueBackup('paper', paper)
    if (work.attachment && this.backupQueue) await this.enqueueBackup('work', work)
    return appearance
  }

  async removeAppearance(session: ArchiveSession, paperId: string, workId: string) {
    const paper = this.getIssue(paperId); const work = this.getWork(workId)
    if (!paper || !work) throw new Error('Publication Appearance not found')
    const index = this.db.appearances.findIndex(item => item.paperId === paper.id && item.workId === work.id)
    if (index < 0) throw new Error('Publication Appearance not found')
    if (this.metadata) await this.metadata.removeAppearance(paper.id, work.id)
    this.db.appearances.splice(index, 1)
    if (paper?.attachment && this.backupQueue) await this.enqueueBackup('paper', paper)
    if (work?.attachment && this.backupQueue) await this.enqueueBackup('work', work)
  }

  getPaperDetails(id: string) {
    const paper = this.getIssue(id)
    if (!paper) return undefined
    const works = this.db.appearances
      .filter(item => item.paperId === paper.id)
      .map(appearance => ({ appearance, work: this.db.works.find(item => item.id === appearance.workId) }))
      .filter((item): item is { appearance: PublicationAppearance; work: Work } => !!item.work)
      .sort((a, b) => a.appearance.displayOrder - b.appearance.displayOrder || a.work.id.localeCompare(b.work.id))
      .map(({ appearance, work }) => work.lifecycle === 'removed' || work.lifecycle === 'purged'
        ? ({ work: { id: work.id, title: work.title, author: work.author, lifecycle: work.lifecycle }, page: appearance.page, section: appearance.section, displayOrder: appearance.displayOrder, unavailable: true })
        : ({ work, page: appearance.page, section: appearance.section, displayOrder: appearance.displayOrder }))
    return { paper, works }
  }

  getWorkDetails(id: string) {
    const work = this.getWork(id)
    if (!work) return undefined
    const papers = this.db.appearances
      .filter(item => item.workId === work.id)
      .map(appearance => ({ appearance, paper: this.getIssue(appearance.paperId) }))
      .filter((item): item is { appearance: PublicationAppearance; paper: NewspaperIssue } => !!item.paper)
      .sort((a, b) => b.paper.month.localeCompare(a.paper.month) || a.appearance.displayOrder - b.appearance.displayOrder || a.paper.id.localeCompare(b.paper.id))
      .map(({ appearance, paper }) => ({ paper, page: appearance.page, section: appearance.section, displayOrder: appearance.displayOrder }))
    return { work, papers }
  }

  paperDetailText(id: string) {
    const details = this.getPaperDetails(id)
    if (!details) return undefined
    const related = details.works.map(item => `- ${item.work.id} ${item.work.author} - ${item.work.title}${item.page ? ` · 第${item.page}页` : ''}${item.section ? ` · ${item.section}` : ''}`)
    return [`${details.paper.id} ${details.paper.month} 第${details.paper.issueNumber}期 ${details.paper.title}`, details.paper.description ?? '', ...(related.length ? ['收录作品：', ...related] : [])].filter(Boolean).join('\n')
  }

  workDetailText(id: string) {
    const details = this.getWorkDetails(id)
    if (!details) return undefined
    const related = details.papers.map(item => `- ${item.paper.id} ${item.paper.month} ${item.paper.title}${item.page ? ` · 第${item.page}页` : ''}${item.section ? ` · ${item.section}` : ''}`)
    return [`${details.work.id} ${details.work.author} - ${details.work.title}`, details.work.description ?? '', ...(related.length ? ['刊载于：', ...related] : [])].filter(Boolean).join('\n')
  }

  async previewRestore(session: ArchiveSession) {
    const auditBase = { actor: session.userId ?? `authority:${session.authority ?? 0}`, action: 'preview' as const }
    try {
      const preview = await this.buildRestorePreview(await this.readRemoteManifests())
      await this.appendAudit({ ...auditBase, result: 'complete', details: JSON.stringify(preview.counts) })
      return preview
    } catch (error) {
      const message = this.safeError(error)
      await this.appendAudit({ ...auditBase, result: 'failed', details: message }).catch(() => undefined)
      throw new Error(message)
    }
  }

  private async buildRestorePreview(manifests: ArchiveManifest[]) {
    const entries: RestorePreviewEntry[] = []
    for (const manifest of manifests) {
      const remote = manifest.record
      const local = manifest.recordKind === 'paper' ? this.db.issues.find(item => item.id === remote.id) : this.db.works.find(item => item.id === remote.id)
      const missingAttachment = !!remote.attachment && (!local?.attachment || !(await this.local.exists(local.attachment)))
      let status: RestorePreviewEntry['status'] = 'new'
      if (local) {
        const localChecksum = local.attachment?.checksum
        const remoteChecksum = remote.attachment?.checksum
        if (localChecksum !== remoteChecksum) status = 'conflicting'
        else status = this.recordFingerprint(local) === this.recordFingerprint(remote) ? 'unchanged' : 'changed'
      }
      entries.push({ recordKind: manifest.recordKind, recordId: remote.id, status, missingAttachment, local, remote })
    }
    return {
      counts: {
        new: entries.filter(item => item.status === 'new').length,
        changed: entries.filter(item => item.status === 'changed').length,
        conflicting: entries.filter(item => item.status === 'conflicting').length,
        missing: entries.filter(item => item.missingAttachment).length,
      },
      entries,
    }
  }

  async restoreFromR2(session: ArchiveSession, selections: RestoreSelection[] = []) {
    if (!this.metadata) throw new Error('restore requires persistent archive metadata')
    const auditBase = { actor: session.userId ?? `authority:${session.authority ?? 0}`, action: 'restore' as const }
    let staged: Array<Awaited<ReturnType<LocalAttachmentStore['stageRestore']>>> = []
    let metadataCommitted = false
    try {
      const manifests = await this.readRemoteManifests()
      const preview = await this.buildRestorePreview(manifests)
      const selected = new Map(selections.map(item => [`${item.recordKind}:${item.recordId}`, item.decision]))
      const downloads: Array<{ manifest: ArchiveManifest; record: NewspaperIssue | Work; attachment: Attachment; data: Uint8Array; importMetadata: boolean }> = []
      const decisions: Array<Record<string, unknown>> = []
      for (const entry of preview.entries) {
        const key = `${entry.recordKind}:${entry.recordId}`
        const decision = selected.get(key)
        if (decision === 'local') { decisions.push({ key, decision: 'local', status: entry.status }); continue }
        const manifest = manifests.find(item => item.recordKind === entry.recordKind && item.record.id === entry.recordId)!
        const importRemote = entry.status === 'new' || decision === 'r2'
        const repairLocal = !importRemote && entry.status !== 'conflicting' && entry.missingAttachment
        if (!importRemote && !repairLocal) { decisions.push({ key, decision: 'local', status: entry.status }); continue }
        const remoteAttachment = manifest.record.attachment
        const targetRecord = importRemote ? manifest.record : entry.local!
        const targetAttachment = targetRecord.attachment
        if (!remoteAttachment?.r2?.objectKey || !targetAttachment) throw new Error(`manifest attachment missing recovery location: ${key}`)
        const data = await this.r2!.get(remoteAttachment.r2.objectKey)
        if (!data) throw new Error(`R2 attachment missing: ${remoteAttachment.r2.objectKey}`)
        const checksum = createHash('sha256').update(data).digest('hex')
        if (checksum !== targetAttachment.checksum) throw new Error(`attachment checksum mismatch: ${key}`)
        downloads.push({ manifest, record: targetRecord, attachment: targetAttachment, data, importMetadata: importRemote })
        decisions.push({ key, decision: importRemote ? 'r2' : 'repair-attachment', status: entry.status })
      }
      for (const download of downloads) staged.push(await this.local.stageRestore(download.attachment, download.data))
      for (const item of staged) await item.commit()
      const imports = downloads.filter(download => download.importMetadata).map(download => ({ kind: download.manifest.recordKind, item: { ...download.record, backupState: 'complete' as const, backupError: undefined }, manifest: download.manifest }))
      await this.metadata.importRecords(imports)
      metadataCommitted = true
      for (const download of downloads) if (download.importMetadata) {
        const restored = { ...download.record, backupState: 'complete' as const, backupError: undefined }
        const items = download.manifest.recordKind === 'paper' ? this.db.issues : this.db.works
        const index = items.findIndex(item => item.id === restored.id)
        if (index < 0) (items as Array<NewspaperIssue | Work>).push(restored)
        else (items as Array<NewspaperIssue | Work>)[index] = restored
      }
      for (const appearance of imports.flatMap(item => item.manifest.appearances)) {
        if (!this.db.issues.some(item => item.id === appearance.paperId) || !this.db.works.some(item => item.id === appearance.workId)) continue
        const existing = this.db.appearances.find(item => item.paperId === appearance.paperId && item.workId === appearance.workId)
        if (existing) Object.assign(existing, appearance)
        else this.db.appearances.push(appearance)
      }
      await this.appendAudit({ ...auditBase, result: 'complete', details: JSON.stringify(decisions) })
      await Promise.all(staged.map(item => item.finish()))
      return { restored: downloads.length, decisions }
    } catch (error) {
      if (metadataCommitted) await Promise.all(staged.map(item => item.finish()))
      else await Promise.all([...staged].reverse().map(item => item.rollback()))
      const message = this.safeError(error)
      await this.appendAudit({ ...auditBase, result: 'failed', details: message }).catch(() => undefined)
      throw new Error(message)
    }
  }

  async restoreHistory(session: ArchiveSession) {
    return this.metadata?.loadRestoreAudit() ?? []
  }

  private async appendAudit(input: Omit<RestoreAuditEntry, 'id' | 'createdAt'>) {
    if (!this.metadata) return
    const createdAt = new Date()
    await this.metadata.appendRestoreAudit({ ...input, id: `${createdAt.getTime()}-${String(++this.restoreAuditSequence).padStart(6, '0')}`, createdAt })
  }

  private async readRemoteManifests() {
    try { return await this.readRemoteManifestsUnsafe() } catch (error) { throw new Error(this.safeError(error)) }
  }

  private async readRemoteManifestsUnsafe() {
    if (!this.r2?.list) throw new Error('R2 manifest listing is unavailable')
    const prefix = `${this.config.r2.objectPrefix.replace(/^\/+|\/+$/g, '')}/manifests/`
    const keys = await this.r2.list(prefix)
    const manifests: ArchiveManifest[] = []
    for (const key of keys.filter(key => key.endsWith('.json'))) {
      const bytes = await this.r2.get(key)
      if (!bytes) throw new Error(`R2 manifest missing: ${key}`)
      let raw: any
      try { raw = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error(`corrupt R2 manifest JSON: ${key}`) }
      const manifest = this.validateManifest(raw, key)
      manifests.push(manifest)
    }
    return manifests
  }

  private safeError(error: unknown) {
    let message = safeArchiveDiagnostic(error)
    for (const secret of [this.config.r2.accessKeyId, this.config.r2.secretAccessKey].filter(Boolean)) message = message.replaceAll(secret, '***')
    return message
  }

  private validateManifest(raw: any, key: string): ArchiveManifest {
    if (raw && raw.schemaVersion == null && typeof raw.id === 'string' && raw.attachment) {
      const match = /^(.*)\/manifests\/(paper|work)\/([PW]\d+)\.json$/.exec(key)
      if (match && raw.id === match[3]) {
        const objectKey = `${match[1]}/${String(raw.attachment.relativePath).replace(/^\/+/, '')}`
        raw = { schemaVersion: 1, recordKind: match[2], sequence: Number(raw.id.slice(1)), record: { ...raw, attachment: { ...raw.attachment, r2: { objectKey, syncState: 'synced' } } }, appearances: [] }
      }
    }
    if (!raw || raw.schemaVersion !== 1 || !['paper', 'work'].includes(raw.recordKind) || !raw.record || typeof raw.record !== 'object') throw new Error(`unsupported or corrupt R2 manifest: ${key}`)
    const recordKind = raw.recordKind as ArchiveRecordKind
    const id = String(raw.record.id ?? '')
    if (!new RegExp(`^${recordKind === 'paper' ? 'P' : 'W'}[1-9]\\d*$`).test(id)) throw new Error(`invalid record identifier in R2 manifest: ${key}`)
    if (!key.endsWith(`/manifests/${recordKind}/${id}.json`)) throw new Error(`R2 manifest key does not match record: ${key}`)
    const attachment = raw.record.attachment
    if (!attachment || typeof attachment.relativePath !== 'string' || !/^[a-f\d]{64}$/i.test(String(attachment.checksum)) || typeof attachment.r2?.objectKey !== 'string') throw new Error(`invalid attachment in R2 manifest: ${key}`)
    const common = {
      ...raw.record, id, attachment: { ...attachment, size: Number(attachment.size), r2: { ...attachment.r2, syncState: 'synced' as const } },
      publishedAt: new Date(raw.record.publishedAt), updatedAt: new Date(raw.record.updatedAt),
      lifecycle: raw.record.lifecycle === 'purged' ? 'purged' as const : raw.record.lifecycle === 'removed' ? 'removed' as const : 'active' as const, backupState: 'complete' as const, backupError: undefined,
    }
    if (Number.isNaN(common.publishedAt.getTime()) || Number.isNaN(common.updatedAt.getTime())) throw new Error(`invalid dates in R2 manifest: ${key}`)
    const appearances = Array.isArray(raw.appearances) ? raw.appearances.map((value: any) => {
      const paperId = String(value.paperId ?? ''); const workId = String(value.workId ?? ''); const displayOrder = Number(value.displayOrder)
      if (!/^P[1-9]\d*$/.test(paperId) || !/^W[1-9]\d*$/.test(workId) || !Number.isSafeInteger(displayOrder) || displayOrder < 0) throw new Error(`invalid Publication Appearance in R2 manifest: ${key}`)
      const createdAt = new Date(value.createdAt); const updatedAt = new Date(value.updatedAt)
      if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) throw new Error(`invalid Publication Appearance dates in R2 manifest: ${key}`)
      return { paperId, workId, page: String(value.page || '') || undefined, section: String(value.section || '') || undefined, displayOrder, createdAt, updatedAt }
    }) : []
    const record = recordKind === 'paper'
      ? ({ ...common, issueNumber: String(raw.record.issueNumber), month: String(raw.record.month), title: String(raw.record.title) } as NewspaperIssue)
      : ({ ...common, title: String(raw.record.title), author: String(raw.record.author) } as Work)
    const sequence = Number(raw.sequence)
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence !== Number(id.slice(1))) throw new Error(`invalid sequence in R2 manifest: ${key}`)
    if (recordKind === 'paper') validatePaperMetadata(record as NewspaperIssue)
    else validateWorkMetadata(record as Work)
    return { schemaVersion: 1, recordKind, sequence, record, appearances }
  }

  private recordFingerprint(item: NewspaperIssue | Work) {
    const { backupState: _state, backupError: _error, attachment, publishedAt, updatedAt, ...metadata } = item
    return JSON.stringify({ ...metadata, publishedAt: publishedAt.toISOString(), updatedAt: updatedAt?.toISOString(), attachment: attachment && { relativePath: attachment.relativePath, contentType: attachment.contentType, size: attachment.size, checksum: attachment.checksum } })
  }

  async retryPending() {
    if (this.backupQueue?.retryNow) { await this.backupQueue.retryNow(); return }
    for (const item of [...this.db.issues, ...this.db.works]) {
      if (item.attachment?.r2 && item.attachment.r2.syncState !== 'synced') {
        if (this.backupQueue) await this.enqueueBackup(item.id.startsWith('P') ? 'paper' : 'work', item)
        else await this.local.sync(item.attachment)
      }
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
  private requireConfirmation(_session: ArchiveSession, confirmation?: string) { if (confirmation !== 'Y') throw new Error('confirmation requires exact Y') }
  private remove<T extends { id: string }>(items: T[], id: string, label: string) { const index = items.findIndex(item => item.id === id); if (index < 0) throw new Error(`${label} not found`); return items.splice(index, 1)[0] }
  private async enqueueBackup(kind: ArchiveRecordKind, item: NewspaperIssue | Work) {
    if (!item.attachment || !this.backupQueue) return
    await this.backupQueue.enqueue(item.attachment, { recordKind: kind, recordId: item.id, manifest: this.manifest(kind, item) })
    if (this.backupQueue.runDue) void this.backupQueue.runDue()
  }
  private manifest(kind: ArchiveRecordKind, item: NewspaperIssue | Work): ArchiveManifest {
    const attachment = item.attachment && { ...item.attachment, r2: item.attachment.r2 && { ...item.attachment.r2 } }
    const appearances = this.db.appearances.filter(appearance => kind === 'paper' ? appearance.paperId === item.id : appearance.workId === item.id).map(appearance => ({ ...appearance }))
    return { schemaVersion: 1, recordKind: kind, sequence: Number(item.id.slice(1)), record: { ...item, attachment }, appearances }
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

function accessSession(session: any): AccessSession {
  return {
    userId: session?.userId,
    guildId: session?.guildId,
    channelId: session?.channelId,
    user: { authority: session?.authority ?? session?.user?.authority },
  }
}

export async function authorizeArchiveSession(ctx: ArchiveAccessContext, session: any, action: 'read' | 'write'): Promise<AccessDecision> {
  return action === 'read'
    ? ctx.access.authorizeRead(accessSession(session))
    : ctx.access.authorizeWrite(accessSession(session))
}

async function archiveAccessDenial(ctx: ArchiveAccessContext, session: any, action: 'read' | 'write') {
  const decision = await authorizeArchiveSession(ctx, session, action)
  return decision.allowed ? undefined : decision.message
}

function payload(value: string | undefined): any {
  if (!value) throw new Error('请输入 JSON 元数据。')
  try { return JSON.parse(value) } catch { throw new Error('元数据必须是合法 JSON。') }
}

function decodeAttachmentDataUrl(input: AttachmentInput, maxMb?: number, kind = '附件'): AttachmentInput {
  if (typeof input.data !== 'string' || !input.data.startsWith('data:')) return input
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(input.data)
  if (!match) throw new Error('上传内容必须是 base64 data URL。')
  const encoded = match[2].replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('上传内容必须是有效的 base64 data URL。')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const decodedBytes = Math.floor(encoded.length * 3 / 4) - padding
  if (maxMb !== undefined && decodedBytes > maxMb * 1024 * 1024) throw new Error(`${kind}大小超过 ${maxMb} MB 限制`)
  return { ...input, contentType: input.contentType || match[1] || 'application/octet-stream', data: new Uint8Array(Buffer.from(encoded, 'base64')) }
}

export class ArchiveConsoleFeatures {
  constructor(
    private readonly ctx: Context,
    private readonly service: ArchiveService,
    private readonly ready: Promise<void>,
    private readonly preflight?: ArchivePreflight,
    private readonly queue?: ArchiveBackupQueue,
    private readonly cleanupQueue?: ArchiveCleanupQueue,
    private readonly limits: Pick<Config, 'paperMaxMb' | 'workMaxMb'> = { paperMaxMb: 100, workMaxMb: 500 },
  ) {}
  register() {
    const consoleService = this.ctx.get('console')
    if (!consoleService?.addListener) return
    consoleService.addEntry?.({ dev: resolve(__dirname, '../client/index.ts'), prod: resolve(__dirname, '../dist') })
    // Auth authority 1 means any authenticated Console account. When Auth is absent,
    // Console deliberately leaves the surface open as the deployment boundary.
    const authenticated = { authority: 1 }
    // Console has no specified account-to-QQ mapping. This value labels domain
    // audit entries only; the listener middleware above is the authorization.
    const consoleActor: ArchiveSession = { userId: 'console' }
    consoleService.addListener('memebot/archive/status', async () => {
      const health = this.preflight ? await this.preflight.check() : { state: 'ready' as const, lastCheck: new Date().toISOString(), stores: { local: { ok: true }, r2: { enabled: false } } }
      const emptyQueue = { pending: 0, failed: 0, complete: 0 }
      try {
        await this.ready
        const queue = this.queue?.counts ? await this.queue.counts() : emptyQueue
        return { ...health, queue }
      } catch (error) {
        return { ...health, state: 'unavailable', error: safeArchiveDiagnostic(error), queue: emptyQueue }
      }
    }, authenticated)
    consoleService.addListener('memebot/archive/recheck', async () => this.preflight?.check(), authenticated)
    const backupStatus = async () => {
      await this.ready
      return {
        counts: this.queue?.counts ? await this.queue.counts() : { pending: 0, failed: 0, complete: 0 },
        jobs: this.queue?.list ? await this.queue.list() : [],
      }
    }
    consoleService.addListener('memebot/archive/backup/status', backupStatus, authenticated)
    consoleService.addListener('memebot/archive/backup/retry', async (recordId?: string) => { await this.ready; await this.queue?.retryNow?.(recordId); return backupStatus() }, authenticated)
    const cleanupStatus = async () => {
      await this.ready
      return {
        counts: this.cleanupQueue?.counts ? await this.cleanupQueue.counts() : { pending: 0, failed: 0, complete: 0 },
        jobs: this.cleanupQueue?.list ? await this.cleanupQueue.list() : [],
      }
    }
    consoleService.addListener('memebot/archive/cleanup/status', cleanupStatus, authenticated)
    consoleService.addListener('memebot/archive/cleanup/retry', async (recordId?: string) => { await this.ready; await this.cleanupQueue?.retryNow?.(recordId); return cleanupStatus() }, authenticated)
    consoleService.addListener('memebot/archive/papers', async (query?: string) => { await this.ready; return this.service.searchIssues(query) }, authenticated)
    consoleService.addListener('memebot/archive/paper/details', async (id: string) => { await this.ready; return this.service.getPaperDetails(id) }, authenticated)
    consoleService.addListener('memebot/archive/paper/create', async (input: IssueInput) => {
      await this.ready
      return this.service.publishIssue(consoleActor, { ...input, attachment: input.attachment && decodeAttachmentDataUrl(input.attachment, this.limits.paperMaxMb, 'Paper PDF ') })
    }, authenticated)
    consoleService.addListener('memebot/archive/paper/edit', async (id: string, patch: Partial<IssueInput>) => { await this.ready; return this.service.updateIssue(consoleActor, id, patch, 'Y') }, authenticated)
    consoleService.addListener('memebot/archive/paper/upload', async (id: string, attachment: AttachmentInput) => {
      await this.ready
      return this.service.replaceIssueAttachment(consoleActor, id, decodeAttachmentDataUrl(attachment, this.limits.paperMaxMb, 'Paper PDF '))
    }, authenticated)
    const attachment = async (id: string) => {
      await this.ready
      const paper = this.service.getIssue(id)
      if (!paper?.attachment) throw new Error('Paper 不存在或没有附件')
      const data = await this.service.recover(paper)
      return { filename: paper.attachment.relativePath.split('/').pop(), contentType: paper.attachment.contentType, data: Buffer.from(data!).toString('base64') }
    }
    consoleService.addListener('memebot/archive/paper/preview', attachment, authenticated)
    consoleService.addListener('memebot/archive/paper/download', attachment, authenticated)
    consoleService.addListener('memebot/archive/works', async (query?: string) => { await this.ready; return this.service.searchWorks({ text: query }) }, authenticated)
    consoleService.addListener('memebot/archive/work/details', async (id: string) => { await this.ready; return this.service.getWorkDetails(id) }, authenticated)
    consoleService.addListener('memebot/archive/work/create', async (input: WorkInput) => {
      await this.ready
      return this.service.publishWork(consoleActor, { ...input, attachment: input.attachment && decodeAttachmentDataUrl(input.attachment, this.limits.workMaxMb, 'Work ZIP ') })
    }, authenticated)
    consoleService.addListener('memebot/archive/work/edit', async (id: string, patch: Partial<WorkInput>) => { await this.ready; return this.service.updateWork(consoleActor, id, patch, 'Y') }, authenticated)
    consoleService.addListener('memebot/archive/work/upload', async (id: string, input: AttachmentInput) => { await this.ready; return this.service.replaceWorkAttachment(consoleActor, id, decodeAttachmentDataUrl(input, this.limits.workMaxMb, 'Work ZIP ')) }, authenticated)
    const activeWork = (id: string) => { const work = this.service.getWork(id); if (!work) throw new Error('Work 不存在或已移除'); return work }
    consoleService.addListener('memebot/archive/work/tree', async (id: string) => { await this.ready; activeWork(id); const tree = await this.service.previews.tree(id); return tree.length ? tree : this.service.rebuildWorkPreview(id) }, authenticated)
    consoleService.addListener('memebot/archive/work/preview', async (id: string, path: string) => { await this.ready; activeWork(id); return this.service.previews.preview(id, path) }, authenticated)
    consoleService.addListener('memebot/archive/work/file', async (id: string, path: string) => { await this.ready; activeWork(id); const data = await this.service.previews.download(id, path); return { filename: path.split('/').pop(), data: Buffer.from(data).toString('base64') } }, authenticated)
    consoleService.addListener('memebot/archive/work/download', async (id: string) => {
      await this.ready
      const work = this.service.getWork(id); if (!work?.attachment) throw new Error('Work 不存在或没有 ZIP')
      const data = await this.service.recover(work)
      return { filename: work.attachment.relativePath.split('/').pop(), contentType: work.attachment.contentType, data: Buffer.from(data!).toString('base64') }
    }, authenticated)
    consoleService.addListener('memebot/archive/appearance/save', async (paperId: string, input: AppearanceInput) => { await this.ready; return this.service.associateWork(consoleActor, paperId, input.work ? { ...input, work: { ...input.work, attachment: input.work.attachment && decodeAttachmentDataUrl(input.work.attachment, this.limits.workMaxMb, 'Work ZIP ') } } : input) }, authenticated)
    consoleService.addListener('memebot/archive/appearance/remove', async (paperId: string, workId: string) => { await this.ready; await this.service.removeAppearance(consoleActor, paperId, workId) }, authenticated)
    consoleService.addListener('memebot/archive/restore/preview', async () => { await this.ready; return this.service.previewRestore(consoleActor) }, authenticated)
    consoleService.addListener('memebot/archive/restore/apply', async (selections?: RestoreSelection[]) => { await this.ready; return this.service.restoreFromR2(consoleActor, selections) }, authenticated)
    consoleService.addListener('memebot/archive/restore/history', async () => { await this.ready; return this.service.restoreHistory(consoleActor) }, authenticated)
    consoleService.addListener('memebot/archive/removed', async () => { await this.ready; return this.service.listRemoved(consoleActor) }, authenticated)
    consoleService.addListener('memebot/archive/record/remove', async (id: string, confirmation: string) => {
      await this.ready
      if (id.toUpperCase().startsWith('P')) return this.service.removeIssue(consoleActor, id, confirmation)
      return this.service.removeWork(consoleActor, id, confirmation)
    }, authenticated)
    consoleService.addListener('memebot/archive/record/restore', async (id: string) => { await this.ready; return this.service.restoreRecord(consoleActor, id) }, authenticated)
    const requireTypedIdentifier = (id: string, confirmation: string) => {
      if (confirmation !== id) throw new Error(`请输入完整 Archive Identifier ${id} 以确认。`)
    }
    consoleService.addListener('memebot/archive/record/purge', async (id: string, confirmation: string) => { await this.ready; requireTypedIdentifier(id, confirmation); return this.service.purgeRecord(consoleActor, id, 'Y') }, authenticated)
    consoleService.addListener('memebot/archive/record/anonymize', async (id: string, confirmation: string) => { await this.ready; requireTypedIdentifier(id, confirmation); return this.service.anonymizeRecord(consoleActor, id, 'Y') }, authenticated)
    consoleService.addListener('memebot/archive/attachments/retired', async (recordId?: string) => { await this.ready; return this.service.listRetiredAttachments(consoleActor, recordId) }, authenticated)
    consoleService.addListener('memebot/archive/attachment/restore', async (id: string) => { await this.ready; return this.service.restoreRetiredAttachment(consoleActor, id) }, authenticated)
    consoleService.addListener('memebot/archive/lifecycle/history', async (recordId?: string) => { await this.ready; return this.service.lifecycleHistory(consoleActor, recordId) }, authenticated)
  }
}

function payloadReadMessage(error: unknown): string {
  if (error instanceof PayloadArchiveReadError) {
    if (error.kind === 'unauthorized') return 'Archive 机器凭证无效。'
    if (error.kind === 'unavailable') return 'Archive 服务暂时不可用，请稍后重试。'
    if (error.kind === 'media') return error.message
    return 'Archive 服务返回了无法识别的数据。'
  }
  return 'Archive 服务暂时不可用，请稍后重试。'
}

export function apply(ctx: Context, config: Config) {
  const suppliedPayload = config?.payload
  const suppliedR2 = config?.r2
  const payloadMode = suppliedPayload?.enabled === true
  const access = (ctx as Context & { access?: ArchiveAccessService }).access
  if (!payloadMode && !access) throw new Error('memebot-archive requires memebot-access')
  if (!payloadMode && !(ctx as any).model?.extend) throw new Error('memebot-archive legacy mode requires database')
  config = {
    localPath: config?.localPath || 'data/memebot-archive',
    paperMaxMb: config?.paperMaxMb || 100, workMaxMb: config?.workMaxMb || 500,
    payload: {
      enabled: suppliedPayload?.enabled ?? false,
      baseUrl: suppliedPayload?.baseUrl ?? '',
      serviceToken: suppliedPayload?.serviceToken ?? '',
      timeoutMs: suppliedPayload?.timeoutMs || 10_000,
    },
    r2: {
      enabled: suppliedR2?.enabled ?? false,
      accountId: suppliedR2?.accountId ?? '',
      bucketName: suppliedR2?.bucketName ?? '',
      accessKeyId: suppliedR2?.accessKeyId ?? '',
      secretAccessKey: suppliedR2?.secretAccessKey ?? '',
      objectPrefix: suppliedR2?.objectPrefix || 'memebot-archive',
    },
  }
  if (!payloadMode && config.r2.enabled) {
    const missing = (['accountId', 'bucketName', 'accessKeyId', 'secretAccessKey'] as const).filter(key => !config.r2[key])
    if (missing.length) throw new Error(`R2 已启用但配置不完整：${missing.join(', ')}`)
  }
  if (!payloadMode) {
    ctx.model.extend('archivePaper', {
      id: 'string', issueNumber: 'string', month: 'string', title: 'string', description: 'text', sourceLink: 'string', attachment: 'text', lifecycle: 'string', removedAt: 'timestamp', expiresAt: 'timestamp', purgedAt: 'timestamp', anonymizedAt: 'timestamp', backupState: 'string', backupError: 'text', publishedAt: 'timestamp', updatedAt: 'timestamp',
    }, { primary: 'id' })
    ctx.model.extend('archiveWork', { id: 'string', title: 'string', author: 'string', description: 'text', attachment: 'text', lifecycle: 'string', removedAt: 'timestamp', expiresAt: 'timestamp', purgedAt: 'timestamp', anonymizedAt: 'timestamp', backupState: 'string', backupError: 'text', publishedAt: 'timestamp', updatedAt: 'timestamp' }, { primary: 'id' })
    ctx.model.extend('archiveSequence', { kind: 'string', value: 'unsigned' }, { primary: 'kind' })
    ctx.model.extend('archiveBackupJob', { id: 'string', recordKind: 'string', recordId: 'string', attachment: 'text', manifest: 'text', state: 'string', attempts: 'unsigned', nextAttemptAt: 'timestamp', error: 'text' }, { primary: 'id' })
    ctx.model.extend('archiveCleanupJob', { id: 'string', recordKind: 'string', recordId: 'string', objectKeys: 'text', state: 'string', attempts: 'unsigned', nextAttemptAt: 'timestamp', error: 'text' }, { primary: 'id' })
    ctx.model.extend('archiveRetiredAttachment', { id: 'string', recordKind: 'string', recordId: 'string', attachment: 'text', lifecycle: 'string', removedAt: 'timestamp', expiresAt: 'timestamp', restoredAt: 'timestamp', purgedAt: 'timestamp' }, { primary: 'id' })
    ctx.model.extend('archiveLifecycleAudit', { id: 'string', actor: 'string', recordKind: 'string', recordId: 'string', action: 'string', details: 'text', createdAt: 'timestamp' }, { primary: 'id' })
    ctx.model.extend('archivePublicationAppearance', { paperId: 'string', workId: 'string', page: 'string', section: 'string', displayOrder: 'unsigned', createdAt: 'timestamp', updatedAt: 'timestamp' }, { primary: ['paperId', 'workId'] })
    ctx.model.extend('archiveRestoreAudit', { id: 'string', actor: 'string', action: 'string', result: 'string', details: 'text', createdAt: 'timestamp' }, { primary: 'id' })
  }
  const metadata = payloadMode ? undefined : new KoishiArchiveMetadataRepository(ctx)
  const r2 = !payloadMode && config.r2.enabled ? new S3R2Store(config.r2) : undefined
  const local = !payloadMode ? new LocalAttachmentStore(config.localPath, r2, config.r2.objectPrefix) : undefined
  let service!: ArchiveService
  const sink: BackupStatusSink = { update: async (kind, id, state, error) => {
    await metadata?.updateBackupState(kind, id, state, error)
    const item = kind === 'paper' ? service?.getIssue(id) : service?.getWork(id)
    if (item) { item.backupState = state; item.backupError = error }
  } }
  const queue = r2 && local ? new PersistentArchiveBackupQueue(ctx, local, r2, sink) : undefined
  const cleanupQueue = r2 ? new PersistentArchiveCleanupQueue(ctx, r2) : undefined
  service = new ArchiveService({ config, metadata, local, r2, backupQueue: queue, cleanupQueue })
  const payloadReader = config.payload?.enabled
    ? new PayloadArchiveReadAdapter(config.payload)
    : undefined
  const preflight = payloadMode ? undefined : new ArchivePreflight(config.localPath, r2, [config.r2.accessKeyId, config.r2.secretAccessKey])
  const initialized = payloadMode ? Promise.resolve() : service.initialize()
  const ready = payloadMode
    ? Promise.resolve()
    : Promise.all([initialized, preflight!.check()]).then(([, health]) => { if (health.state === 'unavailable') throw new Error(health.stores.local.error || '本地存储不可用') })
  void ready.catch(() => undefined)
  // Payload mode owns the Work/Media management surface. Keep the legacy
  // Console listeners available only for the legacy local archive mode.
  if (!payloadReader) new ArchiveConsoleFeatures(ctx, service, ready, preflight, queue, cleanupQueue, config).register()
  if (!payloadMode) {
    if (queue) ctx.setInterval(() => { void queue.runDue() }, 60_000)
    if (cleanupQueue) ctx.setInterval(() => { void cleanupQueue.runDue() }, 60_000)
    ctx.setInterval(() => { void service.purgeExpired() }, 60_000)
  }
  ;(ctx as any).archive = service
  const root = ctx.command('archive [id:text]', '搜索或获取 Paper 归档')
  const payloadMvpOnly = '当前 Payload Archive MVP 仅支持在 Payload Admin 管理 Work；QQ 侧只读 Work。'
  root.action(async ({ session }, id) => {
    if (payloadReader) {
      if (!id) return '请使用 /archive search works [查询] 或 /archive W<n>。'
      if (!/^w\d+$/i.test(id)) return '当前 Payload Archive MVP 仅支持 Work W<n>。'
      try {
        if (!session) {
          const work = await payloadReader.getWork(id)
          return work ? `${work.id} ${work.author} - ${work.title}` : 'Work 不存在。'
        }
        return await sendPayloadWork(session, payloadReader, id)
      } catch (error) {
        return payloadReadMessage(error)
      }
    }
    await ready
    if (!id) return '请使用 /archive search paper [查询]、/archive search works [查询]，或 /archive P/W编号。'
    if (/^w\d+$/i.test(id)) {
      const work = service.getWork(id)
      if (!work?.attachment) return 'Work 不存在。'
      const data = await service.recover(work)
      await session?.send(service.workDetailText(work.id)!)
      return h.file(`data:${work.attachment.contentType};base64,${Buffer.from(data!).toString('base64')}`, { filename: work.attachment.relativePath.split('/').pop() || `${work.id}.zip` })
    }
    const paper = service.getIssue(id)
    if (!paper) return 'Paper 不存在。'
    const detail = service.paperDetailText(paper.id)!
    if (!paper.attachment) return detail
    const data = await service.recover(paper)
    const filename = paper.attachment.relativePath.split('/').pop() || `${paper.id}.pdf`
    const url = `data:${paper.attachment.contentType};base64,${Buffer.from(data!).toString('base64')}`
    await session?.send(detail)
    return h.file(url, { filename })
  })
  root.subcommand('.search <kind:string> [query:text]', '搜索 Paper 或 Work').action(async (_meta, kind, query) => {
    if (payloadReader) {
      if (kind.toLocaleLowerCase() !== 'works') return '当前 Payload Archive MVP 仅支持 /archive search works [查询]。'
      try {
        const items = await payloadReader.searchWorks({ text: query })
        return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
      } catch (error) {
        return payloadReadMessage(error)
      }
    }
    await ready
    if (kind.toLocaleLowerCase() === 'paper') {
      const items = service.searchIssues(query)
      return items.length ? items.map(item => `${item.id} ${item.month} 第${item.issueNumber}期 ${item.title}`).join('\n') : '没有找到 Paper。'
    }
    if (kind.toLocaleLowerCase() === 'works') {
      const items = service.searchWorks({ text: query })
      return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
    }
    return '请使用 /archive search paper [查询] 或 /archive search works [查询]。'
  })
  root.subcommand('.rm <id:string>', '确认后将 Paper 或 Work 软删除 30 天').action(async ({ session }, id) => {
    if (payloadReader) return payloadMvpOnly
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    const paper = service.getIssue(id)
    const work = service.getWork(id)
    if (!paper && !work) return 'Archive 记录不存在。'
    const target = paper ? `${paper.id} ${paper.month} 第${paper.issueNumber}期 ${paper.title}` : `${work!.id} ${work!.author} - ${work!.title}`
    await session.send(`即将移除 ${target}。普通搜索与附件将立即不可用，30 天内可恢复。请发送“确认”继续，其他输入取消。`)
    if ((await session.prompt(300000))?.trim() !== '确认') return '已取消移除。'
    if (paper) await service.removeIssue(archiveSession, paper.id, 'Y')
    else await service.removeWork(archiveSession, work!.id, 'Y')
    return `已移除 ${paper ? 'Paper' : 'Work'} ${id.toUpperCase()}，保留 30 天。`
  })
  const guidedPrompt = async (session: any, label: string, optional = false) => {
    await session.send(label + (optional ? '（发送 - 跳过）' : ''))
    const value = (await session.prompt(300000))?.trim()
    if (!value) throw new Error('操作已超时或输入为空。')
    return optional && value === '-' ? '' : value
  }
  root.subcommand('.publish.paper', '引导发布一个 Paper PDF').action(async ({ session }) => {
    if (payloadReader) return payloadMvpOnly
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
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
    } catch (error) { return safeArchiveDiagnostic(error) }
  })
  root.subcommand('.publish.works', '引导发布一个 ZIP Work Package').action(async ({ session }) => {
    if (payloadReader) return payloadMvpOnly
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
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
    } catch (error) { return safeArchiveDiagnostic(error) }
  })
  root.subcommand('.edit.paper <id:string>', '引导编辑 Paper 元数据').action(async ({ session }, id) => {
    if (payloadReader) return payloadMvpOnly
    await ready
    if (!session) return '无法识别当前会话。'
    const archiveSession = commandSession(session)
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
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
    if (payloadReader) return '当前 Payload Archive MVP 不提供 Paper。'
    await ready
    const items = service.listIssues(month)
    return items.length ? items.map(item => `${item.id} ${item.month} ${item.title}`).join('\n') : '没有找到 Newspaper Issue。'
  })
  root.subcommand('.works [query:text]', '查询 Work').action(async ({ session }, query) => {
    if (payloadReader) {
      try {
        const items = await payloadReader.searchWorks({ text: query })
        return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
      } catch (error) {
        return payloadReadMessage(error)
      }
    }
    const items = service.searchWorks({ text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.work-query [author:text] [query:text]', '按作者或文本查询 Work').action(async ({ session }, author, query) => {
    if (payloadReader) {
      try {
        const items = await payloadReader.searchWorks({ author, text: query })
        return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
      } catch (error) {
        return payloadReadMessage(error)
      }
    }
    const items = service.searchWorks({ author, text: query })
    return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
  })
  root.subcommand('.issue-preview <metadata:text>', '预览 Newspaper Issue 元数据').action(async ({ session }, metadata) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'read')
    if (denial) return denial
    return JSON.stringify(service.previewIssue(payload(metadata)))
  })
  root.subcommand('.work-preview <metadata:text>', '预览 Work 元数据').action(async ({ session }, metadata) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'read')
    if (denial) return denial
    return JSON.stringify(service.previewWork(payload(metadata)))
  })
  root.subcommand('.issue-publish <metadata:text>', '发布 Newspaper Issue').action(async ({ session }, metadata) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    await ready
    const input = payload(metadata) as IssueInput
    const item = await service.publishIssue(commandSession(session), { ...input, attachment: input.attachment && decodeAttachmentDataUrl(input.attachment, config.paperMaxMb, 'Paper PDF ') })
    return `已发布 Newspaper Issue ${item.id}。`
  })
  root.subcommand('.work-publish <metadata:text>', '发布 Work').action(async ({ session }, metadata) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    const input = payload(metadata) as WorkInput
    const item = await service.publishWork(commandSession(session), { ...input, attachment: input.attachment && decodeAttachmentDataUrl(input.attachment, config.workMaxMb, 'Work ZIP ') })
    return `已发布 Work ${item.id}。`
  })
  root.subcommand('.issue-edit <id:string> <confirmation:string> <patch:text>', '编辑 Newspaper Issue 元数据').action(async ({ session }, id, confirmation, patch) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    return `已更新 Newspaper Issue ${(await service.updateIssue(commandSession(session), id, payload(patch), confirmation)).id}。`
  })
  root.subcommand('.work-edit <id:string> <confirmation:string> <patch:text>', '编辑 Work 元数据').action(async ({ session }, id, confirmation, patch) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    return `已更新 Work ${(await service.updateWork(commandSession(session), id, payload(patch), confirmation)).id}。`
  })
  root.subcommand('.issue-remove <id:string> <confirmation:string>', '删除 Newspaper Issue').action(async ({ session }, id, confirmation) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    await service.removeIssue(commandSession(session), id, confirmation)
    return `已删除 Newspaper Issue ${id}。`
  })
  root.subcommand('.work-remove <id:string> <confirmation:string>', '删除 Work').action(async ({ session }, id, confirmation) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    await service.removeWork(commandSession(session), id, confirmation)
    return `已删除 Work ${id}。`
  })
  root.subcommand('.retry', '重试附件 R2 同步').action(async ({ session }) => {
    if (payloadReader) return payloadMvpOnly
    const denial = await archiveAccessDenial({ access: access! }, session, 'write')
    if (denial) return denial
    await service.retryPending()
    return '已重试待同步附件。'
  })
  return service
}

export default { name, inject: runtimeInject, Config, apply }
