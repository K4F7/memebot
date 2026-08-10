import type { ArchiveApiSource, ArchiveMediaBody, ArchiveMediaRecord, ArchiveSearchResult, ArchiveWorkDetail, ArchiveWorkSummary } from './types'
import { sql } from '@payloadcms/db-postgres'

import { relationId } from './relations'
import { isValidStorageKey } from './media-policy'

type PayloadLike = {
  find(args: Record<string, unknown>): Promise<{ docs?: any[] }>
  findByID(args: Record<string, unknown>): Promise<any>
  db?: {
    drizzle?: unknown
    execute(args: Record<string, unknown>): Promise<{ rows?: any[] }>
  }
}

type R2Like = {
  get(key: string): Promise<{ body?: ReadableStream<Uint8Array>; size?: number; httpMetadata?: { contentType?: string } } | null | undefined>
  presignGet?(key: string, expiresIn: number): Promise<string>
}

type PublishedManifestEntry = {
  mediaId?: unknown
  filename?: unknown
  alt?: unknown
  caption?: unknown
}

function safeFilename(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop()!.replace(/[\r\n]/g, '_')
}

function publishedManifest(value: unknown): PublishedManifestEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is PublishedManifestEntry => Boolean(item && typeof item === 'object'))
}

export class PayloadArchiveSource implements ArchiveApiSource {
  constructor(private readonly payload: PayloadLike, private readonly bucket: R2Like) {}

  private async publishedMedia(work: any): Promise<ArchiveWorkDetail['media']> {
    const manifest = publishedManifest(work?.mediaManifest)
    const ids = manifest.map((entry) => String(entry.mediaId || '')).filter(Boolean)
    if (!ids.length) return []
    const result = await this.payload.find({
      collection: 'media',
      depth: 0,
      limit: ids.length,
      pagination: false,
      overrideAccess: true,
      where: { id: { in: ids } },
    })
    const byId = new Map((result.docs || []).map((item) => [String(item.id), item]))
    return manifest.map((entry) => {
      const mediaId = String(entry.mediaId || '')
      const item = byId.get(mediaId)
      const mediaWorkId = relationId(item?.work)
      if (!item || item.uploadStatus === 'pending' || item.withdrawnAt || mediaWorkId !== String(work.id) || !item.mimeType || !isValidStorageKey(item.storageKey)) return undefined
      if (!entry.filename) return undefined
      return {
        id: mediaId,
        filename: safeFilename(String(entry.filename)),
        contentType: String(item.mimeType),
        size: Number(item.filesize || 0),
        caption: entry.caption ? String(entry.caption) : undefined,
        access: { url: '', expiresAt: '' },
      }
    }).filter(Boolean) as ArchiveWorkDetail['media']
  }

  private async findSearchWorks(query: string, author = ''): Promise<ArchiveWorkSummary[]> {
    const result = await this.payload.find({
      collection: 'works', depth: 0, draft: false, limit: 0, pagination: false, overrideAccess: true,
      where: { _status: { equals: 'published' } },
    })
    const needle = query.trim().toLocaleLowerCase()
    const authorNeedle = author.trim().toLocaleLowerCase()
    const works: ArchiveWorkSummary[] = []
    for (const work of result.docs || []) {
      const detailMedia = await this.publishedMedia(work)
      if (!detailMedia.length) continue
      const detail = {
        id: String(work.archiveId || ''),
        title: String(work.title || ''),
        author: String(work.author || ''),
        description: work.description ? String(work.description) : undefined,
      }
      if ((!needle || [detail.id, detail.title, detail.author, detail.description].some((value) => value?.toLocaleLowerCase().includes(needle))) &&
        (!authorNeedle || detail.author.toLocaleLowerCase().includes(authorNeedle))) {
        works.push({ id: detail.id, title: detail.title, author: detail.author, description: detail.description })
      }
    }
    return works
  }

  private async searchWorksFromDatabase(query: string, author = ''): Promise<ArchiveSearchResult | undefined> {
    const db = this.payload.db
    if (!db?.execute || !db.drizzle) return undefined
    const executeSql = (statement: unknown) => db.execute({ drizzle: db.drizzle, sql: statement })

    const queryText = query.trim()
    const authorText = author.trim()
    const metadataFilter = query.trim()
      ? sql`(
          strpos(lower(w.archive_id), lower(${queryText})) > 0
          OR strpos(lower(w.title), lower(${queryText})) > 0
          OR strpos(lower(w.author), lower(${queryText})) > 0
          OR strpos(lower(w.description), lower(${queryText})) > 0
        )`
      : sql`TRUE`
    const authorFilter = authorText ? sql`strpos(lower(w.author), lower(${authorText})) > 0` : sql`TRUE`
    const readableFilter = sql`
      w._status = 'published'
      AND jsonb_array_length(COALESCE(w.media_manifest, '[]'::jsonb)) > 0
      AND
      EXISTS (
        SELECT 1
        FROM media m
        INNER JOIN LATERAL jsonb_array_elements(COALESCE(w.media_manifest, '[]'::jsonb)) manifest ON TRUE
        WHERE m.id::text = manifest->>'mediaId'
          AND m.work_id = w.id
          AND m.withdrawn_at IS NULL
          AND m.upload_status = 'finalized'
          AND m.storage_key ~ '^media/[0-9a-f-]{36}$'
      )
    `
    const dataResult = await executeSql(sql`
        SELECT w.archive_id AS "archiveId", w.title, w.author, w.description, COUNT(*) OVER()::int AS "__total"
        FROM works w
        WHERE ${metadataFilter} AND ${authorFilter} AND ${readableFilter}
        ORDER BY w.id
        LIMIT 1000
      `)
    return {
      data: (dataResult.rows || []).map((row) => ({
        id: String(row.archiveId || ''),
        title: String(row.title || ''),
        author: String(row.author || ''),
        description: row.description ? String(row.description) : undefined,
      })),
      total: Number(dataResult.rows?.[0]?.__total || 0),
    }
  }

  async searchWorksWithTotal(query: string, author = ''): Promise<ArchiveSearchResult> {
    const databaseResult = await this.searchWorksFromDatabase(query, author)
    if (databaseResult) return databaseResult
    const works = await this.findSearchWorks(query, author)
    return { data: works.slice(0, 1000), total: works.length }
  }

  async searchWorks(query: string, author = ''): Promise<ArchiveWorkSummary[]> {
    return (await this.searchWorksWithTotal(query, author)).data
  }

  async getWork(id: string): Promise<ArchiveWorkDetail | undefined> {
    const result = await this.payload.find({
      collection: 'works',
      depth: 0,
      draft: false,
      limit: 1,
      pagination: false,
      overrideAccess: true,
      where: { and: [{ archiveId: { equals: id.toUpperCase() } }, { _status: { equals: 'published' } }] },
    })
    const work = result.docs?.[0]
    if (!work) return undefined
    const media = await this.publishedMedia(work)
    if (!media.length) return undefined
    return {
      id: String(work.archiveId),
      title: String(work.title),
      author: String(work.author),
      description: work.description ? String(work.description) : undefined,
      media: media as ArchiveWorkDetail['media'],
    }
  }

  async getMedia(id: string): Promise<ArchiveMediaRecord | undefined> {
    const item = await this.payload.findByID({ collection: 'media', id, depth: 0, disableErrors: true, overrideAccess: true })
    if (!item || item.uploadStatus === 'pending' || item.withdrawnAt || !isValidStorageKey(item.storageKey)) return undefined
    const workId = relationId(item.work)
    if (!workId) return undefined
    const work = await this.payload.findByID({ collection: 'works', id: workId, depth: 0, draft: false, disableErrors: true, overrideAccess: true })
    const manifestEntry = publishedManifest(work?.mediaManifest).find((entry) => String(entry.mediaId || '') === String(item.id))
    if (!work || work._status !== 'published' || !manifestEntry) return undefined
    return {
      id: String(item.id),
      filename: safeFilename(String(manifestEntry.filename || item.filename)),
      contentType: String(item.mimeType),
      size: Number(item.filesize || 0),
      workId,
      storageKey: item.storageKey,
    }
  }

  async readMedia(media: ArchiveMediaRecord): Promise<ArchiveMediaBody | undefined> {
    const object = await this.bucket.get(media.storageKey)
    if (!object?.body) return undefined
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType || media.contentType,
      filename: media.filename,
      size: object.size || media.size,
    }
  }

  async createMediaAccessUrl(media: ArchiveMediaRecord, expiresIn: number): Promise<string | undefined> {
    return this.bucket.presignGet?.(media.storageKey, expiresIn)
  }
}
