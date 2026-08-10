export interface ArchiveWorkSummary {
  id: string
  title: string
  author: string
  description?: string
}

export interface ArchiveMediaDescriptor {
  id: string
  filename: string
  contentType: string
  size: number
  caption?: string
  access: {
    url: string
    expiresAt: string
  }
}

export interface ArchiveWorkDetail extends ArchiveWorkSummary {
  media: ArchiveMediaDescriptor[]
}

export interface ArchiveMediaRecord {
  id: string
  filename: string
  contentType: string
  size: number
  workId: string
  prefix?: string
}

export interface ArchiveMediaBody {
  body: BodyInit
  contentType: string
  filename: string
  size?: number
}

export interface ArchiveApiSource {
  searchWorks(query: string, author?: string): Promise<ArchiveWorkSummary[]>
  getWork(id: string): Promise<ArchiveWorkDetail | undefined>
  getMedia(id: string): Promise<ArchiveMediaRecord | undefined>
  readMedia(media: ArchiveMediaRecord): Promise<ArchiveMediaBody | undefined>
  createMediaAccessUrl?(media: ArchiveMediaRecord, expiresIn: number): Promise<string | undefined>
}
