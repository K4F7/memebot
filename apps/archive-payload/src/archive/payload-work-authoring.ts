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
    if (!doc || (doc._status !== 'published' && !doc.publishedAt)) return null
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

  async createPendingMedia(input: { workId: string; uploadId: string; filename: string; filesize: number; mimeType: string; storageKey: string; replaceMediaId?: string; selectionIndex?: number; req?: AuthoringRequestContext }): Promise<StoredMedia> {
    const req = requestFor(this.payload, input.req)
    const doc = await this.payload.create({
      collection: 'media', overrideAccess: true, req,
      data: {
        work: input.workId,
        filename: input.filename,
        mimeType: input.mimeType,
        filesize: input.filesize,
        storageKey: input.storageKey,
        uploadId: input.uploadId,
        uploadStatus: 'pending',
        replaceMediaId: input.replaceMediaId,
        selectionIndex: input.selectionIndex,
      },
    })
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
    const doc = await this.payload.update({
      collection: 'works', id: input.workId, draft: false, overrideAccess: true, req,
      data: {
        title: current.title,
        author: current.author,
        description: current.description,
        revision: input.revision,
        mediaManifest: current.media,
        publishedAt: new Date().toISOString(),
      },
    })
    return toStoredWork(doc)
  }

  async recordCleanupIntent(input: { workId: string; mediaId: string; storageKey: string; req?: AuthoringRequestContext }): Promise<void> {
    const req = requestFor(this.payload, input)
    const existing = await this.payload.find({
      collection: 'media-cleanups', depth: 0, limit: 1, pagination: false, overrideAccess: true, req,
      where: { storageKey: { equals: input.storageKey } },
    })
    if (existing.docs?.[0]) {
      await this.payload.update({
        collection: 'media-cleanups', id: existing.docs[0].id, overrideAccess: true, req,
        data: { status: 'pending', attempts: 0, lastError: null },
      })
      return
    }
    await this.payload.create({
      collection: 'media-cleanups', overrideAccess: true, req,
      data: { work: input.workId, mediaId: input.mediaId, storageKey: input.storageKey, status: 'pending' },
    })
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

  async withWorkLock<T>(workId: string, input: AuthoringRequestContext | undefined, callback: () => Promise<T>): Promise<T> {
    const req = requestFor(this.payload, input)
    let started = false
    try {
      started = await initTransaction(req)
      const transactionID = req.transactionID ? await req.transactionID : undefined
      const db = transactionID ? this.payload.db?.sessions?.[transactionID]?.db : this.payload.db?.drizzle
      if (db?.execute) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memebot:work-authoring:${workId}`}))`)
      const result = await callback()
      if (started) await commitTransaction(req)
      return result
    } catch (error) {
      if (started) await killTransaction(req)
      throw error
    }
  }
}
