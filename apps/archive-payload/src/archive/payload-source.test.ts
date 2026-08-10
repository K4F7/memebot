import { describe, expect, it, vi } from 'vitest'

import { PayloadArchiveSource } from './payload-source'

describe('PayloadArchiveSource media storage seam', () => {
  it('uses the Payload PostgreSQL drizzle handle for exact database search', async () => {
    const drizzle = {}
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ archiveId: 'W1', title: 'One', author: 'Author', __total: 2 }] })
    const source = new PayloadArchiveSource(
      { find: vi.fn(), findByID: vi.fn(), db: { drizzle, execute } },
      { get: vi.fn() },
    )

    await expect(source.searchWorksWithTotal('one')).resolves.toEqual({
      data: [{ id: 'W1', title: 'One', author: 'Author', description: undefined }],
      total: 2,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toMatchObject({ drizzle })
  })

  it('uses the persisted opaque storage key for a presigned object URL', async () => {
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
      storageKey: 'media/11111111-1111-4111-8111-111111111111',
    }

    await expect(source.createMediaAccessUrl(media, 60)).resolves.toBe('https://r2.example.test/signed')
    expect(presignGet).toHaveBeenCalledWith('media/11111111-1111-4111-8111-111111111111', 60)
  })

  it('does not expose withdrawn media through the read source', async () => {
    const source = new PayloadArchiveSource(
      { find: vi.fn(), findByID: vi.fn().mockResolvedValue({ id: 'media-1', withdrawnAt: '2026-08-10T00:00:00.000Z' }) },
      { get: vi.fn() },
    )

    await expect(source.getMedia('media-1')).resolves.toBeUndefined()
  })

  it('reads the published ordered manifest instead of live WorkMedia rows', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce({ docs: [{ id: 1, archiveId: 'W1', title: 'Published', author: 'Author', _status: 'published', mediaManifest: [{ mediaId: '11', filename: 'cover.png', caption: 'Cover' }] }] })
      .mockResolvedValueOnce({ docs: [{ id: 11, work: 1, filename: 'draft-name.png', mimeType: 'image/png', filesize: 12, storageKey: 'media/11111111-1111-4111-8111-111111111111', uploadStatus: 'finalized' }] })
    const source = new PayloadArchiveSource(
      { find, findByID: vi.fn() },
      { get: vi.fn() },
    )

    await expect(source.getWork('W1')).resolves.toMatchObject({
      id: 'W1',
      media: [{ id: '11', filename: 'cover.png', caption: 'Cover' }],
    })
    expect(find.mock.calls[0][0]).toMatchObject({ draft: false })
  })

  it('hides draft-only Media even when its storage key is valid', async () => {
    const findByID = vi.fn()
      .mockResolvedValueOnce({ id: 'media-1', work: 'work-1', filename: 'draft.png', mimeType: 'image/png', filesize: 1, storageKey: 'media/11111111-1111-4111-8111-111111111111', uploadStatus: 'finalized' })
      .mockResolvedValueOnce({ id: 'work-1', _status: 'draft', mediaManifest: [{ mediaId: 'media-1', filename: 'draft.png' }] })
    const source = new PayloadArchiveSource(
      { find: vi.fn(), findByID },
      { get: vi.fn() },
    )
    await expect(source.getMedia('media-1')).resolves.toBeUndefined()
  })
})
