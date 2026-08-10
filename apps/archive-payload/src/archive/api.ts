import { mediaAccessExpiry, signMediaAccess, verifyMediaAccess } from './access'
import type { ArchiveApiSource, ArchiveMediaDescriptor, ArchiveWorkDetail } from './types'

export interface ArchiveApiOptions {
  serviceToken: string
  signingSecret: string
  mediaTtlSeconds?: number
  now?: () => number
}

export class ArchiveApiError extends Error {
  constructor(
    readonly kind: 'unauthorized' | 'unavailable' | 'invalid' | 'not-found',
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ArchiveApiError'
  }
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function errorResponse(error: ArchiveApiError): Response {
  return json({ error: { code: error.kind, message: error.message } }, error.status)
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get('authorization')
  return value?.match(/^Bearer\s+(.+)$/i)?.[1]
}

function mediaDescriptor(
  request: Request,
  detail: ArchiveWorkDetail,
  options: ArchiveApiOptions,
): Promise<ArchiveWorkDetail> {
  const now = options.now?.() ?? Date.now()
  const expires = mediaAccessExpiry(now, options.mediaTtlSeconds)
  const origin = new URL(request.url).origin
  return Promise.all(detail.media.map(async (media) => {
    const signature = await signMediaAccess(options.signingSecret, media.id, expires)
    const url = `${origin}/api/archive/v1/media/${encodeURIComponent(media.id)}?expires=${expires}&signature=${encodeURIComponent(signature)}`
    const descriptor: ArchiveMediaDescriptor = {
      ...media,
      access: { url, expiresAt: new Date(expires * 1000).toISOString() },
    }
    return descriptor
  })).then((media) => ({ ...detail, media }))
}

function requireMachineAuth(request: Request, options: ArchiveApiOptions): void {
  if (!options.serviceToken || bearer(request) !== options.serviceToken) {
    throw new ArchiveApiError('unauthorized', '需要有效的 Archive machine credential。', 401)
  }
}

export async function handleArchiveApi(
  request: Request,
  source: ArchiveApiSource,
  options: ArchiveApiOptions,
): Promise<Response> {
  try {
    if (request.method !== 'GET') throw new ArchiveApiError('invalid', 'Archive read API 只支持 GET。', 405)
    const url = new URL(request.url)
    const marker = '/api/archive/v1'
    const suffix = url.pathname.slice(url.pathname.indexOf(marker) + marker.length).replace(/^\/+|\/+$/g, '')
    const segments = suffix ? suffix.split('/').map(decodeURIComponent) : []

    if (segments[0] === 'media') {
      const mediaId = segments[1]
      const expires = Number(url.searchParams.get('expires'))
      const signature = url.searchParams.get('signature') || ''
      const now = options.now?.() ?? Date.now()
      if (!mediaId || !(await verifyMediaAccess(options.signingSecret, mediaId, expires, signature, now))) {
        throw new ArchiveApiError('unauthorized', 'Media access 已失效或无效。', 401)
      }
      const media = await source.getMedia(mediaId)
      if (!media) throw new ArchiveApiError('not-found', 'Media 不存在。', 404)
      const expiresIn = Math.max(1, expires - Math.floor(now / 1000))
      const signedUrl = await source.createMediaAccessUrl?.(media, expiresIn)
      if (signedUrl) {
        return new Response(null, {
          status: 302,
          headers: {
            'cache-control': `private, max-age=${expiresIn}`,
            location: signedUrl,
          },
        })
      }
      const body = await source.readMedia(media)
      if (!body) throw new ArchiveApiError('not-found', 'Media 对象不存在。', 404)
      return new Response(body.body, {
        headers: {
          'cache-control': 'private, max-age=60',
          'content-disposition': `inline; filename="${body.filename.replace(/["\\\r\n]/g, '_')}"`,
          'content-length': String(body.size ?? media.size),
          'content-type': body.contentType,
        },
      })
    }

    requireMachineAuth(request, options)
    const isWorksPath = segments[0] === 'works'
    const id = isWorksPath ? segments[1] : segments[0]
    if (!id) {
      const query = url.searchParams.get('query') || url.searchParams.get('q') || url.searchParams.get('text') || ''
      const works = await source.searchWorks(query, url.searchParams.get('author') || undefined)
      return json({ data: works, works, total: works.length })
    }
    const detail = await source.getWork(id)
    if (!detail) throw new ArchiveApiError('not-found', 'Work 不存在或尚未完成 Media 关系。', 404)
    return json({ data: await mediaDescriptor(request, detail, options) })
  } catch (error) {
    if (error instanceof ArchiveApiError) return errorResponse(error)
    return errorResponse(new ArchiveApiError('unavailable', 'Archive 服务暂时不可用。', 503))
  }
}
