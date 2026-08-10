import { describe, expect, it, vi } from 'vitest'

import { PayloadArchiveSource } from './payload-source'

describe('PayloadArchiveSource media storage seam', () => {
  it('uses the persisted prefix and filename for a presigned object URL', async () => {
    const presignGet = vi.fn().mockResolvedValue('https://r2.example.test/signed')
    const source = new PayloadArchiveSource(
      { find: vi.fn(), findByID: vi.fn() },
      { get: vi.fn(), presignGet },
    )
    const media = {
      id: 'media-1',
      filename: 'same.pdf',
      contentType: 'application/pdf',
      size: 10,
      workId: 'W1',
      prefix: 'media-1',
    }

    await expect(source.createMediaAccessUrl(media, 60)).resolves.toBe('https://r2.example.test/signed')
    expect(presignGet).toHaveBeenCalledWith('media-1/same.pdf', 60)
  })
})
