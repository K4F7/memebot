import { describe, expect, it } from 'vitest'

import {
  MAX_MEDIA_SIZE,
  ensureMediaStorageKey,
  createStorageKey,
  createUploadContext,
  verifyUploadContext,
} from './media-policy'
import { Media } from '../collections/Media'

describe('media storage policy', () => {
  it('creates opaque, independent storage keys', () => {
    const first = createStorageKey()
    const second = createStorageKey()

    expect(first).toMatch(/^media\/[0-9a-f-]{36}$/)
    expect(second).toMatch(/^media\/[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
    expect(first).not.toContain('filename')
  })

  it('signs and rejects tampered or expired client upload contexts', () => {
    const context = createUploadContext(
      {
        filename: 'same.pdf',
        filesize: 42,
        mimeType: 'application/pdf',
        storageKey: 'media/11111111-1111-4111-8111-111111111111',
      },
      { now: 1_700_000_000_000, secret: 'test-secret', ttlSeconds: 60 },
    )

    expect(verifyUploadContext(context, { now: 1_700_000_030_000, secret: 'test-secret' })).toEqual(context)
    expect(verifyUploadContext({ ...context, storageKey: 'media/22222222-2222-4222-8222-222222222222' }, { now: 1_700_000_030_000, secret: 'test-secret' })).toBeNull()
    expect(verifyUploadContext(context, { now: 1_700_000_061_000, secret: 'test-secret' })).toBeNull()
  })

  it('keeps an existing key for metadata updates and rejects client changes', () => {
    const original = { storageKey: 'media/11111111-1111-4111-8111-111111111111' }

    expect(ensureMediaStorageKey({ data: {}, originalDoc: original, req: {} })).toEqual(original)
    expect(() => ensureMediaStorageKey({ data: { storageKey: 'media/22222222-2222-4222-8222-222222222222' }, originalDoc: original, req: {} })).toThrow(/storage key/i)
  })

  it('rejects a client upload whose declared metadata differs from the signed context', () => {
    const previousSecret = process.env.PAYLOAD_SECRET
    process.env.PAYLOAD_SECRET = 'test-secret'
    const context = createUploadContext(
      {
        filename: 'same.pdf',
        filesize: 42,
        mimeType: 'application/pdf',
        storageKey: 'media/11111111-1111-4111-8111-111111111111',
      },
      { secret: 'test-secret' },
    )

    try {
      expect(() => ensureMediaStorageKey({ data: {}, req: { file: { clientUploadContext: context, size: 41, mimetype: 'application/pdf' } } })).toThrow(/size/i)
      expect(ensureMediaStorageKey({ data: {}, req: { file: { clientUploadContext: context, size: 42, mimetype: 'application/octet-stream' } } })).toMatchObject({
        storageKey: context.storageKey,
      })
    } finally {
      if (previousSecret === undefined) delete process.env.PAYLOAD_SECRET
      else process.env.PAYLOAD_SECRET = previousSecret
    }
  })

  it('exposes the single upload limit used by Payload and the signer', () => {
    expect(MAX_MEDIA_SIZE).toBe(100 * 1024 * 1024)
  })

  it('preserves duplicate display filenames for signed client uploads', () => {
    const hook = Media.hooks?.beforeOperation?.[0] as any
    const result = hook({
      args: { overwriteExistingFiles: false },
      operation: 'create',
      req: { file: { clientUploadContext: { version: 1 } } },
    })

    expect(result).toMatchObject({ overwriteExistingFiles: true })
  })
})
