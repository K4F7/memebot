import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction } from 'payload'

import type {
  AuthoringRequestContext,
  CleanupIntent,
  StoredManifestEntry,
  StoredMedia,
  StoredPublishedSnapshot,
  StoredWork,
  WorkAuthoringRepository,
} from './work-authoring'
import { verifyUploadContext, type UploadContext } from './media-policy'
import { AuthoringServiceError } from './work-authoring'

type PayloadLike = {
  create(args: Record<string, unknown>): Promise<any>
  update(args: Record<string, unknown>): Promise<any>
  delete(args: Record<string, unknown>): Promise<any>
  find(args: Record<string, unknown>): Promise<{ docs?: any[] }>
  findByID(args: Record<string, unknown>): Promise<any>
  db?: any
  logger?: { error: (...args: unknown[]) => void }
}

function relationId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id)
  return undefined
}

function requestFor(payload: PayloadLike, input?: AuthoringRequestContext): any {
  const req = (input || {}) as any
  req.payload = payload
  if (req.user === undefined && (input as any)?.user !== undefined) req.user = (input as any).user
  req.headers ||= new Headers()
  req.context = { ...(req.context || {}), workAuthoring: true }
  req.routeParams ||= {}
  req.query ||= {}
  return req
}

async function requestDatabase(payload: PayloadLike, req: any): Promise<any> {
  const transactionID = req.transactionID ? await req.transactionID : undefined
  return transactionID ? payload.db?.sessions?.[transactionID]?.db : payload.db?.drizzle
}

function manifest(value: unknown): StoredManifestEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => ({
    mediaId: String(entry?.mediaId || ''),
    filename: String(entry?.filename || ''),
    alt: entry?.alt ? String(entry.alt) : undefined,
    caption: entry?.caption ? String(entry.caption) : undefined,
  })).filter((entry) => entry.mediaId && entry.filename)
}

function toStoredWork(doc: any): StoredWork {
  return {
    id: String(doc.id),
    archiveId: String(doc.archiveId || ''),
    revision: String(doc.revision || ''),
    title: String(doc.title || ''),
    author: String(doc.author || ''),
    description: doc.description ? String(doc.description) : undefined,
    media: manifest(doc.mediaManifest),
  }
}

function toStoredMedia(doc: any): StoredMedia {
  const uploadContext = doc.uploadContext && typeof doc.uploadContext === 'object'
    ? verifyUploadContext(doc.uploadContext, {
      allowExpired: true,
      secret: process.env.ARCHIVE_MEDIA_SIGNING_SECRET || process.env.PAYLOAD_SECRET,
    }) || undefined
    : undefined
  return {
    id: String(doc.id),
    workId: relationId(doc.work) || '',
    filename: String(doc.filename || ''),
    mimeType: String(doc.mimeType || ''),
    filesize: Number(doc.filesize || 0),
    alt: doc.alt ? String(doc.alt) : undefined,
    storageKey: String(doc.storageKey || ''),
    status: doc.uploadStatus === 'finalized' ? 'finalized' : 'pending',
    withdrawnAt: doc.withdrawnAt ? String(doc.withdrawnAt) : undefined,
    uploadId: doc.uploadId ? String(doc.uploadId) : undefined,
    idempotencyKey: doc.idempotencyKey ? String(doc.idempotencyKey) : undefined,
    contentFingerprint: doc.contentFingerprint ? String(doc.contentFingerprint) : undefined,
    replaceMediaId: doc.replaceMediaId ? String(doc.replaceMediaId) : undefined,
    selectionIndex: Number.isSafeInteger(Number(doc.selectionIndex)) ? Number(doc.selectionIndex) : undefined,
    everPublished: Boolean(doc.everPublished),
    uploadContext,
  }
}

export class PayloadWorkAuthoringRepository implements WorkAuthoringRepository {
  constructor(private readonly payload: PayloadLike) {}

  async createWork(input: { title: string; author: string; description?: string; revision: string; req?: AuthoringRequestContext }): Promise<StoredWork> {
    const req = requestFor(this.payload, input.req)
    const doc = await this.payload.create({
      collection: 'works',
      data: {
        title: input.title,
        author: input.author,
        description: input.description,
        revision: input.revision,
        mediaManifest: [],
      },
      draft: true,
      overrideAccess: true,
      req,
    })
    return toStoredWork(doc)
  }

  async getDraft(workId: string, input?: AuthoringRequestContext): Promise<StoredWork | null> {
    const doc = await this.payload.findByID({
      collection: 'works',
      id: workId,
      depth: 0,
      draft: true,
      disableErrors: true,
      overrideAccess: true,
      req: requestFor(this.payload, input),
    })
    return doc ? toStoredWork(doc) : null
  }

  async getPublished(workId: string, input?: AuthoringRequestContext): Promise<StoredPublishedSnapshot | null> {
    const doc = await this.payload.findByID({
      collection: 'works',
      id: workId,
      depth: 0,
      draft: false,
      disableErrors: true,
      overrideAccess: true,
      req: requestFor(this.payload, input),
    })
    if (!doc || doc._status !== 'published' || !doc.publishedAt) return null
    return {
      revision: String(doc.revision || ''),
      title: String(doc.title || ''),
      author: String(doc.author || ''),
      description: doc.description ? String(doc.description) : undefined,
      media: manifest(doc.mediaManifest),
      publishedAt: new Date(doc.publishedAt || doc.updatedAt || Date.now()).toISOString(),
    }
  }

  async listMedia(workId: string, input?: AuthoringRequestContext): Promise<StoredMedia[]> {
    const result = await this.payload.find({
      collection: 'media',
      depth: 0,
      limit: 0,
      pagination: false,
      overrideAccess: true,
      req: requestFor(this.payload, input),
      where: { work: { equals: workId } },
    })
    return (result.docs || []).map(toStoredMedia)
  }

  async getMedia(mediaId: string, input?: AuthoringRequestContext): Promise<StoredMedia | null> {
    const doc = await this.payload.findByID({
      collection: 'media',
      id: mediaId,
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req: requestFor(this.payload, input),
    })
    return doc ? toStoredMedia(doc) : null
  }

  async findMediaByIdempotency(workId: string, key: string, input?: AuthoringRequestContext): Promise<StoredMedia | null> {
    if (!key) return null
    const result = await this.payload.find({
      collection: 'media', depth: 0, limit: 1, pagination: false, overrideAccess: true,
      req: requestFor(this.payload, input),
      where: { and: [{ work: { equals: workId } }, { idempotencyKey: { equals: key } }] },
    })
    return result.docs?.[0] ? toStoredMedia(result.docs[0]) : null
  }

  async findMediaByUploadId(workId: string, uploadId: string, input?: AuthoringRequestContext): Promise<StoredMedia | null> {
    const result = await this.payload.find({
      collection: 'media', depth: 0, limit: 1, pagination: false, overrideAccess: true,
      req: requestFor(this.payload, input),
      where: { and: [{ work: { equals: workId } }, { uploadId: { equals: uploadId } }] },
    })
    return result.docs?.[0] ? toStoredMedia(result.docs[0]) : null
  }

  async saveDraft(input: { workId: string; expectedRevision: string; revision: string; title: string; author: string; description?: string; media: StoredManifestEntry[]; req?: AuthoringRequestContext }): Promise<StoredWork> {
    const req = requestFor(this.payload, input.req)
    const current = await this.getDraft(input.workId, req)
    if (!current) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (current.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: current.revision })
    const doc = await this.payload.update({
      collection: 'works', id: input.workId, draft: true, overrideAccess: true, req,
      data: { title: input.title, author: input.author, description: input.description, revision: input.revision, mediaManifest: input.media },
    })
    return toStoredWork(doc)
  }

  async createPendingMedia(input: { workId: string; uploadId: string; filename: string; filesize: number; mimeType: string; storageKey: string; replaceMediaId?: string; selectionIndex?: number; uploadContext?: UploadContext; req?: AuthoringRequestContext }): Promise<StoredMedia> {
    const req = requestFor(this.payload, input.req)
    // Payload's upload operation requires a multipart file. Authoring creates
    // the metadata row before the browser's direct R2 PUT, so insert that
    // pending row on the same transaction connection instead of inventing a
    // placeholder file.
    const db = await requestDatabase(this.payload, req)
    if (!db?.execute) throw new AuthoringServiceError('r2_transfer_failed', '数据库暂时不可用于登记上传。', { uploadId: input.uploadId })
    const uploadContext = input.uploadContext ? JSON.stringify(input.uploadContext) : null
    const result = await db.execute(sql`
      INSERT INTO media (
        work_id, filename, mime_type, filesize, storage_key, upload_id,
        upload_status, replace_media_id, selection_index, upload_context
      ) VALUES (
        ${input.workId}, ${input.filename}, ${input.mimeType}, ${input.filesize},
        ${input.storageKey}, ${input.uploadId}, 'pending', ${input.replaceMediaId || null},
        ${input.selectionIndex ?? null}, ${uploadContext}::jsonb
      )
      RETURNING id, work_id AS work, filename, mime_type AS "mimeType", filesize,
        storage_key AS "storageKey", upload_status AS "uploadStatus",
        upload_id AS "uploadId", replace_media_id AS "replaceMediaId",
        selection_index AS "selectionIndex", ever_published AS "everPublished",
        upload_context AS "uploadContext"
    `)
    const doc = result.rows?.[0]
    if (!doc) throw new AuthoringServiceError('r2_transfer_failed', '数据库未能登记上传。', { uploadId: input.uploadId })
    return toStoredMedia(doc)
  }

  async finalizeUpload(input: { workId: string; mediaId: string; expectedRevision: string; revision: string; idempotencyKey?: string; contentFingerprint?: string; media: StoredManifestEntry[]; req?: AuthoringRequestContext }): Promise<StoredWork> {
    const req = requestFor(this.payload, input.req)
    const current = await this.getDraft(input.workId, req)
    if (!current) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (current.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: current.revision })
    await this.payload.update({
      collection: 'media', id: input.mediaId, overrideAccess: true, req,
      data: { uploadStatus: 'finalized', idempotencyKey: input.idempotencyKey, contentFingerprint: input.contentFingerprint },
    })
    const doc = await this.payload.update({
      collection: 'works', id: input.workId, draft: true, overrideAccess: true, req,
      data: { revision: input.revision, mediaManifest: input.media },
    })
    return toStoredWork(doc)
  }

  async discardMedia(input: { workId: string; mediaId: string; expectedRevision: string; revision: string; req?: AuthoringRequestContext }): Promise<StoredWork> {
    const req = requestFor(this.payload, input.req)
    const current = await this.getDraft(input.workId, req)
    if (!current) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (current.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: current.revision })
    await this.payload.delete({ collection: 'media', id: input.mediaId, overrideAccess: true, req })
    const doc = await this.payload.update({
      collection: 'works', id: input.workId, draft: true, overrideAccess: true, req,
      data: { revision: input.revision, mediaManifest: current.media.filter((item) => item.mediaId !== input.mediaId) },
    })
    return toStoredWork(doc)
  }

  async publish(input: { workId: string; expectedRevision: string; revision: string; req?: AuthoringRequestContext }): Promise<StoredWork> {
    const req = requestFor(this.payload, input.req)
    const current = await this.getDraft(input.workId, req)
    if (!current) throw new AuthoringServiceError('not_found', 'Work 不存在。')
    if (current.revision !== input.expectedRevision) throw new AuthoringServiceError('stale_revision', '其他编辑者已修改该作品。', { currentRevision: current.revision })
    for (const entry of current.media) {
      await this.payload.update({
        collection: 'media', id: entry.mediaId, overrideAccess: true, req,
        data: { everPublished: true },
      })
    }
    const doc = await this.payload.update({
      collection: 'works', id: input.workId, draft: false, overrideAccess: true, req,
      data: {
        title: current.title,
        author: current.author,
        description: current.description,
        revision: input.revision,
        mediaManifest: current.media,
        publishedAt: new Date().toISOString(),
        _status: 'published',
      },
    })
    return toStoredWork(doc)
  }

  async recordCleanupIntent(input: { workId: string; mediaId: string; storageKey: string; req?: AuthoringRequestContext }): Promise<void> {
    const req = requestFor(this.payload, input)
    const db = await requestDatabase(this.payload, req)
    if (!db?.execute) throw new AuthoringServiceError('publication_failed', '数据库暂时不可记录媒体清理意图。')
    await db.execute(sql`
      INSERT INTO media_cleanups (work_id, media_id, storage_key, status, attempts, last_error)
      VALUES (${input.workId}, ${input.mediaId}, ${input.storageKey}, 'pending', 0, NULL)
      ON CONFLICT (storage_key) DO UPDATE
      SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
    `)
  }

  async listCleanupIntents(input: { limit: number; req?: AuthoringRequestContext }): Promise<CleanupIntent[]> {
    const result = await this.payload.find({
      collection: 'media-cleanups', depth: 0, limit: input.limit, pagination: false, overrideAccess: true, req: requestFor(this.payload, input.req),
      where: { status: { in: ['pending', 'failed'] } },
      sort: 'updatedAt',
    })
    return (result.docs || []).map((doc) => ({
      workId: relationId(doc.work) || '',
      mediaId: String(doc.mediaId || ''),
      storageKey: String(doc.storageKey || ''),
      status: doc.status === 'failed' ? 'failed' : 'pending',
      attempts: Number(doc.attempts || 0),
      lastError: doc.lastError ? String(doc.lastError) : undefined,
    }))
  }

  async claimCleanupIntents(input: { limit: number; req?: AuthoringRequestContext }): Promise<CleanupIntent[]> {
    const req = requestFor(this.payload, input.req ? { ...input.req } : {})
    let started = false
    try {
      started = await initTransaction(req)
      const db = await requestDatabase(this.payload, req)
      if (!db?.execute) {
        if (started) await commitTransaction(req)
        return []
      }
      const result = await db.execute(sql`
        WITH candidates AS (
          SELECT id
          FROM media_cleanups
          WHERE status IN ('pending', 'failed')
             OR (status = 'processing' AND updated_at < now() - interval '15 minutes')
          ORDER BY updated_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE media_cleanups AS cleanup
        SET status = 'processing', attempts = cleanup.attempts + 1, updated_at = now()
        FROM candidates
        WHERE cleanup.id = candidates.id
        RETURNING cleanup.work_id AS "workId", cleanup.media_id AS "mediaId",
          cleanup.storage_key AS "storageKey", cleanup.status, cleanup.attempts,
          cleanup.last_error AS "lastError"
      `)
      if (started) await commitTransaction(req)
      return (result.rows || []).map((doc: any) => ({
        workId: String(doc.workId || ''),
        mediaId: String(doc.mediaId || ''),
        storageKey: String(doc.storageKey || ''),
        status: 'processing' as const,
        attempts: Number(doc.attempts || 0),
        lastError: doc.lastError ? String(doc.lastError) : undefined,
      }))
    } catch (error) {
      if (started) await killTransaction(req)
      throw error
    }
  }

  async markCleanupIntent(input: { storageKey: string; status: CleanupIntent['status']; attempts: number; lastError?: string; req?: AuthoringRequestContext }): Promise<void> {
    const req = requestFor(this.payload, input.req)
    const result = await this.payload.find({
      collection: 'media-cleanups', depth: 0, limit: 1, pagination: false, overrideAccess: true, req,
      where: { storageKey: { equals: input.storageKey } },
    })
    const doc = result.docs?.[0]
    if (!doc) return
    await this.payload.update({
      collection: 'media-cleanups', id: doc.id, overrideAccess: true, req,
      data: { status: input.status, attempts: input.attempts, lastError: input.lastError || null },
    })
  }

  async withWorkLock<T>(workId: string, input: AuthoringRequestContext | undefined, callback: (transactionReq: AuthoringRequestContext) => Promise<T>): Promise<T> {
    // Keep the caller's request free of transactionID after commit so follow-up
    // aggregate reads and cleanup updates cannot accidentally reuse a closed
    // transaction connection.
    const req = requestFor(this.payload, input ? { ...input } : {})
    let started = false
    try {
      started = await initTransaction(req)
      const db = await requestDatabase(this.payload, req)
      if (db?.execute) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memebot:work-authoring:${workId}`}))`)
      const result = await callback(req)
      if (started) await commitTransaction(req)
      return result
    } catch (error) {
      if (started) await killTransaction(req)
      throw error
    }
  }
}
