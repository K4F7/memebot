import { h, type Session } from 'koishi'

export interface PayloadArchiveReadConfig {
  enabled: boolean
  baseUrl: string
  serviceToken: string
  timeoutMs: number
}

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
  access: { url: string; expiresAt: string }
}

export interface ArchiveWorkDetail extends ArchiveWorkSummary {
  media: ArchiveMediaDescriptor[]
}

export type PayloadArchiveReadErrorKind = 'unavailable' | 'unauthorized' | 'contract' | 'media'

export class PayloadArchiveReadError extends Error {
  constructor(
    readonly kind: PayloadArchiveReadErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'PayloadArchiveReadError'
  }
}

export interface PayloadArchiveReadOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
}

function ensureBaseUrl(value: string): URL {
  const baseUrl = value.trim()
  if (!baseUrl) throw new PayloadArchiveReadError('unavailable', 'Payload Archive URL 未配置。')
  try { return new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`) } catch { throw new PayloadArchiveReadError('unavailable', 'Payload Archive URL 无效。') }
}

function errorFromStatus(status: number): PayloadArchiveReadError {
  if (status === 401 || status === 403) return new PayloadArchiveReadError('unauthorized', 'Payload Archive machine credential 无效。', status)
  if (status >= 500 || status === 408 || status === 429) return new PayloadArchiveReadError('unavailable', 'Payload Archive 暂时不可用。', status)
  return new PayloadArchiveReadError('contract', `Payload Archive 返回了意外状态 ${status}。`, status)
}

function summary(value: unknown): ArchiveWorkSummary {
  if (!value || typeof value !== 'object') throw new PayloadArchiveReadError('contract', 'Work 响应不是对象。')
  const item = value as Record<string, unknown>
  const id = String(item.id || '').trim()
  const title = String(item.title || '').trim()
  const author = String(item.author || '').trim()
  if (!/^W[1-9]\d*$/.test(id) || !title || !author) throw new PayloadArchiveReadError('contract', 'Work 响应缺少稳定标识、标题或作者。')
  return { id, title, author, description: item.description ? String(item.description) : undefined }
}

function detail(value: unknown): ArchiveWorkDetail {
  if (!value || typeof value !== 'object') throw new PayloadArchiveReadError('contract', 'Work detail 响应不是对象。')
  const item = value as Record<string, unknown>
  const work = summary(item)
  if (!Array.isArray(item.media) || !item.media.length) throw new PayloadArchiveReadError('contract', 'Work detail 没有有序 Media。')
  const media = item.media.map((value) => {
    if (!value || typeof value !== 'object') throw new PayloadArchiveReadError('contract', 'Media descriptor 不是对象。')
    const entry = value as Record<string, unknown>
    const id = String(entry.id || '').trim()
    const filename = String(entry.filename || '').trim()
    const contentType = String(entry.contentType || '').trim().toLowerCase()
    const access = entry.access && typeof entry.access === 'object' ? entry.access as Record<string, unknown> : undefined
    const url = String(access?.url || '').trim()
    const expiresAt = String(access?.expiresAt || '').trim()
    if (!id || !filename || !/^(?:image\/(?:avif|bmp|gif|jpe?g|png|tiff|webp)|application\/pdf)$/i.test(contentType) || !url || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
      throw new PayloadArchiveReadError('contract', `Media descriptor ${id || filename || 'unknown'} 无效。`)
    }
    return { id, filename, contentType, size: Number(entry.size || 0), caption: entry.caption ? String(entry.caption) : undefined, access: { url, expiresAt } }
  })
  return { ...work, media }
}

export class PayloadArchiveReadAdapter {
  private readonly request: typeof globalThis.fetch
  private readonly now: () => number
  private readonly baseUrl: URL

  constructor(private readonly config: PayloadArchiveReadConfig, options: PayloadArchiveReadOptions = {}) {
    this.request = options.fetch || globalThis.fetch.bind(globalThis)
    this.now = options.now || (() => Date.now())
    this.baseUrl = ensureBaseUrl(config.baseUrl)
  }

  async searchWorks(filters: { text?: string; author?: string } = {}): Promise<ArchiveWorkSummary[]> {
    const url = new URL('api/archive/v1/works', this.baseUrl)
    if (filters.text?.trim()) url.searchParams.set('query', filters.text.trim())
    if (filters.author?.trim()) url.searchParams.set('author', filters.author.trim())
    const body = await this.jsonRequest(url)
    const value = Array.isArray(body) ? body : (body as any)?.data ?? (body as any)?.works
    if (!Array.isArray(value)) throw new PayloadArchiveReadError('contract', 'Work search 响应缺少 data 数组。')
    return value.map(summary)
  }

  async getWork(id: string): Promise<ArchiveWorkDetail | undefined> {
    const archiveId = id.trim().toUpperCase()
    if (!/^W[1-9]\d*$/.test(archiveId)) return undefined
    const url = new URL(`api/archive/v1/works/${encodeURIComponent(archiveId)}`, this.baseUrl)
    let response: Response
    try {
      response = await this.requestWithTimeout(url)
    } catch (error) {
      if (error instanceof PayloadArchiveReadError) throw error
      throw new PayloadArchiveReadError('unavailable', 'Payload Archive 暂时不可用。')
    }
    if (response.status === 404) return undefined
    if (!response.ok) throw errorFromStatus(response.status)
    let body: unknown
    try { body = await response.json() } catch { throw new PayloadArchiveReadError('contract', 'Work detail 不是有效 JSON。') }
    const value = (body as any)?.data ?? (body as any)?.work ?? body
    return detail(value)
  }

  async fetchMedia(media: ArchiveMediaDescriptor): Promise<Uint8Array> {
    if (Date.parse(media.access.expiresAt) <= this.now()) throw new PayloadArchiveReadError('media', `${media.filename} 获取失败。`, 401)
    let response: Response
    try {
      response = await this.requestWithTimeout(new URL(media.access.url, this.baseUrl), { headers: { accept: media.contentType } })
    } catch (error) {
      if (error instanceof PayloadArchiveReadError) throw new PayloadArchiveReadError('media', `${media.filename} 获取失败。`)
      throw new PayloadArchiveReadError('media', `${media.filename} 获取失败。`)
    }
    if (!response.ok) throw new PayloadArchiveReadError('media', `${media.filename} 获取失败。`, response.status)
    try { return new Uint8Array(await response.arrayBuffer()) } catch { throw new PayloadArchiveReadError('media', `${media.filename} 响应无法读取。`) }
  }

  private async jsonRequest(url: URL): Promise<any> {
    let response: Response
    try { response = await this.requestWithTimeout(url, { headers: { accept: 'application/json' } }) } catch (error) {
      if (error instanceof PayloadArchiveReadError) throw error
      throw new PayloadArchiveReadError('unavailable', 'Payload Archive 暂时不可用。')
    }
    if (!response.ok) throw errorFromStatus(response.status)
    try { return await response.json() } catch { throw new PayloadArchiveReadError('contract', 'Payload Archive 响应不是有效 JSON。') }
  }

  private async requestWithTimeout(url: URL, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timeoutMs = Math.max(1, Math.floor(this.config.timeoutMs || 10_000))
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = new Headers(init.headers)
      const isProtectedMedia = /\/api\/archive\/v1\/media(?:\/|$)/.test(url.pathname)
      if (!isProtectedMedia && (url.pathname.startsWith('/api/archive/v1') || url.pathname.includes('/api/archive/v1/'))) {
        if (!headers.has('authorization')) headers.set('authorization', `Bearer ${this.config.serviceToken}`)
      }
      const response = await this.request(url, { ...init, headers, signal: controller.signal })
      return response
    } catch (error) {
      if (error instanceof PayloadArchiveReadError) throw error
      if ((error as Error)?.name === 'AbortError') throw new PayloadArchiveReadError('unavailable', `Payload Archive 请求超过 ${timeoutMs}ms。`)
      throw new PayloadArchiveReadError('unavailable', 'Payload Archive 暂时不可用。')
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function sendPayloadWork(session: Session, adapter: PayloadArchiveReadAdapter, id: string): Promise<string> {
  const work = await adapter.getWork(id)
  if (!work) return 'Work 不存在。'
  const nodes: any[] = [h('message', {}, `${work.id} ${work.author} - ${work.title}${work.description ? `\n${work.description}` : ''}`)]
  for (const media of work.media) {
    try {
      const bytes = await adapter.fetchMedia(media)
      const dataUrl = `data:${media.contentType};base64,${Buffer.from(bytes).toString('base64')}`
      const content = media.contentType.startsWith('image/') ? h.image(dataUrl) : h.file(dataUrl, { filename: media.filename })
      nodes.push(h('message', {}, [media.caption ? `${media.caption}\n` : '', content]))
    } catch (error) {
      const message = error instanceof PayloadArchiveReadError ? error.message : `${media.filename} 获取失败。`
      nodes.push(h('message', {}, message))
    }
  }
  await session.send(h('message', { forward: true }, nodes))
  return `已发送 Work ${work.id}。`
}
