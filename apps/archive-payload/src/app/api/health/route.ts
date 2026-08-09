import { getPayload } from 'payload'

import config from '@payload-config'
import { createR2ObjectStore } from '@/archive/s3-storage'

export const runtime = 'nodejs'

let storageVerified = false

export async function GET() {
  try {
    const payload = await getPayload({ config: await config })
    await payload.find({
      collection: 'users',
      limit: 1,
      pagination: false,
      overrideAccess: true,
    })
    if (!storageVerified) {
      const storage = createR2ObjectStore()
      if (!storage) throw new Error('R2 S3 storage is not configured.')
      // A missing key is acceptable; a failed authenticated request is not.
      await storage.get('__memebot_healthcheck__')
      storageVerified = true
    }
    return Response.json({ status: 'ok' })
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 })
  }
}
