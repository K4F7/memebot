import { randomUUID } from 'node:crypto'

import {
  type AuthoringErrorCode,
  type AuthorizeUploadRequest,
  type AuthorizeUploadResponse,
  type CreateWorkRequest,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
  type ManifestSaveEntry,
  type MediaManifestItem,
  type SaveDraftRequest,
  type WorkAggregate,
} from '../authoring/contract'
import {
  createStorageKey,
  createUploadContext,
  MAX_MEDIA_SIZE,
  type UploadContext,
  verifyUploadContext,
} from './media-policy'
import { validateMediaMimeType } from './mime'

/** A structural request type keeps the domain seam independent of Payload. */
export interface AuthoringRequestContext {
  [key: string]: unknown
}

export interface StoredMedia {
  id: string
  workId: string
  filename: string
  mimeType: string
  filesize: number
  alt?: string
  storageKey: string
  status: 'pending' | 'finalized'
  withdrawnAt?: string
  uploadId?: string
  idempotencyKey?: string
  contentFingerprint?: string
  replaceMediaId?: string
  selectionIndex?: number
  everPublished?: boolean
  /** The server-issued signed context is retained for cryptographic idempotency retries. */
  uploadContext?: UploadContext
}

export interface StoredManifestEntry {
  mediaId: string
  filename: string
  alt?: string
  caption?: string
}

export interface StoredPublishedSnapshot {
  revision: string
  title: string
  author: string
  description?: string
  media: StoredManifestEntry[]
  publishedAt: string
}

export interface StoredWork {
  id: string
  archiveId: string
  revision: string
  title: string
  author: string
  description?: string
  media: StoredManifestEntry[]
  published?: StoredPublishedSnapshot
}

export interface CleanupIntent {
  workId: string
  mediaId: string
  storageKey: string
  status: 'pending' | 'processing' | 'deleted' | 'failed'
  attempts: number
  lastError?: string
}

export interface AuthorizeUploadResult {
  putUrl: string
  headers?: Record<string, string>
  expiresAt: string
  context: UploadContext
}

export interface AuthoringObjectStore {
  authorizeUpload(input: {
    storageKey: string
    context: UploadContext
    filename: string
    filesize: number
    mimeType: string
  }): Promise<AuthorizeUploadResult>
  head(storageKey: string): Promise<{ size: number; mimeType?: string } | null>
  delete(storageKey: string): Promise<void>
}

export interface WorkAuthoringRepository {
  createWork(input: {
    title: string
    author: string
    description?: string
    revision: string
    req?: AuthoringRequestContext
  }): Promise<StoredWork>
  getDraft(workId: string, req?: AuthoringRequestContext): Promise<StoredWork | null>
  getPublished(workId: string, req?: AuthoringRequestContext): Promise<StoredPublishedSnapshot | null>
  listMedia(workId: string, req?: AuthoringRequestContext): Promise<StoredMedia[]>
  getMedia(mediaId: string, req?: AuthoringRequestContext): Promise<StoredMedia | null>
  findMediaByIdempotency(workId: string, key: string, req?: AuthoringRequestContext): Promise<StoredMedia | null>
  findMediaByUploadId(workId: string, uploadId: string, req?: AuthoringRequestContext): Promise<StoredMedia | null>
  saveDraft(input: {
    workId: string
    expectedRevision: string
    revision: string
    title: string
    author: string
    description?: string
    media: StoredManifestEntry[]
    req?: AuthoringRequestContext
  }): Promise<StoredWork>
  createPendingMedia(input: {
    workId: string
    uploadId: string
    filename: string
    filesize: number
    mimeType: string
    storageKey: string
    replaceMediaId?: string
    selectionIndex?: number
    uploadContext?: UploadContext
    req?: AuthoringRequestContext
  }): Promise<StoredMedia>
  finalizeUpload(input: {
    workId: string
    mediaId: string
    expectedRevision: string
    revision: string
    idempotencyKey?: string
    contentFingerprint?: string
    media: StoredManifestEntry[]
    req?: AuthoringRequestContext
  }): Promise<StoredWork>
  discardMedia(input: {
    workId: string
    mediaId: string
    expectedRevision: string
    revision: string
    req?: AuthoringRequestContext
  }): Promise<StoredWork>
  publish(input: {
    workId: string
    expectedRevision: string
    revision: string
    req?: AuthoringRequestContext
  }): Promise<StoredWork>
  recordCleanupIntent(input: {
    workId: string
    mediaId: string
    storageKey: string
    req?: AuthoringRequestContext
  }): Promise<void>
  listCleanupIntents(input: { limit: number; req?: AuthoringRequestContext }): Promise<CleanupIntent[]>
  claimCleanupIntents(input: { limit: number; req?: AuthoringRequestContext }): Promise<CleanupIntent[]>
  markCleanupIntent(input: { storageKey: string; status: CleanupIntent['status']; attempts: number; lastError?: string; req?: AuthoringRequestContext }): Promise<void>
  withWorkLock<T>(workId: string, req: AuthoringRequestContext | undefined, callback: (transactionReq: AuthoringRequestContext) => Promise<T>): Promise<T>
}

export class AuthoringServiceError extends Error {
  readonly status: number
  readonly code: AuthoringErrorCode
  readonly field?: string
  readonly mediaId?: string
  readonly uploadId?: string
  readonly currentRevision?: string
  readonly aggregate?: WorkAggregate

  constructor(code: AuthoringErrorCode, message: string, options: {
    status?: number
    field?: string
    mediaId?: string
    uploadId?: string
    currentRevision?: string
    aggregate?: WorkAggregate
  } = {}) {
    super(message)
    this.name = 'AuthoringServiceError'
    this.code = code
    this.status = options.status ?? statusForCode(code)
    this.field = options.field
    this.mediaId = options.mediaId
    this.uploadId = options.uploadId
    this.currentRevision = options.currentRevision
    this.aggregate = options.aggregate
  }
}

function statusForCode(code: AuthoringErrorCode): number {
  switch (code) {
    case 'unauthorized': return 401
    case 'not_found': return 404
    case 'unsupported_file': return 415
    case 'oversize_file': return 413
    case 'stale_revision':
    case 'conflict': return 409
    case 'r2_transfer_failed':
    case 'publication_failed': return 502
    default: return 400
  }
}

function revisionToken(): string {
  return `rev_${randomUUID()}`
}

function cleanOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const result = String(value).trim()
  return result || undefined
}

function safeWorkId(value: string): string {
  const workId = String(value || '').trim()
  if (!workId) throw new AuthoringServiceError('validation', 'Work ID 不能为空。', { field: 'workId' })
  return workId
}

function validateWorkMetadata(input: { title: unknown; author: unknown }): { title: string; author: string } {
  const title = String(input.title || '').trim()
  const author = String(input.author || '').trim()
  if (!title) throw new AuthoringServiceError('validation', 'Work 标题不能为空。', { field: 'title' })
  if (!author) throw new AuthoringServiceError('validation', 'Work 作者不能为空。', { field: 'author' })
  return { title, author }
}

function validateUpload(input: { filename: unknown; filesize: unknown; mimeType: unknown }): {
  filename: string
  filesize: number
  mimeType: string
} {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  if (!filename) throw new AuthoringServiceError('validation', '媒体文件名不能为空。', { field: 'filename' })
  const filesize = Number(input.filesize)
  if (!Number.isSafeInteger(filesize) || filesize < 0) throw new AuthoringServiceError('validation', '媒体文件大小无效。', { field: 'filesize' })
  if (filesize > MAX_MEDIA_SIZE) throw new AuthoringServiceError('oversize_file', '媒体文件不能超过 100 MB。', { field: 'filesize' })
  try {
    return { filename, filesize, mimeType: validateMediaMimeType(input.mimeType) }
  } catch {
    throw new AuthoringServiceError('unsupported_file', '仅支持图片（不含 SVG）或 PDF 媒体文件。', { field: 'mimeType' })
  }
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.')
  return index > 0 ? filename.slice(index + 1).toLowerCase() : ''
}

function cloneManifest(media: StoredManifestEntry[]): StoredManifestEntry[] {
  return media.map((item) => ({ ...item }))
}

function cloneStoredWork(work: StoredWork): StoredWork {
  return {
    ...work,
    media: cloneManifest(work.media),
    published: work.published ? { ...work.published, media: cloneManifest(work.published.media) } : undefined,
  }
}

function cloneStoredMedia(media: StoredMedia): StoredMedia {
  return { ...media, uploadContext: media.uploadContext ? { ...media.uploadContext } : undefined }
}

function sameUploadContext(left: UploadContext | undefined, right: UploadContext | undefined): boolean {
  if (!left || !right) return false
  return left.version === right.version
    && left.collection === right.collection
    && left.storageKey === right.storageKey
    && left.filename === right.filename
    && left.filesize === right.filesize
    && left.mimeType === right.mimeType
    && left.expiresAt === right.expiresAt
    && left.workId === right.workId
    && left.uploadId === right.uploadId
    && left.signature === right.signature
}

function normalizeManifestEntry(entry: ManifestSaveEntry, media: StoredMedia): StoredManifestEntry {
  const filename = String(entry.filename || '').trim()
  const originalExtension = extensionOf(media.filename) || mediaFlags(media.mimeType).extension
  if (!filename) throw new AuthoringServiceError('validation', '媒体文件名不能为空。', { field: 'filename', mediaId: media.id })
  if (!originalExtension || extensionOf(filename) !== originalExtension) {
    throw new AuthoringServiceError('validation', '媒体文件扩展名不能修改。', { field: 'filename', mediaId: media.id })
  }
  return { mediaId: media.id, filename, alt: cleanOptional(entry.alt), caption: cleanOptional(entry.caption) }
}

function mediaFlags(mimeType: string): Pick<MediaManifestItem, 'isImage' | 'isPdf' | 'extension'> {
  const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1] || ''
  return { extension, isImage: mimeType.startsWith('image/'), isPdf: mimeType === 'application/pdf' }
}

function toManifestItem(entry: StoredManifestEntry, media: StoredMedia): MediaManifestItem {
  const flags = mediaFlags(media.mimeType)
  return {
    mediaId: media.id,
    filename: entry.filename,
    extension: extensionOf(entry.filename) || flags.extension,
    mimeType: media.mimeType,
    filesize: media.filesize,
    alt: entry.alt,
    caption: entry.caption,
    contentFingerprint: media.contentFingerprint,
    isImage: flags.isImage,
    isPdf: flags.isPdf,
  }
}

export class AuthoringService {
  private readonly now: () => number
  private readonly makeRevision: () => string
  private readonly uploadSecret?: string

  constructor(
    private readonly repository: WorkAuthoringRepository,
    private readonly objectStore: AuthoringObjectStore,
    options: { now?: () => number; makeRevision?: () => string; uploadSecret?: string } = {},
  ) {
    this.now = options.now || Date.now
    this.makeRevision = options.makeRevision || revisionToken
    this.uploadSecret = options.uploadSecret
  }

  async createWork(input: CreateWorkRequest, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const metadata = validateWorkMetadata(input)
    const work = await this.repository.createWork({
      ...metadata,
      description: cleanOptional(input.description),
      revision: this.makeRevision(),
      req,
    })
    return this.aggregate(work, await this.repository.getPublished(work.id, req), req)
  }

  async getWork(workId: string, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const id = safeWorkId(workId)
    const work = await this.requireDraft(id, req)
    return this.aggregate(work, await this.repository.getPublished(id, req), req)
  }

  async saveDraft(workId: string, input: SaveDraftRequest, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const id = safeWorkId(workId)
    const result = await this.repository.withWorkLock(id, req, async (transactionReq) => {
      const work = await this.requireDraft(id, transactionReq)
      this.ensureRevision(work, input.revision)
      const metadata = validateWorkMetadata(input)
      const media = await this.validateManifest(id, input.media, transactionReq)
      const published = await this.repository.getPublished(id, transactionReq)
      const nextMediaIds = new Set(media.map((entry) => entry.mediaId))
      const publishedMediaIds = new Set(published?.media.map((entry) => entry.mediaId) || [])
      const cleanup: StoredMedia[] = []
      const allMedia = await this.repository.listMedia(id, transactionReq)
      let saved = await this.repository.saveDraft({
        workId: id,
        expectedRevision: input.revision,
        revision: this.makeRevision(),
        title: metadata.title,
        author: metadata.author,
        description: cleanOptional(input.description),
        media,
        req: transactionReq,
      })
      for (const candidate of allMedia) {
        if (nextMediaIds.has(candidate.id) || publishedMediaIds.has(candidate.id) || candidate.everPublished) continue
        saved = await this.repository.discardMedia({
          workId: id,
          mediaId: candidate.id,
          expectedRevision: saved.revision,
          revision: this.makeRevision(),
          req: transactionReq,
        })
        await this.repository.recordCleanupIntent({ workId: id, mediaId: candidate.id, storageKey: candidate.storageKey, req: transactionReq })
        cleanup.push(candidate)
      }
      return { work: saved, cleanup }
    })
    for (const media of result.cleanup) {
      await this.deleteCleanupObject({ workId: id, mediaId: media.id, storageKey: media.storageKey }, req)
    }
    return this.aggregate(result.work, await this.repository.getPublished(id, req), req)
  }

  async authorizeUpload(workId: string, input: AuthorizeUploadRequest, req?: AuthoringRequestContext): Promise<AuthorizeUploadResponse> {
    const id = safeWorkId(workId)
    const result = await this.repository.withWorkLock(id, req, async (transactionReq) => {
      const work = await this.requireDraft(id, transactionReq)
      this.ensureRevision(work, input.revision)
      const upload = validateUpload(input)
      if (input.replaceMediaId) {
        if (!work.media.some((entry) => entry.mediaId === input.replaceMediaId)) {
          throw new AuthoringServiceError('validation', '待替换 Media 不在当前草稿中。', { mediaId: input.replaceMediaId })
        }
        const replacement = await this.repository.getMedia(input.replaceMediaId, transactionReq)
        if (!replacement || replacement.workId !== id || replacement.status !== 'finalized') {
          throw new AuthoringServiceError('validation', '待替换 Media 不存在或不可用。', { mediaId: input.replaceMediaId })
        }
      }
      const uploadId = `upload_${randomUUID()}`
      const storageKey = createStorageKey()
      const context = createUploadContext({
        ...upload,
        storageKey,
        workId: id,
        uploadId,
      }, { secret: this.uploadSecret })
      const media = await this.repository.createPendingMedia({
        workId: id,
        uploadId,
        filename: upload.filename,
        filesize: upload.filesize,
        mimeType: upload.mimeType,
        storageKey,
        replaceMediaId: input.replaceMediaId,
        selectionIndex: input.selectionIndex,
        uploadContext: context,
        req: transactionReq,
      })
      let signed: AuthorizeUploadResult
      try {
        signed = await this.objectStore.authorizeUpload({
          storageKey,
          context,
          filename: upload.filename,
          filesize: upload.filesize,
          mimeType: upload.mimeType,
        })
      } catch {
        throw new AuthoringServiceError('r2_transfer_failed', 'R2 上传授权失败，请重试。', { uploadId })
      }
      // Registration is pending-upload bookkeeping, not a change to the
      // versioned Work aggregate. Finalization is the aggregate mutation that
      // advances the revision, which also lets the browser authorize a batch
      // in parallel before serializing finalization.
      return { revision: work.revision, media, signed }
    })
    return {
      revision: result.revision,
      upload: {
        uploadId: result.media.uploadId!,
        putUrl: result.signed.putUrl,
        headers: result.signed.headers,
        expiresAt: result.signed.expiresAt,
        storageKey: result.media.storageKey,
        context: result.signed.context,
      },
    }
  }

  async finalizeUpload(workId: string, input: FinalizeUploadRequest, req?: AuthoringRequestContext): Promise<FinalizeUploadResponse> {
    const id = safeWorkId(workId)
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new AuthoringServiceError('validation', '上传幂等键不能为空。', { field: 'idempotencyKey', uploadId: input.uploadId })
    }
    const idempotencyKey = input.idempotencyKey.trim()
    const existing = await this.repository.findMediaByIdempotency(id, idempotencyKey, req)
    if (existing?.status === 'finalized') {
      if (existing.uploadId !== input.uploadId) {
        throw new AuthoringServiceError('conflict', '幂等键已用于另一份上传。', { uploadId: input.uploadId })
      }
      const now = this.now()
      const verified = verifyUploadContext(input.context, { secret: this.uploadSecret, now })
      const signedRetry = verified || verifyUploadContext(input.context, { secret: this.uploadSecret, now, allowExpired: true })
      const persisted = existing.uploadContext
        ? verifyUploadContext(existing.uploadContext, { secret: this.uploadSecret, now, allowExpired: true })
        : undefined
      const matchesStoredUpload = signedRetry
        && signedRetry.workId === id
        && signedRetry.uploadId === input.uploadId
        && signedRetry.storageKey === existing.storageKey
        && existing.filename === signedRetry.filename
        && existing.filesize === signedRetry.filesize
        && existing.mimeType === signedRetry.mimeType
        && (!existing.uploadContext || (persisted && sameUploadContext(persisted, signedRetry)))
      if (!matchesStoredUpload || (!verified && (!persisted || signedRetry!.expiresAt > now))) {
        throw new AuthoringServiceError('upload_authorization_expired', '上传授权已过期或无效。', { uploadId: input.uploadId })
      }
      const aggregate = await this.getWork(id, req)
      const mediaItem = aggregate.media.find((item) => item.mediaId === existing.id)
      if (!mediaItem) throw new AuthoringServiceError('conflict', '上传幂等记录与草稿不一致。', { uploadId: input.uploadId })
      return { ...aggregate, mediaItem }
    }
    const verified = verifyUploadContext(input.context, { secret: this.uploadSecret, now: this.now() })
    if (!verified || verified.workId !== id || verified.uploadId !== input.uploadId) {
      throw new AuthoringServiceError('upload_authorization_expired', '上传授权已过期或无效。', { uploadId: input.uploadId })
    }
    const head = await this.objectStore.head(verified.storageKey)
    if (!head) throw new AuthoringServiceError('upload_finalization_failed', 'R2 对象不存在，无法确认上传。', { uploadId: input.uploadId })
    if (head.size !== verified.filesize) throw new AuthoringServiceError('upload_finalization_failed', 'R2 对象大小与上传授权不一致。', { uploadId: input.uploadId })
    if (head.mimeType && head.mimeType !== verified.mimeType && head.mimeType !== 'application/octet-stream') {
      throw new AuthoringServiceError('upload_finalization_failed', 'R2 对象 MIME 与上传授权不一致。', { uploadId: input.uploadId })
    }

    const result = await this.repository.withWorkLock(id, req, async (transactionReq) => {
      const work = await this.requireDraft(id, transactionReq)
      const claimed = await this.repository.findMediaByIdempotency(id, idempotencyKey, transactionReq)
      if (claimed) {
        if (claimed.uploadId !== input.uploadId) {
          throw new AuthoringServiceError('conflict', '幂等键已用于另一份上传。', { uploadId: input.uploadId })
        }
      }
      const media = await this.repository.findMediaByUploadId(id, input.uploadId, transactionReq)
      if (!media || media.storageKey !== verified.storageKey) {
        throw new AuthoringServiceError('upload_finalization_failed', '上传登记不存在。', { uploadId: input.uploadId })
      }
      if (media.uploadContext) {
        const persisted = verifyUploadContext(media.uploadContext, { secret: this.uploadSecret, now: this.now(), allowExpired: true })
        if (!persisted || !sameUploadContext(persisted, verified)) {
          throw new AuthoringServiceError('conflict', '上传登记与授权上下文不一致。', { uploadId: input.uploadId })
        }
      }
      if (media.status === 'finalized') {
        if (media.idempotencyKey !== idempotencyKey) {
          throw new AuthoringServiceError('conflict', '上传已使用另一幂等键确认。', { uploadId: input.uploadId, mediaId: media.id })
        }
        return { work, media }
      }
      this.ensureRevision(work, input.revision)
      const nextManifest = cloneManifest(work.media)
      const entry: StoredManifestEntry = { mediaId: media.id, filename: media.filename }
      if (media.replaceMediaId) {
        const targetIndex = nextManifest.findIndex((item) => item.mediaId === media.replaceMediaId)
        if (targetIndex < 0) throw new AuthoringServiceError('validation', '待替换 Media 不在当前草稿中。', { mediaId: media.replaceMediaId })
        entry.caption = nextManifest[targetIndex].caption
        nextManifest[targetIndex] = entry
      } else {
        const requestedSelectionIndex = input.selectionIndex ?? media.selectionIndex
        const selectionIndex = Number.isSafeInteger(requestedSelectionIndex) ? Math.max(0, Number(requestedSelectionIndex)) : nextManifest.length
        nextManifest.splice(Math.min(selectionIndex, nextManifest.length), 0, entry)
      }
      const updated = await this.repository.finalizeUpload({
        workId: id,
        mediaId: media.id,
        expectedRevision: input.revision,
        revision: this.makeRevision(),
        idempotencyKey,
        contentFingerprint: input.contentFingerprint,
        media: nextManifest,
        req: transactionReq,
      })
      return { work: updated, media: { ...media, status: 'finalized' as const, contentFingerprint: input.contentFingerprint } }
    })
    const aggregate = await this.aggregate(result.work, await this.repository.getPublished(id, req), req)
    const mediaItem = aggregate.media.find((item) => item.mediaId === result.media.id)
    if (!mediaItem) throw new AuthoringServiceError('upload_finalization_failed', '上传 Media 未进入草稿。', { uploadId: input.uploadId })
    const probableDuplicate = input.contentFingerprint
      ? (await this.repository.listMedia(id, req)).find((item) => item.id !== result.media.id && item.contentFingerprint === input.contentFingerprint && item.status === 'finalized')
      : undefined
    return {
      ...aggregate,
      mediaItem,
      probableDuplicate: probableDuplicate ? { existingMediaId: probableDuplicate.id, filename: probableDuplicate.filename } : undefined,
    }
  }

  async discardMedia(workId: string, mediaId: string, revision: string, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const id = safeWorkId(workId)
    const result = await this.repository.withWorkLock(id, req, async (transactionReq) => {
      const work = await this.requireDraft(id, transactionReq)
      this.ensureRevision(work, revision)
      const media = await this.repository.getMedia(mediaId, transactionReq)
      if (!media || media.workId !== id) throw new AuthoringServiceError('not_found', 'Media 不存在。', { mediaId })
      const published = await this.repository.getPublished(id, transactionReq)
      if (media.everPublished || published?.media.some((item) => item.mediaId === mediaId)) {
        throw new AuthoringServiceError('conflict', 'Published Work 仍引用该 Media，不能删除。', { mediaId })
      }
      const updated = await this.repository.discardMedia({
        workId: id,
        mediaId,
        expectedRevision: revision,
        revision: this.makeRevision(),
        req: transactionReq,
      })
      await this.repository.recordCleanupIntent({ workId: id, mediaId, storageKey: media.storageKey, req: transactionReq })
      return { updated, media }
    })
    await this.deleteCleanupObject({ workId: id, mediaId, storageKey: result.media.storageKey }, req)
    return this.aggregate(result.updated, await this.repository.getPublished(id, req), req)
  }

  /** Process durable cleanup intents; safe to call from a cron/queue worker. */
  async retryCleanup(limit = 50, req?: AuthoringRequestContext): Promise<{ processed: number; deleted: number; failed: number }> {
    const intents = await this.repository.claimCleanupIntents({ limit: Math.max(1, Math.min(500, Math.floor(limit))), req })
    let deleted = 0
    let failed = 0
    for (const intent of intents) {
      const success = await this.deleteCleanupObject(intent, req)
      if (success) deleted += 1
      else failed += 1
    }
    return { processed: intents.length, deleted, failed }
  }

  async publish(workId: string, input: { revision: string }, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const id = safeWorkId(workId)
    const result = await this.repository.withWorkLock(id, req, async (transactionReq) => {
      const work = await this.requireDraft(id, transactionReq)
      this.ensureRevision(work, input.revision)
      validateWorkMetadata(work)
      const allMedia = await this.repository.listMedia(id, transactionReq)
      const byId = new Map(allMedia.map((item) => [item.id, item]))
      if (!work.media.length) throw new AuthoringServiceError('validation', 'Work 至少需要一个可读 Media。', { field: 'media' })
      for (const entry of work.media) {
        const media = byId.get(entry.mediaId)
        if (!media || media.status !== 'finalized' || media.withdrawnAt) {
          throw new AuthoringServiceError('validation', 'Work 包含未完成或不可读的 Media。', { mediaId: entry.mediaId })
        }
      }
      if (allMedia.some((item) => item.status === 'pending')) {
        throw new AuthoringServiceError('validation', '仍有上传中的 Media，暂不能发布。', { field: 'media' })
      }
      return this.repository.publish({ workId: id, expectedRevision: input.revision, revision: this.makeRevision(), req: transactionReq })
    }).catch((error) => {
      if (error instanceof AuthoringServiceError) throw error
      throw new AuthoringServiceError('publication_failed', '发布失败，草稿已保留，可重试。')
    })
    return this.aggregate(result, await this.repository.getPublished(id, req), req)
  }

  private async requireDraft(workId: string, req?: AuthoringRequestContext): Promise<StoredWork> {
    const work = await this.repository.getDraft(workId, req)
    if (!work) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    return work
  }

  private ensureRevision(work: StoredWork, expected: string): void {
    if (work.revision === expected) return
    throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品，请刷新后重新应用更改。', {
      currentRevision: work.revision,
    })
  }

  private async deleteCleanupObject(intent: Pick<CleanupIntent, 'workId' | 'mediaId' | 'storageKey'> & Partial<Pick<CleanupIntent, 'attempts'>>, req?: AuthoringRequestContext): Promise<boolean> {
    // Retry claims increment the durable attempt counter before this R2 call;
    // direct cleanup from a draft mutation starts at attempt one.
    const attempts = Math.max(1, intent.attempts || 0)
    try {
      await this.objectStore.delete(intent.storageKey)
      await this.repository.markCleanupIntent({ storageKey: intent.storageKey, status: 'deleted', attempts, req })
      return true
    } catch (error) {
      await this.repository.markCleanupIntent({
        storageKey: intent.storageKey,
        status: 'failed',
        attempts,
        lastError: error instanceof Error ? error.message : String(error),
        req,
      }).catch((): undefined => undefined)
      return false
    }
  }

  private async validateManifest(workId: string, entries: ManifestSaveEntry[], req?: AuthoringRequestContext): Promise<StoredManifestEntry[]> {
    if (!Array.isArray(entries)) throw new AuthoringServiceError('validation', 'Media manifest 必须是数组。', { field: 'media' })
    const result: StoredManifestEntry[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const mediaId = String(entry?.mediaId || '').trim()
      if (!mediaId || seen.has(mediaId)) throw new AuthoringServiceError('validation', 'Media manifest 不能包含重复项。', { field: 'media' })
      const media = await this.repository.getMedia(mediaId, req)
      if (!media || media.workId !== workId || media.status !== 'finalized' || media.withdrawnAt) {
        throw new AuthoringServiceError('validation', 'Media 不属于该 Work 或尚未完成上传。', { mediaId })
      }
      seen.add(mediaId)
      result.push(normalizeManifestEntry(entry, media))
    }
    return result
  }

  private async aggregate(work: StoredWork, published: StoredPublishedSnapshot | null | undefined, req?: AuthoringRequestContext): Promise<WorkAggregate> {
    const allMedia = await this.repository.listMedia(work.id, req)
    const byId = new Map(allMedia.map((item) => [item.id, item]))
    const toItems = (manifest: StoredManifestEntry[]): MediaManifestItem[] => manifest
      .map((entry) => {
        const media = byId.get(entry.mediaId)
        return media && media.status === 'finalized' && !media.withdrawnAt ? toManifestItem(entry, media) : undefined
      })
      .filter(Boolean) as MediaManifestItem[]
    const snapshot = published || work.published
    const publishedSummary = snapshot ? {
      revision: snapshot.revision,
      title: snapshot.title,
      author: snapshot.author,
      description: snapshot.description,
      media: toItems(snapshot.media),
      publishedAt: snapshot.publishedAt,
    } : undefined
    const publicationStatus = publishedSummary
      ? publishedSummary.revision === work.revision ? 'published' : 'unpublished_draft'
      : 'draft'
    return {
      workId: work.id,
      archiveId: work.archiveId,
      revision: work.revision,
      publicationStatus,
      title: work.title,
      author: work.author,
      description: work.description,
      media: toItems(work.media),
      published: publishedSummary,
    }
  }
}

export class InMemoryAuthoringObjectStore implements AuthoringObjectStore {
  private readonly objects = new Map<string, { size: number; mimeType: string }>()

  async authorizeUpload(input: { storageKey: string; context: UploadContext; filename: string; filesize: number; mimeType: string }): Promise<AuthorizeUploadResult> {
    return {
      putUrl: `https://r2.example.test/upload/${encodeURIComponent(input.storageKey)}`,
      headers: { 'Content-Type': input.mimeType, 'Content-Length': String(input.filesize) },
      expiresAt: new Date(input.context.expiresAt).toISOString(),
      context: input.context,
    }
  }

  put(storageKey: string, size: number, mimeType: string): void {
    this.objects.set(storageKey, { size, mimeType })
  }

  async head(storageKey: string): Promise<{ size: number; mimeType?: string } | null> {
    return this.objects.get(storageKey) || null
  }

  async delete(storageKey: string): Promise<void> {
    this.objects.delete(storageKey)
  }
}

export class InMemoryWorkAuthoringRepository implements WorkAuthoringRepository {
  private sequence = 0
  private mediaSequence = 0
  private readonly works = new Map<string, StoredWork>()
  private readonly media = new Map<string, StoredMedia>()
  readonly cleanupIntents = new Map<string, CleanupIntent>()
  private readonly locks = new Map<string, Promise<void>>()

  async createWork(input: { title: string; author: string; description?: string; revision: string }): Promise<StoredWork> {
    this.sequence += 1
    const work: StoredWork = {
      id: `work-${this.sequence}`,
      archiveId: `W${this.sequence}`,
      revision: input.revision,
      title: input.title,
      author: input.author,
      description: input.description,
      media: [],
    }
    this.works.set(work.id, work)
    return cloneStoredWork(work)
  }

  async getDraft(workId: string): Promise<StoredWork | null> {
    const work = this.works.get(workId)
    return work ? cloneStoredWork(work) : null
  }

  async getPublished(workId: string): Promise<StoredPublishedSnapshot | null> {
    const published = this.works.get(workId)?.published
    return published ? { ...published, media: cloneManifest(published.media) } : null
  }

  async listMedia(workId: string): Promise<StoredMedia[]> {
    return [...this.media.values()].filter((item) => item.workId === workId).map(cloneStoredMedia)
  }

  async getMedia(mediaId: string): Promise<StoredMedia | null> {
    const media = this.media.get(mediaId)
    return media ? cloneStoredMedia(media) : null
  }

  async findMediaByIdempotency(workId: string, key: string): Promise<StoredMedia | null> {
    const media = [...this.media.values()].find((item) => item.workId === workId && item.idempotencyKey === key)
    return media ? cloneStoredMedia(media) : null
  }

  async findMediaByUploadId(workId: string, uploadId: string): Promise<StoredMedia | null> {
    const media = [...this.media.values()].find((item) => item.workId === workId && item.uploadId === uploadId)
    return media ? cloneStoredMedia(media) : null
  }

  async saveDraft(input: { workId: string; expectedRevision: string; revision: string; title: string; author: string; description?: string; media: StoredManifestEntry[] }): Promise<StoredWork> {
    const work = this.works.get(input.workId)
    if (!work) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (work.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: work.revision })
    Object.assign(work, {
      revision: input.revision,
      title: input.title,
      author: input.author,
      description: input.description,
      media: cloneManifest(input.media),
    })
    return cloneStoredWork(work)
  }

  async createPendingMedia(input: { workId: string; uploadId: string; filename: string; filesize: number; mimeType: string; storageKey: string; replaceMediaId?: string; selectionIndex?: number; uploadContext?: UploadContext }): Promise<StoredMedia> {
    this.mediaSequence += 1
    const media: StoredMedia = {
      id: `media-${this.mediaSequence}`,
      workId: input.workId,
      filename: input.filename,
      filesize: input.filesize,
      mimeType: input.mimeType,
      storageKey: input.storageKey,
      status: 'pending',
      uploadId: input.uploadId,
      replaceMediaId: input.replaceMediaId,
      selectionIndex: input.selectionIndex,
      uploadContext: input.uploadContext,
    }
    this.media.set(media.id, media)
    return cloneStoredMedia(media)
  }

  async finalizeUpload(input: { workId: string; mediaId: string; expectedRevision: string; revision: string; idempotencyKey?: string; contentFingerprint?: string; media: StoredManifestEntry[] }): Promise<StoredWork> {
    const work = this.works.get(input.workId)
    const media = this.media.get(input.mediaId)
    if (!work || !media) throw new AuthoringServiceError('not_found', 'Work 或 Media 不存在。')
    if (work.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: work.revision })
    media.status = 'finalized'
    media.idempotencyKey = input.idempotencyKey
    media.contentFingerprint = input.contentFingerprint
    work.revision = input.revision
    work.media = cloneManifest(input.media)
    return cloneStoredWork(work)
  }

  async discardMedia(input: { workId: string; mediaId: string; expectedRevision: string; revision: string }): Promise<StoredWork> {
    const work = this.works.get(input.workId)
    if (!work || !this.media.has(input.mediaId)) throw new AuthoringServiceError('not_found', 'Work 或 Media 不存在。')
    if (work.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: work.revision })
    this.media.delete(input.mediaId)
    work.media = work.media.filter((item) => item.mediaId !== input.mediaId)
    work.revision = input.revision
    return cloneStoredWork(work)
  }

  async publish(input: { workId: string; expectedRevision: string; revision: string }): Promise<StoredWork> {
    const work = this.works.get(input.workId)
    if (!work) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (work.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: work.revision })
    for (const entry of work.media) {
      const media = this.media.get(entry.mediaId)
      if (media) media.everPublished = true
    }
    work.revision = input.revision
    work.published = {
      revision: input.revision,
      title: work.title,
      author: work.author,
      description: work.description,
      media: cloneManifest(work.media),
      publishedAt: new Date().toISOString(),
    }
    return cloneStoredWork(work)
  }

  async recordCleanupIntent(input: { workId: string; mediaId: string; storageKey: string }): Promise<void> {
    const previous = this.cleanupIntents.get(input.storageKey)
    this.cleanupIntents.set(input.storageKey, {
      ...input,
      status: 'pending',
      attempts: previous?.attempts || 0,
      lastError: undefined,
    })
  }

  async listCleanupIntents(input: { limit: number }): Promise<CleanupIntent[]> {
    return [...this.cleanupIntents.values()]
      .filter((intent) => intent.status === 'pending' || intent.status === 'failed')
      .slice(0, input.limit)
      .map((intent) => ({ ...intent }))
  }

  async claimCleanupIntents(input: { limit: number }): Promise<CleanupIntent[]> {
    const claimed = [...this.cleanupIntents.values()]
      .filter((intent) => intent.status === 'pending' || intent.status === 'failed')
      .slice(0, input.limit)
      .map((intent) => {
        const next = { ...intent, status: 'processing' as const, attempts: Math.max(1, intent.attempts + 1) }
        this.cleanupIntents.set(intent.storageKey, next)
        return { ...next }
      })
    return claimed
  }

  async markCleanupIntent(input: { storageKey: string; status: CleanupIntent['status']; attempts: number; lastError?: string }): Promise<void> {
    const intent = this.cleanupIntents.get(input.storageKey)
    if (!intent) return
    this.cleanupIntents.set(input.storageKey, { ...intent, status: input.status, attempts: input.attempts, lastError: input.lastError })
  }

  async withWorkLock<T>(workId: string, req: AuthoringRequestContext | undefined, callback: (transactionReq: AuthoringRequestContext) => Promise<T>): Promise<T> {
    const previous = this.locks.get(workId)
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(workId, current)
    if (previous) await previous
    try {
      return await callback(req || {})
    } finally {
      release()
      if (this.locks.get(workId) === current) this.locks.delete(workId)
    }
  }
}
