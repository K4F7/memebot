import { describe, expect, it } from 'vitest'

import {
  AuthoringService,
  InMemoryAuthoringObjectStore,
  InMemoryWorkAuthoringRepository,
} from './work-authoring'

describe('Work Authoring aggregate seam', () => {
  it('keeps a draft private until publish and rejects stale saves', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore)

    const draft = await authoring.createWork({ title: '作品', author: '作者' })
    expect(draft.publicationStatus).toBe('draft')
    expect(draft.archiveId).toBe('W1')
    expect((await authoring.getWork(draft.workId)).published).toBeUndefined()

    const saved = await authoring.saveDraft(draft.workId, {
      revision: draft.revision,
      title: '作品（修订）',
      author: '作者',
      media: [],
    })
    expect(saved.title).toBe('作品（修订）')
    expect(saved.revision).not.toBe(draft.revision)

    await expect(authoring.saveDraft(draft.workId, {
      revision: draft.revision,
      title: '过期写入',
      author: '作者',
      media: [],
    })).rejects.toMatchObject({ code: 'stale_revision', currentRevision: saved.revision })

    await expect(authoring.publish(draft.workId, { revision: saved.revision })).rejects.toMatchObject({ code: 'validation' })
  })

  it('finalizes uploads idempotently and preserves browser selection order', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore, { uploadSecret: 'test-secret' })
    const draft = await authoring.createWork({ title: '作品', author: '作者' })

    const first = await authoring.authorizeUpload(draft.workId, {
      revision: draft.revision,
      filename: 'first.png',
      filesize: 3,
      mimeType: 'image/png',
      selectionIndex: 1,
    })
    objectStore.put(first.upload.storageKey, 3, 'image/png')
    const firstFinal = await authoring.finalizeUpload(draft.workId, {
      revision: draft.revision,
      uploadId: first.upload.uploadId,
      idempotencyKey: 'idem-first',
      context: first.upload.context,
      selectionIndex: 1,
    })
    expect(firstFinal.media.map((item) => item.filename)).toEqual(['first.png'])

    const second = await authoring.authorizeUpload(draft.workId, {
      revision: firstFinal.revision,
      filename: 'zero.pdf',
      filesize: 4,
      mimeType: 'application/pdf',
      selectionIndex: 0,
    })
    objectStore.put(second.upload.storageKey, 4, 'application/pdf')
    const secondFinal = await authoring.finalizeUpload(draft.workId, {
      revision: firstFinal.revision,
      uploadId: second.upload.uploadId,
      idempotencyKey: 'idem-second',
      context: second.upload.context,
      selectionIndex: 0,
    })
    expect(secondFinal.media.map((item) => item.filename)).toEqual(['zero.pdf', 'first.png'])

    const retry = await authoring.finalizeUpload(draft.workId, {
      revision: draft.revision,
      uploadId: first.upload.uploadId,
      idempotencyKey: 'idem-first',
      context: first.upload.context,
      selectionIndex: 1,
    })
    expect(retry.media.map((item) => item.mediaId)).toEqual(secondFinal.media.map((item) => item.mediaId))

    await expect(authoring.finalizeUpload(draft.workId, {
      revision: draft.revision,
      uploadId: second.upload.uploadId,
      idempotencyKey: 'idem-first',
      context: second.upload.context,
      selectionIndex: 0,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('isolates published media while replacing a file and keeps relationship captions', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore, { uploadSecret: 'test-secret' })
    let aggregate = await authoring.createWork({ title: '作品', author: '作者' })

    const upload = await authoring.authorizeUpload(aggregate.workId, {
      revision: aggregate.revision,
      filename: 'cover.png',
      filesize: 3,
      mimeType: 'image/png',
    })
    objectStore.put(upload.upload.storageKey, 3, 'image/png')
    aggregate = await authoring.finalizeUpload(aggregate.workId, {
      revision: aggregate.revision,
      uploadId: upload.upload.uploadId,
      idempotencyKey: 'cover-1',
      context: upload.upload.context,
    })
    aggregate = await authoring.saveDraft(aggregate.workId, {
      revision: aggregate.revision,
      title: aggregate.title,
      author: aggregate.author,
      media: [{ mediaId: aggregate.media[0].mediaId, filename: 'cover.png', alt: '旧替代文本', caption: '保留说明' }],
    })
    aggregate = await authoring.publish(aggregate.workId, { revision: aggregate.revision })
    const publishedMediaId = aggregate.published!.media[0].mediaId

    const replacement = await authoring.authorizeUpload(aggregate.workId, {
      revision: aggregate.revision,
      filename: 'cover-v2.png',
      filesize: 5,
      mimeType: 'image/png',
      replaceMediaId: publishedMediaId,
    })
    objectStore.put(replacement.upload.storageKey, 5, 'image/png')
    const edited = await authoring.finalizeUpload(aggregate.workId, {
      revision: aggregate.revision,
      uploadId: replacement.upload.uploadId,
      idempotencyKey: 'cover-2',
      context: replacement.upload.context,
      replaceMediaId: publishedMediaId,
    })

    expect(edited.publicationStatus).toBe('unpublished_draft')
    expect(edited.published!.media[0].filename).toBe('cover.png')
    expect(edited.media[0].filename).toBe('cover-v2.png')
    expect(edited.media[0].caption).toBe('保留说明')
    expect(edited.media[0].alt).toBeUndefined()

    const republished = await authoring.publish(aggregate.workId, { revision: edited.revision })
    expect(republished.publicationStatus).toBe('published')
    expect(republished.published!.media[0].filename).toBe('cover-v2.png')
  })

  it('rejects unsupported and oversized files before creating an R2 upload', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore, { uploadSecret: 'test-secret' })
    const draft = await authoring.createWork({ title: '作品', author: '作者' })

    await expect(authoring.authorizeUpload(draft.workId, {
      revision: draft.revision,
      filename: 'bad.svg',
      filesize: 1,
      mimeType: 'image/svg+xml',
    })).rejects.toMatchObject({ code: 'unsupported_file' })
    await expect(authoring.authorizeUpload(draft.workId, {
      revision: draft.revision,
      filename: 'large.pdf',
      filesize: 100 * 1024 * 1024 + 1,
      mimeType: 'application/pdf',
    })).rejects.toMatchObject({ code: 'oversize_file' })
    await expect(repository.listMedia(draft.workId)).resolves.toEqual([])
  })

  it('cleans never-published media removed by a complete draft save', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore, { uploadSecret: 'test-secret' })
    const draft = await authoring.createWork({ title: '作品', author: '作者' })
    const upload = await authoring.authorizeUpload(draft.workId, {
      revision: draft.revision,
      filename: 'remove.png',
      filesize: 3,
      mimeType: 'image/png',
    })
    objectStore.put(upload.upload.storageKey, 3, 'image/png')
    const finalized = await authoring.finalizeUpload(draft.workId, {
      revision: draft.revision,
      uploadId: upload.upload.uploadId,
      idempotencyKey: 'remove-1',
      context: upload.upload.context,
    })

    const saved = await authoring.saveDraft(draft.workId, {
      revision: finalized.revision,
      title: finalized.title,
      author: finalized.author,
      media: [],
    })
    expect(saved.media).toEqual([])
    await expect(repository.listMedia(draft.workId)).resolves.toEqual([])
    expect(repository.cleanupIntents.get(upload.upload.storageKey)).toMatchObject({ mediaId: finalized.media[0].mediaId })
    await expect(objectStore.head(upload.upload.storageKey)).resolves.toBeNull()
  })

  it('keeps the published snapshot and complete draft when promotion fails', async () => {
    const repository = new InMemoryWorkAuthoringRepository()
    const objectStore = new InMemoryAuthoringObjectStore()
    const authoring = new AuthoringService(repository, objectStore)
    const draft = await authoring.createWork({ title: '作品', author: '作者' })

    // The in-memory seam can represent a finalized media row without involving R2.
    const media = await repository.createPendingMedia({ workId: draft.workId, uploadId: 'upload-1', filename: 'one.png', filesize: 1, mimeType: 'image/png', storageKey: 'media/11111111-1111-4111-8111-111111111111' })
    await repository.finalizeUpload({ workId: draft.workId, mediaId: media.id, expectedRevision: draft.revision, revision: 'rev-ready', media: [{ mediaId: media.id, filename: 'one.png' }] })
    const ready = await authoring.getWork(draft.workId)
    const published = await authoring.publish(draft.workId, { revision: ready.revision })
    const edited = await authoring.saveDraft(draft.workId, { revision: published.revision, title: '新标题', author: '作者', media: [{ mediaId: media.id, filename: 'one.png' }] })

    repository.publish = async () => { throw new Error('injected publication failure') }
    await expect(authoring.publish(draft.workId, { revision: edited.revision })).rejects.toMatchObject({ code: 'publication_failed' })
    const afterFailure = await authoring.getWork(draft.workId)
    expect(afterFailure.title).toBe('新标题')
    expect(afterFailure.published?.title).toBe('作品')
    expect(afterFailure.published?.media[0].filename).toBe('one.png')
  })
})
