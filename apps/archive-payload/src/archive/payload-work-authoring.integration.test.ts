import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'

import {
  AuthoringService,
  InMemoryAuthoringObjectStore,
} from './work-authoring'
import { PayloadWorkAuthoringRepository } from './payload-work-authoring'
import { createStorageKey } from './media-policy'

/**
 * Opt-in integration coverage for the transaction boundary. CI intentionally
 * skips this suite unless a disposable PostgreSQL URL is provided; the URL
 * must never point at a shared or production database because Payload runs in
 * schema-push mode for this test environment.
 */
const databaseUrl = process.env.MEMEBOT_PAYLOAD_TEST_DATABASE_URL
const describeDatabase = describe.skipIf(!databaseUrl)

describeDatabase('Payload Work Authoring PostgreSQL seam', () => {
  let payload: any
  let authoring: AuthoringService
  let objectStore: InMemoryAuthoringObjectStore
  let repository: PayloadWorkAuthoringRepository
  const previousDatabaseUrl = process.env.DATABASE_URL
  const previousPayloadSecret = process.env.PAYLOAD_SECRET
  const previousUploadSecret = process.env.ARCHIVE_MEDIA_SIGNING_SECRET

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl
    process.env.PAYLOAD_SECRET = 'memebot-integration-payload-secret'
    process.env.ARCHIVE_MEDIA_SIGNING_SECRET = 'memebot-integration-upload-secret'
    const { default: config } = await import('../payload.config')
    payload = await getPayload({ config, key: `memebot-authoring-${Date.now()}` })
    objectStore = new InMemoryAuthoringObjectStore()
    repository = new PayloadWorkAuthoringRepository(payload)
    authoring = new AuthoringService(
      repository,
      objectStore,
      { uploadSecret: 'memebot-integration-upload-secret' },
    )
  })

  afterAll(async () => {
    if (payload) await payload.destroy()
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
    if (previousPayloadSecret === undefined) delete process.env.PAYLOAD_SECRET
    else process.env.PAYLOAD_SECRET = previousPayloadSecret
    if (previousUploadSecret === undefined) delete process.env.ARCHIVE_MEDIA_SIGNING_SECRET
    else process.env.ARCHIVE_MEDIA_SIGNING_SECRET = previousUploadSecret
  })

  it('persists a draft, finalizes media, publishes, and rejects a stale write', async () => {
    const draft = await authoring.createWork({
      title: `Integration Work ${Date.now()}`,
      author: 'Integration Author',
    })
    const upload = await authoring.authorizeUpload(draft.workId, {
      revision: draft.revision,
      filename: 'integration.png',
      filesize: 3,
      mimeType: 'image/png',
    })
    objectStore.put(upload.upload.storageKey, 3, 'image/png')
    const finalized = await authoring.finalizeUpload(draft.workId, {
      revision: draft.revision,
      uploadId: upload.upload.uploadId,
      idempotencyKey: `integration-${Date.now()}`,
      context: upload.upload.context,
    })
    const published = await authoring.publish(draft.workId, { revision: finalized.revision })
    expect(published.publicationStatus).toBe('published')
    expect(published.published?.media[0].filename).toBe('integration.png')
    const publicDoc = await payload.findByID({ collection: 'works', id: draft.workId, depth: 0, draft: false, overrideAccess: true })
    expect(publicDoc?._status).toBe('published')

    const edited = await authoring.saveDraft(draft.workId, {
      revision: published.revision,
      title: 'Edited Integration Work',
      author: 'Integration Author',
      media: published.media.map((item) => ({ mediaId: item.mediaId, filename: item.filename })),
    })
    const secondUpload = await authoring.authorizeUpload(draft.workId, {
      revision: edited.revision,
      filename: 'integration-second.png',
      filesize: 4,
      mimeType: 'image/png',
    })
    objectStore.put(secondUpload.upload.storageKey, 4, 'image/png')
    const secondFinal = await authoring.finalizeUpload(draft.workId, {
      revision: edited.revision,
      uploadId: secondUpload.upload.uploadId,
      idempotencyKey: `integration-second-${Date.now()}`,
      context: secondUpload.upload.context,
    })
    const originalUpdate = payload.update.bind(payload)
    payload.update = async (args: Record<string, unknown>) => {
      if (args.collection === 'works' && args.draft === false) throw new Error('injected publication failure')
      return originalUpdate(args)
    }
    try {
      await expect(authoring.publish(draft.workId, { revision: secondFinal.revision })).rejects.toMatchObject({ code: 'publication_failed' })
    } finally {
      payload.update = originalUpdate
    }
    const afterFailure = await authoring.getWork(draft.workId)
    expect(afterFailure.title).toBe('Edited Integration Work')
    expect(afterFailure.published?.title).toBe(published.title)
    const secondMediaDoc = await payload.findByID({ collection: 'media', id: secondFinal.mediaItem.mediaId, depth: 0, overrideAccess: true })
    expect(secondMediaDoc?.everPublished).toBe(false)

    await expect(authoring.saveDraft(draft.workId, {
      revision: draft.revision,
      title: 'stale write',
      author: 'Integration Author',
      media: [],
    })).rejects.toMatchObject({ code: 'stale_revision' })

    const cleanupStorageKey = createStorageKey()
    await repository.recordCleanupIntent({ workId: draft.workId, mediaId: secondFinal.mediaItem.mediaId, storageKey: cleanupStorageKey })
    const claimedCleanup = await repository.claimCleanupIntents({ limit: 10 })
    expect(claimedCleanup).toMatchObject([{ storageKey: cleanupStorageKey, status: 'processing', attempts: 1 }])
    await expect(repository.claimCleanupIntents({ limit: 10 })).resolves.toEqual([])
    await repository.markCleanupIntent({ storageKey: cleanupStorageKey, status: 'failed', attempts: 1, lastError: 'test' })

    const loaded = await authoring.getWork(draft.workId)
    expect(loaded.published?.title).toBe(published.title)
    expect(loaded.published?.media[0].filename).toBe('integration.png')
  })
})
