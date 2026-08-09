import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getPayload } from 'payload'

import config from '@payload-config'
import { handleArchiveApi } from '@/archive/api'
import { PayloadArchiveSource } from '@/archive/payload-source'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const cloudflare = await getCloudflareContext({ async: true })
    const payloadConfig = await config
    const payload = await getPayload({ config: payloadConfig })
    const env = cloudflare.env as unknown as {
      ARCHIVE_SERVICE_TOKEN?: string
      ARCHIVE_MEDIA_SIGNING_SECRET?: string
      R2?: { get(key: string): Promise<any> }
    }
    const serviceToken = env.ARCHIVE_SERVICE_TOKEN || process.env.ARCHIVE_SERVICE_TOKEN || ''
    const signingSecret = env.ARCHIVE_MEDIA_SIGNING_SECRET || process.env.ARCHIVE_MEDIA_SIGNING_SECRET || process.env.PAYLOAD_SECRET || ''
    const bucket = env.R2
    if (!bucket) return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'R2 binding 未配置。' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    return handleArchiveApi(request, new PayloadArchiveSource(payload as any, bucket), { serviceToken, signingSecret })
  } catch {
    return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Archive 服务暂时不可用。' } }), { status: 503, headers: { 'content-type': 'application/json' } })
  }
}
