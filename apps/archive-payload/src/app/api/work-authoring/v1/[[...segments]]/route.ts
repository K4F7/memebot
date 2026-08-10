import { createLocalReq, getPayload } from 'payload'

import config from '@payload-config'
import { handleWorkAuthoringApi } from '@/archive/work-authoring-api'
import { R2AuthoringObjectStore } from '@/archive/r2-authoring-store'
import { PayloadWorkAuthoringRepository } from '@/archive/payload-work-authoring'
import { AuthoringService } from '@/archive/work-authoring'

export const runtime = 'nodejs'

function createAuthoringService(payload: any): AuthoringService {
  return new AuthoringService(
    new PayloadWorkAuthoringRepository(payload),
    new R2AuthoringObjectStore(),
    { uploadSecret: process.env.ARCHIVE_MEDIA_SIGNING_SECRET || process.env.PAYLOAD_SECRET },
  )
}

async function handle(request: Request): Promise<Response> {
  try {
    const payload = await getPayload({ config: await config })
    const auth = await payload.auth({ headers: request.headers })
    if (!auth.user) return handleWorkAuthoringApi(request, createAuthoringService(payload), {})
    const req = await createLocalReq({
      req: { headers: request.headers, url: request.url },
      user: auth.user,
      urlSuffix: '/api/work-authoring/v1',
    }, payload)
    const service = createAuthoringService(payload)
    return handleWorkAuthoringApi(request, service, { user: auth.user, requestContext: req as any })
  } catch (error) {
    console.error('[work-authoring-api] request failed', error instanceof Error ? error.message : error)
    return new Response(JSON.stringify({ error: { code: 'unknown', message: 'Work Authoring API 服务暂时不可用。' } }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const DELETE = handle
