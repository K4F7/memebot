import { afterEach, describe, expect, it } from 'vitest'

import { buildPdfValidationSample, generateR2UploadUrl } from './r2-payload-storage'

const savedEnv = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('R2 upload signer', () => {
  it('builds a bounded PDF validation sample from the real header and trailer', async () => {
    const calls: Array<[number, number]> = []
    const sample = await buildPdfValidationSample(10 * 1024 * 1024, async (start, end) => {
      calls.push([start, end])
      return Buffer.from(start === 0 ? '%PDF-1.7\n' : 'xref\n%%EOF')
    })

    expect(calls).toEqual([[0, 1023], [10 * 1024 * 1024 - 1024, 10 * 1024 * 1024 - 1]])
    expect(sample.subarray(0, 8).toString()).toBe('%PDF-1.7')
    expect(sample.toString()).toContain('xref\n%%EOF')
  })

  it('validates the upload size before issuing a presigned URL', async () => {
    Object.assign(process.env, {
      PAYLOAD_SECRET: 'test-secret',
      R2_ACCESS_KEY_ID: 'test-access',
      R2_BUCKET: 'test-bucket',
      R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
    })
    const request = new Request('https://archive.test/api/storage-r2-generate-signed-url', {
      body: JSON.stringify({ collectionSlug: 'media', filename: 'same.pdf', filesize: 10, mimeType: 'application/pdf' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }) as any
    request.user = { id: 'user-1' }

    const response = await generateR2UploadUrl(request)
    expect(response.status).toBe(200)
    const body = await response.json() as { context: { storageKey: string }; url: string }
    expect(body.url).toContain('account.r2.cloudflarestorage.com')
    expect(body.url.toLowerCase()).not.toContain('x-amz-checksum')
    expect(body.context.storageKey).toMatch(/^media\/[0-9a-f-]{36}$/)

    const oversized = new Request(request.url, {
      body: JSON.stringify({ collectionSlug: 'media', filename: 'large.pdf', filesize: 100 * 1024 * 1024 + 1, mimeType: 'application/pdf' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }) as any
    oversized.user = request.user
    await expect(generateR2UploadUrl(oversized)).rejects.toMatchObject({ status: 400 })
  })
})
