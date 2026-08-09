import { getPayload } from 'payload'

import config from '@payload-config'
import { handleArchiveApi } from '@/archive/api'
import { createR2ObjectStore } from '@/archive/s3-storage'
import { PayloadArchiveSource } from '@/archive/payload-source'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const payloadConfig = await config
    const payload = await getPayload({ config: payloadConfig })
    const bucket = createR2ObjectStore()
    if (!bucket) {
      return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'R2 S3 storage 未配置。' } }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return handleArchiveApi(request, new PayloadArchiveSource(payload as any, bucket), {
      serviceToken: process.env.ARCHIVE_SERVICE_TOKEN || '',
      signingSecret: process.env.ARCHIVE_MEDIA_SIGNING_SECRET || '',
    })
  } catch {
    return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Archive 服务暂时不可用。' } }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
}
