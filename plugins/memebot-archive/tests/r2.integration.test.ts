import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchivePreflight } from '../src/extensions'
import { S3R2Store } from '../src/s3'

const required = ['MEMEBOT_R2_ACCOUNT_ID', 'MEMEBOT_R2_BUCKET_NAME', 'MEMEBOT_R2_ACCESS_KEY_ID', 'MEMEBOT_R2_SECRET_ACCESS_KEY'] as const
const enabled = required.every(name => process.env[name])

describe.skipIf(!enabled)('real R2 preflight', () => {
  it('writes, reads, checksums, and deletes the diagnostic object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memebot-r2-integration-'))
    try {
      const store = new S3R2Store({
        accountId: process.env.MEMEBOT_R2_ACCOUNT_ID!, bucketName: process.env.MEMEBOT_R2_BUCKET_NAME!,
        accessKeyId: process.env.MEMEBOT_R2_ACCESS_KEY_ID!, secretAccessKey: process.env.MEMEBOT_R2_SECRET_ACCESS_KEY!,
      })
      expect((await new ArchivePreflight(root, store, [process.env.MEMEBOT_R2_ACCESS_KEY_ID!, process.env.MEMEBOT_R2_SECRET_ACCESS_KEY!]).check()).state).toBe('ready')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
