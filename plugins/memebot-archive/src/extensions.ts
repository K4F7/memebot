import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export interface ExtensionAttachment {
  relativePath: string
  contentType: string
  size: number
  checksum: string
  r2?: { objectKey: string; syncState: 'synced' | 'pending' | 'failed'; lastAttempt?: string; error?: string }
}

export interface ExtensionR2Store {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array | undefined>
  delete(key: string): Promise<void>
}

export interface ArchiveHealthResult {
  state: 'ready' | 'degraded' | 'unavailable'
  lastCheck: string
  stores: {
    local: { ok: boolean; error?: string }
    r2: { enabled: boolean; ok?: boolean; error?: string }
  }
}

const diagnosticPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

export class ArchivePreflight {
  constructor(
    private readonly localRoot: string,
    private readonly r2?: ExtensionR2Store,
    private readonly secrets: string[] = [],
    private readonly localCheck?: () => Promise<void>,
  ) {}
  async check(): Promise<ArchiveHealthResult> {
    const lastCheck = new Date().toISOString()
    let localError: string | undefined
    let r2Error: string | undefined
    try { await (this.localCheck?.() ?? this.checkLocal()) } catch (error) { localError = this.safeError(error) }
    if (!localError && this.r2) try { await this.checkR2() } catch (error) { r2Error = this.safeError(error) }
    return {
      state: localError ? 'unavailable' : r2Error ? 'degraded' : 'ready',
      lastCheck,
      stores: {
        local: { ok: !localError, ...(localError && { error: localError }) },
        r2: { enabled: !!this.r2, ...(this.r2 && { ok: !r2Error }), ...(r2Error && { error: r2Error }) },
      },
    }
  }
  private async checkLocal() {
    const directory = resolve(this.localRoot, '.diagnostics')
    const path = resolve(directory, 'preflight.png')
    await mkdir(directory, { recursive: true })
    await writeFile(path, diagnosticPng)
    try {
      const restored = new Uint8Array(await readFile(path))
      if (hash(restored) !== hash(diagnosticPng)) throw new Error('local diagnostic checksum mismatch')
    } finally { await unlink(path).catch(() => undefined) }
  }
  private async checkR2() {
    const key = `.diagnostics/${createHash('sha256').update(String(Date.now())).digest('hex')}.png`
    await this.r2!.put(key, diagnosticPng, 'image/png')
    try {
      const restored = await this.r2!.get(key)
      if (!restored || hash(restored) !== hash(diagnosticPng)) throw new Error('R2 diagnostic checksum mismatch')
    } finally { await this.r2!.delete(key).catch(() => undefined) }
  }
  private safeError(error: unknown) {
    let message = error instanceof Error ? error.message : String(error)
    for (const secret of this.secrets.filter(Boolean)) message = message.replaceAll(secret, '***')
    return message
  }
}

interface QueueModel {
  get(name: string, query: Record<string, unknown>): Promise<any[]>
  create(name: string, data: Record<string, unknown>): Promise<unknown>
  set(name: string, query: Record<string, unknown>, patch: Record<string, unknown>): Promise<unknown>
}
interface QueueContext { model: QueueModel }
interface QueueLocal { read(attachment: ExtensionAttachment): Promise<Uint8Array> }
export interface BackupContext { recordKind: 'paper' | 'work'; recordId: string; manifest: unknown }
export interface BackupStatusSink { update(kind: 'paper' | 'work', id: string, state: 'pending' | 'failed' | 'complete', error?: string): Promise<void> }
interface BackupJob {
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

const backupRetry = [60_000, 5 * 60_000, 30 * 60_000]
const backupDelay = (attempts: number) => attempts <= 3 ? backupRetry[attempts - 1] : 6 * 60 * 60_000

export class PersistentArchiveBackupQueue {
  private running?: Promise<void>
  constructor(
    private readonly ctx: QueueContext,
    private readonly local: QueueLocal,
    private readonly r2: ExtensionR2Store,
    private readonly sink: BackupStatusSink,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async enqueue(attachment: ExtensionAttachment, context?: BackupContext) {
    if (!context) throw new Error('backup context required')
    const id = createHash('sha256').update(`${context.recordKind}\0${context.recordId}\0${attachment.relativePath}`).digest('hex')
    const existing = await this.ctx.model.get('archiveBackupJob', { id })
    const data = { recordKind: context.recordKind, recordId: context.recordId, attachment: JSON.stringify(attachment), manifest: JSON.stringify(context.manifest), state: 'pending', attempts: 0, nextAttemptAt: this.now(), error: '' }
    if (!existing[0]) await this.ctx.model.create('archiveBackupJob', { id, ...data })
    else await this.ctx.model.set('archiveBackupJob', { id }, data)
    attachment.r2 ??= { objectKey: attachment.relativePath, syncState: 'pending' }
    await this.sink.update(context.recordKind, context.recordId, 'pending')
  }
  async runDue() {
    if (this.running) return this.running
    this.running = (async () => {
      const jobs = await this.ctx.model.get('archiveBackupJob', {}) as BackupJob[]
      for (const job of jobs) if (job.state !== 'complete' && new Date(job.nextAttemptAt).getTime() <= this.now().getTime()) await this.run(job)
    })()
    try { await this.running } finally { this.running = undefined }
  }
  async retryNow(recordId?: string) {
    const jobs = await this.ctx.model.get('archiveBackupJob', recordId ? { recordId } : {}) as BackupJob[]
    for (const job of jobs) if (job.state !== 'complete') { await this.ctx.model.set('archiveBackupJob', { id: job.id }, { nextAttemptAt: this.now(), state: 'pending' }); await this.run({ ...job, nextAttemptAt: this.now(), state: 'pending' }) }
  }
  async counts() {
    const jobs = await this.ctx.model.get('archiveBackupJob', {}) as BackupJob[]
    return {
      pending: jobs.filter(job => job.state === 'pending').length,
      failed: jobs.filter(job => job.state === 'failed').length,
      complete: jobs.filter(job => job.state === 'complete').length,
    }
  }
  private async run(job: BackupJob) {
    const attachment = JSON.parse(job.attachment) as ExtensionAttachment
    const objectKey = attachment.r2?.objectKey ?? attachment.relativePath
    const suffix = `/${attachment.relativePath}`
    const prefix = objectKey.endsWith(suffix) ? objectKey.slice(0, -suffix.length) : objectKey.includes('/') ? objectKey.slice(0, objectKey.lastIndexOf('/')) : ''
    const manifestKey = `${prefix ? `${prefix}/` : ''}manifests/${job.recordKind}/${job.recordId}.json`
    try {
      await this.r2.put(objectKey, await this.local.read(attachment), attachment.contentType)
      await this.r2.put(manifestKey, new TextEncoder().encode(job.manifest), 'application/json')
      attachment.r2 ??= { objectKey, syncState: 'pending' }
      attachment.r2.syncState = 'synced'; attachment.r2.lastAttempt = this.now().toISOString(); delete attachment.r2.error
      await this.ctx.model.set('archiveBackupJob', { id: job.id }, { state: 'complete', attachment: JSON.stringify(attachment), error: '' })
      await this.sink.update(job.recordKind, job.recordId, 'complete')
    } catch (error) {
      const attempts = job.attempts + 1
      const message = error instanceof Error ? error.message : String(error)
      attachment.r2 ??= { objectKey, syncState: 'pending' }
      attachment.r2.syncState = 'failed'; attachment.r2.lastAttempt = this.now().toISOString(); attachment.r2.error = message
      await this.ctx.model.set('archiveBackupJob', { id: job.id }, { state: 'failed', attempts, nextAttemptAt: new Date(this.now().getTime() + backupDelay(attempts)), error: message, attachment: JSON.stringify(attachment) })
      await this.sink.update(job.recordKind, job.recordId, 'failed', message)
    }
  }
}

interface CleanupJobRow {
  id: string
  recordKind: 'paper' | 'work'
  recordId: string
  objectKeys: string
  state: 'pending' | 'failed' | 'complete'
  attempts: number
  nextAttemptAt: Date
  error: string
}

export interface ArchiveCleanupJob extends Omit<CleanupJobRow, 'objectKeys'> {
  objectKeys: string[]
}

export class PersistentArchiveCleanupQueue {
  private running?: Promise<void>
  constructor(
    private readonly ctx: QueueContext,
    private readonly r2: ExtensionR2Store,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async enqueue(recordKind: 'paper' | 'work', recordId: string, objectKeys: string[]) {
    const keys = [...new Set(objectKeys.filter(Boolean))].sort()
    const id = createHash('sha256').update(`${recordKind}\0${recordId}\0${keys.join('\0')}`).digest('hex')
    const existing = await this.ctx.model.get('archiveCleanupJob', { id })
    const data = { recordKind, recordId, objectKeys: JSON.stringify(keys), state: 'pending', attempts: 0, nextAttemptAt: this.now(), error: '' }
    if (existing[0]) await this.ctx.model.set('archiveCleanupJob', { id }, data)
    else await this.ctx.model.create('archiveCleanupJob', { id, ...data })
  }
  async runDue() {
    return this.serialized(async () => {
      const jobs = await this.ctx.model.get('archiveCleanupJob', {}) as CleanupJobRow[]
      for (const job of jobs) if (job.state !== 'complete' && new Date(job.nextAttemptAt).getTime() <= this.now().getTime()) await this.run(job)
    })
  }
  async retryNow(recordId?: string) {
    return this.serialized(async () => {
      const jobs = await this.ctx.model.get('archiveCleanupJob', recordId ? { recordId } : {}) as CleanupJobRow[]
      for (const job of jobs) if (job.state !== 'complete') {
        const pending = { ...job, state: 'pending' as const, nextAttemptAt: this.now() }
        await this.ctx.model.set('archiveCleanupJob', { id: job.id }, { state: pending.state, nextAttemptAt: pending.nextAttemptAt })
        await this.run(pending)
      }
    })
  }
  async counts() {
    const jobs = await this.ctx.model.get('archiveCleanupJob', {}) as CleanupJobRow[]
    return {
      pending: jobs.filter(job => job.state === 'pending').length,
      failed: jobs.filter(job => job.state === 'failed').length,
      complete: jobs.filter(job => job.state === 'complete').length,
    }
  }
  async list(recordId?: string): Promise<ArchiveCleanupJob[]> {
    const jobs = await this.ctx.model.get('archiveCleanupJob', recordId ? { recordId } : {}) as CleanupJobRow[]
    const rank = { failed: 0, pending: 1, complete: 2 }
    return jobs.map(job => ({
      ...job,
      objectKeys: JSON.parse(job.objectKeys) as string[],
      nextAttemptAt: new Date(job.nextAttemptAt),
    })).sort((a, b) => rank[a.state] - rank[b.state]
      || b.nextAttemptAt.getTime() - a.nextAttemptAt.getTime()
      || a.recordId.localeCompare(b.recordId))
  }
  private async run(job: CleanupJobRow) {
    try {
      for (const key of JSON.parse(job.objectKeys) as string[]) await this.r2.delete(key)
      await this.ctx.model.set('archiveCleanupJob', { id: job.id }, { state: 'complete', error: '' })
    } catch (error) {
      const attempts = job.attempts + 1
      const message = error instanceof Error ? error.message : String(error)
      await this.ctx.model.set('archiveCleanupJob', { id: job.id }, { state: 'failed', attempts, nextAttemptAt: new Date(this.now().getTime() + backupDelay(attempts)), error: message })
    }
  }
  private async serialized(operation: () => Promise<void>) {
    while (this.running) await this.running
    const running = operation()
    this.running = running
    try { await running } finally { if (this.running === running) this.running = undefined }
  }
}

interface ZipEntry {
  path: string
  method: number
  compressedSize: number
  size: number
  crc: number
  localOffset: number
  directory: boolean
}
export interface WorkPreviewEntry { path: string; size: number; previewable: boolean; kind: string }

export class WorkPreviewStore {
  constructor(readonly root: string) {}
  async build(id: string, input: Uint8Array): Promise<WorkPreviewEntry[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Work 编号不安全')
    const entries = parseZip(input)
    const targetRoot = resolve(this.root, id)
    await rm(targetRoot, { recursive: true, force: true })
    await mkdir(targetRoot, { recursive: true })
    const tree: WorkPreviewEntry[] = []
    for (const entry of entries) {
      const target = confined(targetRoot, entry.path)
      if (entry.directory) { await mkdir(target, { recursive: true }); continue }
      const data = extractEntry(input, entry)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
      const classification = classify(entry.path)
      tree.push({ path: entry.path, size: data.byteLength, previewable: classification.previewable, kind: classification.kind })
    }
    await writeFile(resolve(targetRoot, '.tree.json'), JSON.stringify(tree))
    return tree
  }
  async tree(id: string) {
    const manifest = resolve(this.workRoot(id), '.tree.json')
    try { return JSON.parse(await readFile(manifest, 'utf8')) as WorkPreviewEntry[] } catch { return [] }
  }
  async preview(id: string, path: string) {
    const classification = classify(path)
    const data = new Uint8Array(await readFile(confined(this.workRoot(id), path)))
    if (!classification.previewable) return { previewable: false, kind: classification.kind, data: Buffer.from(data).toString('base64') }
    if (classification.text) return { previewable: true, kind: classification.kind, contentType: classification.contentType, text: new TextDecoder().decode(data), ...(classification.sandbox && { sandbox: 'allow-downloads' }) }
    return { previewable: true, kind: classification.kind, contentType: classification.contentType, data: Buffer.from(data).toString('base64'), ...(classification.sandbox && { sandbox: 'allow-downloads' }) }
  }
  async download(id: string, path: string) { return new Uint8Array(await readFile(confined(this.workRoot(id), path))) }
  async remove(id: string) { await rm(this.workRoot(id), { recursive: true, force: true }) }
  private workRoot(id: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Work 编号不安全')
    return resolve(this.root, id)
  }
}

function parseZip(data: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index--) if (buffer.readUInt32LE(index) === 0x06054b50) { end = index; break }
  if (end < 0) throw new Error('Work Package 不是结构有效的 ZIP')
  const count = buffer.readUInt16LE(end + 10)
  if (count > 2000) throw new Error('Work Package 条目数超过 2000')
  let cursor = buffer.readUInt32LE(end + 16)
  let expanded = 0
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Work Package ZIP 中央目录损坏')
    const flags = buffer.readUInt16LE(cursor + 8)
    if (flags & 1) throw new Error('Work Package 不允许加密条目')
    const method = buffer.readUInt16LE(cursor + 10)
    if (method !== 0 && method !== 8) throw new Error('Work Package 包含不支持的压缩方法')
    const compressedSize = buffer.readUInt32LE(cursor + 20); const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28); const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32)
    const external = buffer.readUInt32LE(cursor + 38); const mode = external >>> 16
    if ((mode & 0o170000) === 0o120000) throw new Error('Work Package 不允许符号链接')
    const path = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').replaceAll('\\', '/')
    validateEntryPath(path)
    expanded += size
    if (expanded > 2 * 1024 * 1024 * 1024) throw new Error('Work Package 展开大小超过 2 GB')
    entries.push({ path, method, compressedSize, size, crc: buffer.readUInt32LE(cursor + 16), localOffset: buffer.readUInt32LE(cursor + 42), directory: path.endsWith('/') })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function extractEntry(input: Uint8Array, entry: ZipEntry) {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('Work Package ZIP 本地条目损坏')
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26); const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength; const end = start + entry.compressedSize
  if (end > buffer.length) throw new Error('Work Package ZIP 条目数据截断')
  const compressed = buffer.subarray(start, end); const data = entry.method === 0 ? compressed : inflateRawSync(compressed)
  if (data.byteLength !== entry.size || crc32(data) !== entry.crc) throw new Error('Work Package ZIP 条目校验失败')
  return data
}

function validateEntryPath(path: string) {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) throw new Error('Work Package 包含不安全路径')
}
function confined(root: string, path: string) {
  validateEntryPath(path)
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Work Package 包含不安全路径')
  return target
}
function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function hash(data: Uint8Array) { return createHash('sha256').update(data).digest('hex') }
function classify(path: string) {
  const extension = extname(path).toLowerCase()
  const types: Record<string, { kind: string; contentType: string; text?: boolean; sandbox?: boolean }> = {
    '.txt': { kind: 'text', contentType: 'text/plain', text: true }, '.md': { kind: 'text', contentType: 'text/markdown', text: true }, '.json': { kind: 'text', contentType: 'application/json', text: true }, '.csv': { kind: 'text', contentType: 'text/csv', text: true },
    '.png': { kind: 'image', contentType: 'image/png' }, '.jpg': { kind: 'image', contentType: 'image/jpeg' }, '.jpeg': { kind: 'image', contentType: 'image/jpeg' }, '.gif': { kind: 'image', contentType: 'image/gif' }, '.webp': { kind: 'image', contentType: 'image/webp' },
    '.mp3': { kind: 'audio', contentType: 'audio/mpeg' }, '.ogg': { kind: 'audio', contentType: 'audio/ogg' }, '.wav': { kind: 'audio', contentType: 'audio/wav' }, '.mp4': { kind: 'video', contentType: 'video/mp4' }, '.webm': { kind: 'video', contentType: 'video/webm' },
    '.pdf': { kind: 'pdf', contentType: 'application/pdf' }, '.html': { kind: 'web', contentType: 'text/html', text: true, sandbox: true }, '.htm': { kind: 'web', contentType: 'text/html', text: true, sandbox: true }, '.svg': { kind: 'web', contentType: 'image/svg+xml', text: true, sandbox: true },
  }
  const found = types[extension]
  return found ? { ...found, previewable: true } : { kind: 'unknown', contentType: 'application/octet-stream', previewable: false, text: false, sandbox: false }
}
