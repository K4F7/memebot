import { validateMediaMimeType } from './mime'
import { createStorageKey } from './media-policy'
import type {
  ArchiveApiSource,
  ArchiveMediaBody,
  ArchiveMediaRecord,
  ArchiveWorkDetail,
  ArchiveWorkSummary,
} from './types'

interface WorkRow {
  payloadId: string
  archiveId: string
  title: string
  author: string
  description?: string
}

interface MediaRow extends ArchiveMediaRecord {
  bytes: Uint8Array
}

interface WorkMediaRow {
  id: string
  workId: string
  mediaId: string
  displayOrder: number
  caption?: string
}

export class InMemoryArchiveStore implements ArchiveApiSource {
  private sequence = 0
  private mediaSequence = 0
  private relationshipSequence = 0
  private readonly works: WorkRow[] = []
  private readonly media: MediaRow[] = []
  private readonly relationships: WorkMediaRow[] = []

  createWork(input: { title: string; author: string; description?: string }): WorkRow {
    const title = input.title.trim()
    const author = input.author.trim()
    if (!title || !author) throw new Error('Work 标题和作者不能为空。')
    this.sequence += 1
    const row = {
      payloadId: `work-${this.sequence}`,
      archiveId: `W${this.sequence}`,
      title,
      author,
      description: input.description?.trim() || undefined,
    }
    this.works.push(row)
    return { ...row }
  }

  createMedia(input: {
    workId: string
    filename: string
    contentType: string
    bytes: Uint8Array
  }): ArchiveMediaRecord {
    const work = this.works.find((item) => item.archiveId.toUpperCase() === input.workId.toUpperCase())
    if (!work) throw new Error('Media 必须属于已存在的 Work。')
    const contentType = validateMediaMimeType(input.contentType)
    const filename = input.filename.trim()
    if (!filename) throw new Error('Media 文件名不能为空。')
    this.mediaSequence += 1
    const row: MediaRow = {
      id: `media-${this.mediaSequence}`,
      filename,
      contentType,
      size: input.bytes.byteLength,
      workId: work.archiveId,
      storageKey: createStorageKey(),
      bytes: new Uint8Array(input.bytes),
    }
    this.media.push(row)
    return this.publicMedia(row)
  }

  createWorkMedia(input: { workId: string; mediaId: string; displayOrder: number; caption?: string }) {
    const work = this.works.find((item) => item.archiveId.toUpperCase() === input.workId.toUpperCase())
    const media = this.media.find((item) => item.id === input.mediaId)
    if (!work || !media) throw new Error('WorkMedia 的 Work 或 Media 不存在。')
    if (media.workId !== work.archiveId) throw new Error('Media 只能属于创建它时指定的 Work。')
    if (this.relationships.some((item) => item.mediaId === media.id)) throw new Error('Media 已经属于一个 WorkMedia 关系。')
    if (!Number.isFinite(input.displayOrder) || input.displayOrder < 0) throw new Error('displayOrder 必须是非负数。')
    this.relationshipSequence += 1
    const relationship = {
      id: `work-media-${this.relationshipSequence}`,
      workId: work.archiveId,
      mediaId: media.id,
      displayOrder: Math.floor(input.displayOrder),
      caption: input.caption?.trim() || undefined,
    }
    this.relationships.push(relationship)
    return { ...relationship }
  }

  async searchWorks(query = '', author = ''): Promise<ArchiveWorkSummary[]> {
    const needle = query.trim().toLocaleLowerCase()
    const authorNeedle = author.trim().toLocaleLowerCase()
    const result: ArchiveWorkSummary[] = []
    for (const work of this.works) {
      const detail = await this.getWork(work.archiveId)
      if (!detail) continue
      if ((!needle || [work.archiveId, work.title, work.author, work.description].some((value) => value?.toLocaleLowerCase().includes(needle))) &&
        (!authorNeedle || work.author.toLocaleLowerCase().includes(authorNeedle))) {
        result.push({ id: detail.id, title: detail.title, author: detail.author, description: detail.description })
      }
    }
    return result
  }

  async getWork(id: string): Promise<ArchiveWorkDetail | undefined> {
    const work = this.works.find((item) => item.archiveId.toUpperCase() === id.trim().toUpperCase())
    if (!work) return undefined
    const relationships = this.relationships
      .filter((item) => item.workId === work.archiveId && this.media.some((media) => media.id === item.mediaId && media.workId === work.archiveId))
      .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id))
    if (!relationships.length) return undefined
    return {
      id: work.archiveId,
      title: work.title,
      author: work.author,
      description: work.description,
      media: relationships.map((relationship) => {
        const media = this.media.find((item) => item.id === relationship.mediaId)!
        return {
          id: media.id,
          filename: media.filename,
          contentType: media.contentType,
          size: media.size,
          caption: relationship.caption,
          access: { url: '', expiresAt: '' },
        }
      }),
    }
  }

  async getMedia(id: string): Promise<ArchiveMediaRecord | undefined> {
    const media = this.media.find((item) => item.id === id)
    return media && this.publicMedia(media)
  }

  async readMedia(media: ArchiveMediaRecord): Promise<ArchiveMediaBody | undefined> {
    const row = this.media.find((item) => item.id === media.id)
    if (!row) return undefined
    return { body: new Uint8Array(row.bytes), contentType: row.contentType, filename: row.filename, size: row.size }
  }

  private publicMedia(row: MediaRow): ArchiveMediaRecord {
    const { bytes: _bytes, ...media } = row
    return media
  }
}
