import { Buffer } from 'node:buffer'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Context, Schema, h, type Session } from 'koishi'

export const name = 'memebot-archive'
export const inject = [] as const

export interface Config {
  origin?: string
  token?: string
}

export const Config: Schema<Config> = Schema.object({
  origin: Schema.string().description('Archive 读取契约服务地址'),
  token: Schema.string().role('secret').description('Archive 读取契约机器凭证'),
})

const UNAVAILABLE = 'Archive 服务暂时不可用，请稍后重试。'
const NOT_FOUND = 'Work 不存在。'
const USAGE = '请使用 /archive search works [查询] 或 /archive W<n>。'
const WORK_ONLY = '当前 Archive 仅支持 Work W<n>。'
const KIND_ONLY = '当前 Archive 仅支持 Work 查询。'
const WORK_ID = /^w[1-9]\d*$/i

interface SearchHit {
  archiveId: string
  title: string
  author: string | null
}

interface MediaItem {
  mediaId: string
  filename: string
  mediaType: string
  caption: string | null
}

interface WorkDetail {
  title: string
  author: string | null
  summary: string | null
  media: MediaItem[]
}

type Failure = 'unavailable' | 'not-found'
type Outcome<T> = { ok: true; value: T } | { ok: false; reason: Failure }

function configured(config?: Partial<Config>) {
  const origin = config?.origin?.trim().replace(/\/+$/, '') ?? ''
  const token = config?.token?.trim() ?? ''
  if (!origin || !token) return null
  return { origin, token }
}

function textOf(value: unknown) {
  return typeof value === 'string' ? value : null
}

function classify(status: number | 'network'): Failure {
  return status === 404 ? 'not-found' : 'unavailable'
}

function request(url: string, token: string) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function readResponse(origin: string, token: string, path: string) {
  try {
    return await request(`${origin}${path}`, token)
  } catch {
    return { status: 'network' as const, headers: {}, body: Buffer.alloc(0) }
  }
}

function parseJson(body: Buffer): unknown {
  if (!body.length) return undefined
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

function parseSearch(body: unknown): { data: SearchHit[]; total: number } | null {
  if (!body || typeof body !== 'object') return null
  const { data, total } = body as { data?: unknown; total?: unknown }
  if (!Array.isArray(data) || typeof total !== 'number' || !Number.isFinite(total)) return null
  const hits: SearchHit[] = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const archiveId = textOf((item as SearchHit).archiveId)
    const title = textOf((item as SearchHit).title)
    if (!archiveId || !title) continue
    hits.push({ archiveId, title, author: textOf((item as SearchHit).author) })
  }
  return { data: hits, total }
}

function parseMedia(value: unknown): MediaItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as MediaItem
  const mediaId = textOf(item.mediaId)
  const filename = textOf(item.filename)
  if (!mediaId || !filename) return null
  return {
    mediaId,
    filename,
    mediaType: textOf(item.mediaType) ?? 'application/octet-stream',
    caption: textOf(item.caption),
  }
}

function parseDetail(body: unknown): WorkDetail | null {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
  if (!data || typeof data !== 'object') return null
  const work = data as { title?: unknown; author?: unknown; summary?: unknown; media?: unknown }
  const title = textOf(work.title)
  if (!title || !Array.isArray(work.media)) return null
  return {
    title,
    author: textOf(work.author),
    summary: textOf(work.summary),
    media: work.media.map(parseMedia).filter((item): item is MediaItem => Boolean(item)),
  }
}

async function searchWorks(origin: string, token: string, query?: string, author?: string): Promise<Outcome<{ data: SearchHit[]; total: number }>> {
  const params = new URLSearchParams()
  const queryText = query?.trim() ?? ''
  const authorText = author?.trim() ?? ''
  if (queryText) params.set('query', queryText)
  if (authorText) params.set('author', authorText)
  const suffix = params.toString() ? `?${params}` : ''
  const response = await readResponse(origin, token, `/api/archive/v1/works${suffix}`)
  if (response.status !== 200) return { ok: false, reason: response.status === 404 ? 'unavailable' : classify(response.status) }
  const parsed = parseSearch(parseJson(response.body))
  if (!parsed) return { ok: false, reason: 'unavailable' }
  return { ok: true, value: parsed }
}

async function readWork(origin: string, token: string, archiveId: string): Promise<Outcome<WorkDetail>> {
  const response = await readResponse(origin, token, `/api/archive/v1/works/${encodeURIComponent(archiveId)}`)
  if (response.status !== 200) return { ok: false, reason: classify(response.status) }
  const parsed = parseDetail(parseJson(response.body))
  if (!parsed) return { ok: false, reason: 'unavailable' }
  return { ok: true, value: parsed }
}

async function readMedia(origin: string, token: string, mediaId: string) {
  const response = await readResponse(origin, token, `/api/archive/v1/media/${encodeURIComponent(mediaId)}`)
  if (response.status !== 200 || !response.body.length) return null
  return response.body
}

function formatSearch(result: { data: SearchHit[]; total: number }) {
  if (result.total === 0 || result.data.length === 0) return '共 0 条 Work。'
  return [`共 ${result.total} 条 Work。`, ...result.data.map((item) => {
    return item.author ? `${item.archiveId} ${item.title}（${item.author}）` : `${item.archiveId} ${item.title}`
  })].join('\n')
}

function formatDetail(work: WorkDetail) {
  const lines = [work.title]
  if (work.author) lines.push(`作者：${work.author}`)
  if (work.summary) lines.push(work.summary)
  return lines.join('\n')
}

function mediaFragment(media: MediaItem, bytes: Buffer) {
  const type = media.mediaType || 'application/octet-stream'
  if (type.toLowerCase().startsWith('image/')) return h.image(bytes, type)
  return h.file(bytes, type, { title: media.filename })
}

function mediaFailure(filename: string) {
  return `媒体 ${filename} 暂时无法投递，已跳过。`
}

async function sendSafely(session: Session, content: Parameters<Session['send']>[0]) {
  try {
    await session.send(content)
    return true
  } catch {
    return false
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const search = async (query?: string, author?: string) => {
    const bound = configured(config)
    if (!bound) return UNAVAILABLE
    const result = await searchWorks(bound.origin, bound.token, query, author)
    if (!result.ok) return UNAVAILABLE
    return formatSearch(result.value)
  }

  const root = ctx.command('archive [id:text]', '搜索或获取 Work 归档')
  root.action(async ({ session }, id) => {
    if (!id) return USAGE
    if (!WORK_ID.test(id)) return WORK_ONLY
    const bound = configured(config)
    if (!bound) return UNAVAILABLE
    if (!session) return UNAVAILABLE
    const result = await readWork(bound.origin, bound.token, id)
    if (!result.ok) return result.reason === 'not-found' ? NOT_FOUND : UNAVAILABLE
    await sendSafely(session, formatDetail(result.value))
    for (const media of result.value.media) {
      const bytes = await readMedia(bound.origin, bound.token, media.mediaId)
      if (!bytes) {
        await sendSafely(session, mediaFailure(media.filename))
        continue
      }
      const fragment = mediaFragment(media, bytes)
      const sent = await sendSafely(session, media.caption ? [fragment, media.caption] : fragment)
      if (!sent) await sendSafely(session, mediaFailure(media.filename))
    }
  })

  root.subcommand('.search <kind:string> [query:text]', '搜索 Work').action(async (_meta, kind, query) => {
    if (kind.toLocaleLowerCase() !== 'works') return KIND_ONLY
    return search(query)
  })

  root.subcommand('.works [query:text]', '查询 Work').action(async (_meta, query) => search(query))

  root.subcommand('.work-query [author:string] [query:text]', '按作者或文本查询 Work').action(async (_meta, author, query) => {
    return search(query, author)
  })
}

export default { name, inject, Config, apply }
