import type { AuthoringErrorBody, WorkAggregate } from '../authoring/contract'
import { AuthoringService, AuthoringServiceError, type AuthoringRequestContext } from './work-authoring'

export interface WorkAuthoringApiOptions {
  /** The Payload session user. The route must pass this after authenticating headers/cookies. */
  user?: unknown
  requestContext?: AuthoringRequestContext
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function errorBody(error: AuthoringServiceError): AuthoringErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      field: error.field,
      mediaId: error.mediaId,
      uploadId: error.uploadId,
      currentRevision: error.currentRevision,
      aggregate: error.aggregate,
    },
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected')
    return value as Record<string, unknown>
  } catch {
    throw new AuthoringServiceError('validation', '请求 JSON 无效。')
  }
}

function pathSegments(request: Request): string[] {
  const url = new URL(request.url)
  const marker = '/api/work-authoring/v1'
  const index = url.pathname.indexOf(marker)
  const suffix = index < 0 ? '' : url.pathname.slice(index + marker.length)
  return suffix.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodeURIComponent)
}

function withContext(options: WorkAuthoringApiOptions): AuthoringRequestContext {
  return { ...(options.requestContext || {}), user: options.user }
}

export async function handleWorkAuthoringApi(
  request: Request,
  service: AuthoringService,
  options: WorkAuthoringApiOptions = {},
): Promise<Response> {
  if (!options.user) return json({ error: { code: 'unauthorized', message: '需要 Payload Admin 登录。' } }, 401)
  try {
    const segments = pathSegments(request)
    const context = withContext(options)
    if (segments.length === 2 && segments[0] === 'cleanup' && segments[1] === 'retry' && request.method === 'POST') {
      const body = await readJson(request)
      const requestedLimit = body.limit === undefined ? 50 : Number(body.limit)
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 500) {
        throw new AuthoringServiceError('validation', '清理重试数量必须是 1 到 500 之间的整数。', { field: 'limit' })
      }
      return json(await service.retryCleanup(requestedLimit, context))
    }
    if (segments[0] === 'works' && segments.length === 1 && request.method === 'POST') {
      return json(await service.createWork(await readJson(request) as any, context), 201)
    }
    if (segments[0] !== 'works' || !segments[1]) throw new AuthoringServiceError('not_found', 'Work Authoring API 路径不存在。')
    const workId = segments[1]
    if (segments.length === 2 && request.method === 'GET') return json(await service.getWork(workId, context))
    if (segments.length === 3 && segments[2] === 'draft' && request.method === 'PUT') {
      return json(await service.saveDraft(workId, await readJson(request) as any, context))
    }
    if (segments.length === 3 && segments[2] === 'publish' && request.method === 'POST') {
      return json(await service.publish(workId, await readJson(request) as any, context))
    }
    if (segments.length === 4 && segments[2] === 'uploads' && segments[3] === 'authorize' && request.method === 'POST') {
      return json(await service.authorizeUpload(workId, await readJson(request) as any, context))
    }
    if (segments.length === 4 && segments[2] === 'uploads' && segments[3] === 'finalize' && request.method === 'POST') {
      return json(await service.finalizeUpload(workId, await readJson(request) as any, context))
    }
    if (segments.length === 4 && segments[2] === 'media' && request.method === 'DELETE') {
      const body = await readJson(request)
      return json(await service.discardMedia(workId, segments[3], String(body.revision || ''), context))
    }
    throw new AuthoringServiceError('not_found', 'Work Authoring API 路径不存在。')
  } catch (error) {
    if (error instanceof AuthoringServiceError) {
      if (error.code === 'stale_revision' && error.currentRevision && !error.aggregate) {
        const segments = pathSegments(request)
        const workId = segments[1]
        if (workId) {
          try {
            const aggregate = await service.getWork(workId, withContext(options))
            return json({ error: { ...errorBody(error).error, aggregate } }, error.status)
          } catch {
            // Keep the conflict response useful even when the refresh read fails.
          }
        }
      }
      return json(errorBody(error), error.status)
    }
    return json({ error: { code: 'unknown', message: 'Work Authoring API 服务暂时不可用。' } }, 503)
  }
}

export function authoringErrorResponse(error: AuthoringServiceError, aggregate?: WorkAggregate): Response {
  return json({ error: { ...errorBody(error).error, aggregate: aggregate || error.aggregate } }, error.status)
}
