import type { ArchiveApiSource, ArchiveMediaBody, ArchiveMediaRecord, ArchiveWorkDetail, ArchiveWorkSummary } from './types'
import { relationId } from './relations'

type PayloadLike = {
  find(args: Record<string, unknown>): Promise<{ docs?: any[] }>
  findByID(args: Record<string, unknown>): Promise<any>
}

type R2Like = {
  get(key: string): Promise<{ body?: ReadableStream<Uint8Array>; size?: number; httpMetadata?: { contentType?: string } } | null | undefined>
}

function safeFilename(filename: string): string {
  return filename.replace(/\\/g, '/').split('/').pop()!.replace(/[\r\n]/g, '_')
}

export class PayloadArchiveSource implements ArchiveApiSource {
  constructor(private readonly payload: PayloadLike, private readonly bucket: R2Like) {}

  async searchWorks(query: string, author = ''): Promise<ArchiveWorkSummary[]> {
    const result = await this.payload.find({ collection: 'works', depth: 0, limit: 1000, pagination: false, overrideAccess: true })
    const needle = query.trim().toLocaleLowerCase()
    const authorNeedle = author.trim().toLocaleLowerCase()
    const works: ArchiveWorkSummary[] = []
    for (const work of result.docs || []) {
      const detail = await this.getWork(String(work.archiveId || ''))
      if (!detail) continue
      if ((!needle || [detail.id, detail.title, detail.author, detail.description].some((value) => value?.toLocaleLowerCase().includes(needle))) &&
        (!authorNeedle || detail.author.toLocaleLowerCase().includes(authorNeedle))) {
        works.push({ id: detail.id, title: detail.title, author: detail.author, description: detail.description })
      }
    }
    return works
  }

  async getWork(id: string): Promise<ArchiveWorkDetail | undefined> {
    const result = await this.payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      pagination: false,
      overrideAccess: true,
      where: { archiveId: { equals: id.toUpperCase() } },
    })
    const work = result.docs?.[0]
    if (!work) return undefined
    const relationships = await this.payload.find({
      collection: 'work-media',
      depth: 2,
      limit: 1000,
      pagination: false,
      overrideAccess: true,
      sort: 'displayOrder',
      where: { work: { equals: work.id } },
    })
    const media = (relationships.docs || [])
      .map((relationship) => {
        const item = relationship.media
        const mediaWorkId = relationId(item?.work)
        if (!item || !mediaWorkId || mediaWorkId !== String(work.id)) return undefined
        const mediaId = relationId(item)
        if (!mediaId || !item.filename || !item.mimeType) return undefined
        return {
          id: mediaId,
          filename: safeFilename(String(item.filename)),
          contentType: String(item.mimeType),
          size: Number(item.filesize || 0),
          caption: relationship.caption ? String(relationship.caption) : undefined,
          access: { url: '', expiresAt: '' },
        }
      })
      .filter(Boolean)
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
    try {
      const item = await this.payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true })
      if (!item) return undefined
      const workId = relationId(item.work)
      if (!workId) return undefined
      return {
        id: String(item.id),
        filename: safeFilename(String(item.filename)),
        contentType: String(item.mimeType),
        size: Number(item.filesize || 0),
        workId,
        prefix: item.prefix ? String(item.prefix) : undefined,
      }
    } catch {
      return undefined
    }
  }

  async readMedia(media: ArchiveMediaRecord): Promise<ArchiveMediaBody | undefined> {
    const key = [media.prefix?.replace(/^\/+|\/+$/g, ''), safeFilename(media.filename)].filter(Boolean).join('/')
    const object = await this.bucket.get(key)
    if (!object?.body) return undefined
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType || media.contentType,
      filename: media.filename,
      size: object.size || media.size,
    }
  }
}
