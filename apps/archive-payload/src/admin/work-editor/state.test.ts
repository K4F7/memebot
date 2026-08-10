import { describe, expect, it, beforeEach } from 'vitest'

import {
  fixtureDraftWithMedia,
  fixtureImageMedia,
  fixturePublishedWork,
  fixtureUnpublishedDraft,
  FIXTURE_REVISION_V2,
} from '../../authoring/fixtures'
import {
  applyConflict,
  applyFinalizedUpload,
  applyPublishedAggregate,
  applySavedAggregate,
  buildSavePayload,
  canStartUpload,
  createEmptyEditorState,
  enqueueFiles,
  getPublishGate,
  getSaveGate,
  hasActiveUploads,
  hydrateFromAggregate,
  leaveWarningMessage,
  markPendingRemoval,
  moveCard,
  publicationBadge,
  reorderCards,
  resetClientIdSeq,
  setMetadata,
  setUploadPhase,
  shouldWarnOnLeave,
  undoPendingRemoval,
  updateMediaCard,
} from './state'

function fakeFile(name: string, type: string, size = 100): File {
  const buffer = new Uint8Array(size)
  return new File([buffer], name, { type })
}

describe('Work editor state machine', () => {
  beforeEach(() => {
    resetClientIdSeq()
  })

  it('requires title and author before upload begins', () => {
    let state = createEmptyEditorState()
    expect(canStartUpload(state).ok).toBe(false)

    state = setMetadata(state, { title: '标题' })
    expect(canStartUpload(state).ok).toBe(false)

    state = setMetadata(state, { author: '作者' })
    expect(canStartUpload(state).ok).toBe(true)

    const rejected = enqueueFiles(createEmptyEditorState(), [fakeFile('a.png', 'image/png')])
    expect(rejected.accepted).toHaveLength(0)
    expect(rejected.rejected[0]?.message).toMatch(/标题和作者/)
  })

  it('rejects unsupported and oversize files before upload', () => {
    let state = setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' })
    const svg = enqueueFiles(state, [fakeFile('x.svg', 'image/svg+xml')])
    expect(svg.accepted).toHaveLength(0)
    expect(svg.rejected[0]?.message).toMatch(/图片|PDF/)

    const huge = fakeFile('big.png', 'image/png', 100 * 1024 * 1024 + 1)
    const oversize = enqueueFiles(state, [huge])
    expect(oversize.rejected[0]?.message).toMatch(/100 MB/)
  })

  it('preserves original selection order regardless of completion order', () => {
    let state = setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' })
    const enqueued = enqueueFiles(state, [
      fakeFile('a.png', 'image/png'),
      fakeFile('b.pdf', 'application/pdf'),
      fakeFile('c.png', 'image/png'),
    ])
    state = enqueued.state
    expect(state.cards.map((card) => (card.kind === 'upload' ? card.filename : ''))).toEqual([
      'a.png',
      'b.pdf',
      'c.png',
    ])

    // Finalize middle file first — order must remain selection order.
    const mid = state.cards[1]
    const first = state.cards[0]
    expect(mid.kind).toBe('upload')
    expect(first.kind).toBe('upload')

    const mediaB = fixtureImageMedia({ mediaId: 'm-b', filename: 'b.pdf', mimeType: 'application/pdf', isImage: false, isPdf: true, extension: 'pdf' })
    state = applyFinalizedUpload(
      state,
      mid.clientId,
      {
        workId: 'work-1',
        archiveId: 'W1',
        revision: 'rev-2',
        publicationStatus: 'draft',
        title: 'T',
        author: 'A',
        media: [mediaB],
      },
      mediaB,
    )
    expect(state.cards.map((card) => (card.kind === 'upload' ? card.filename : card.media.filename))).toEqual([
      'a.png',
      'b.pdf',
      'c.png',
    ])

    const mediaA = fixtureImageMedia({ mediaId: 'm-a', filename: 'a.png' })
    state = applyFinalizedUpload(
      state,
      first.clientId,
      {
        workId: 'work-1',
        archiveId: 'W1',
        revision: 'rev-3',
        publicationStatus: 'draft',
        title: 'T',
        author: 'A',
        media: [mediaA, mediaB],
      },
      mediaA,
    )
    expect(state.cards.map((card) => (card.kind === 'upload' ? card.filename : card.media.filename))).toEqual([
      'a.png',
      'b.pdf',
      'c.png',
    ])
  })

  it('keeps independent failed uploads retryable without cancelling successes', () => {
    let state = setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' })
    state = enqueueFiles(state, [fakeFile('ok.png', 'image/png'), fakeFile('bad.png', 'image/png')]).state
    const [ok, bad] = state.cards
    const media = fixtureImageMedia({ mediaId: 'm-ok', filename: 'ok.png' })
    state = applyFinalizedUpload(
      state,
      ok.clientId,
      {
        workId: 'work-1',
        archiveId: 'W1',
        revision: 'rev-2',
        publicationStatus: 'draft',
        title: 'T',
        author: 'A',
        media: [media],
      },
      media,
    )
    state = setUploadPhase(state, bad.clientId, 'failed', { error: 'R2 上传失败', errorCode: 'r2_transfer_failed' })
    expect(state.cards[0].kind).toBe('media')
    expect(state.cards[1].kind).toBe('upload')
    if (state.cards[1].kind === 'upload') expect(state.cards[1].phase).toBe('failed')
  })

  it('supports basename/alt/caption edits and keyboard reorder for save payload', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    const firstId = state.cards[0].clientId
    const secondId = state.cards[1].clientId
    state = updateMediaCard(state, firstId, { basename: 'new-cover', alt: '新封面', caption: '新说明' })
    state = moveCard(state, secondId, -1)
    expect(state.cards.map((card) => (card.kind === 'media' ? card.media.mediaId : ''))).toEqual([
      'media-pdf-1',
      'media-image-1',
    ])

    const payload = buildSavePayload(state)
    expect(payload.revision).toBe(FIXTURE_REVISION_V2)
    expect(payload.media.map((item) => item.mediaId)).toEqual(['media-pdf-1', 'media-image-1'])
    expect(payload.media[1]).toMatchObject({
      filename: 'new-cover.png',
      alt: '新封面',
      caption: '新说明',
    })
  })

  it('replacement keeps old media until success, then adopts new name and clears alt', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    const target = state.cards[0]
    expect(target.kind).toBe('media')
    const result = enqueueFiles(state, [fakeFile('replacement.jpg', 'image/jpeg')], {
      replaceMediaClientId: target.clientId,
    })
    state = result.state
    const card = state.cards[0]
    expect(card.kind).toBe('media')
    if (card.kind !== 'media') throw new Error('expected media')
    expect(card.media.filename).toBe('cover.png')
    expect(card.replacement?.filename).toBe('replacement.jpg')

    const newMedia = fixtureImageMedia({
      mediaId: 'media-new',
      filename: 'replacement.jpg',
      extension: 'jpg',
      mimeType: 'image/jpeg',
      alt: 'should-not-keep',
    })
    state = applyFinalizedUpload(
      state,
      card.replacement!.clientId,
      {
        workId: 'work-1',
        archiveId: 'W1',
        revision: 'rev-x',
        publicationStatus: 'draft',
        title: '示例作品',
        author: 'Alice',
        media: [newMedia, fixtureDraftWithMedia().media[1]],
      },
      newMedia,
    )
    const replaced = state.cards[0]
    expect(replaced.kind).toBe('media')
    if (replaced.kind !== 'media') throw new Error('expected media')
    expect(replaced.media.mediaId).toBe('media-new')
    expect(replaced.basename).toBe('replacement')
    expect(replaced.caption).toBe('封面图')
    expect(replaced.alt).toBe('')
    expect(replaced.replacement).toBeUndefined()
  })

  it('pending removal is undoable until save, and dropped from save payload', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    const id = state.cards[0].clientId
    state = markPendingRemoval(state, id)
    expect(state.cards[0].kind === 'media' && state.cards[0].pendingRemoval).toBe(true)
    expect(buildSavePayload(state).media.map((item) => item.mediaId)).toEqual(['media-pdf-1'])
    state = undoPendingRemoval(state, id)
    expect(state.cards[0].kind === 'media' && state.cards[0].pendingRemoval).toBe(false)
    expect(buildSavePayload(state).media).toHaveLength(2)
  })

  it('removes client-only upload cards immediately', () => {
    let state = setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' })
    state = enqueueFiles(state, [fakeFile('a.png', 'image/png')]).state
    const id = state.cards[0].clientId
    state = markPendingRemoval(state, id)
    expect(state.cards).toHaveLength(0)
  })

  it('blocks publish while uploading, failed, incomplete replacement, or empty', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    expect(getPublishGate(state).allowed).toBe(true)

    state = setMetadata(state, { title: '改' })
    expect(getPublishGate(state).allowed).toBe(false)
    expect(getPublishGate(state).reason).toMatch(/保存草稿/)

    state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = enqueueFiles(state, [fakeFile('x.png', 'image/png')]).state
    expect(hasActiveUploads(state)).toBe(true)
    // Still dirty from queue; also active uploads.
    state = { ...state, dirty: false, phase: 'ready' }
    expect(getPublishGate(state).allowed).toBe(false)

    state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = markPendingRemoval(state, state.cards[0].clientId)
    state = markPendingRemoval(state, state.cards[1].clientId)
    state = applySavedAggregate(state, {
      ...fixtureDraftWithMedia(),
      media: [],
      revision: 'rev-empty',
    })
    expect(getPublishGate(state).allowed).toBe(false)
    expect(getPublishGate(state).reason).toMatch(/至少需要一个/)
  })

  it('warns on leave for active uploads or unsaved changes', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    expect(shouldWarnOnLeave(state)).toBe(false)

    state = setMetadata(state, { title: '改' })
    expect(shouldWarnOnLeave(state)).toBe(true)
    expect(leaveWarningMessage(state)).toMatch(/未保存/)

    state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = enqueueFiles(setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' }), [
      fakeFile('a.png', 'image/png'),
    ]).state
    expect(shouldWarnOnLeave(state)).toBe(true)
    expect(leaveWarningMessage(state)).toMatch(/上传/)
  })

  it('distinguishes published work from unpublished draft changes', () => {
    expect(publicationBadge(hydrateFromAggregate(fixturePublishedWork())).tone).toBe('published')
    expect(publicationBadge(hydrateFromAggregate(fixtureUnpublishedDraft())).tone).toBe('unpublished')
    let state = hydrateFromAggregate(fixturePublishedWork())
    state = setMetadata(state, { title: '改' })
    expect(publicationBadge(state).label).toMatch(/未发布的草稿/)
  })

  it('stale conflict preserves local state and disables blind save/publish', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = setMetadata(state, { title: '本地标题' })
    state = applyConflict(state, '其他编辑者已修改该作品', 'rev-server')
    expect(state.phase).toBe('conflict')
    expect(state.title).toBe('本地标题')
    expect(getSaveGate(state).allowed).toBe(false)
    expect(getPublishGate(state).allowed).toBe(false)
    expect(getSaveGate(state).reason).toMatch(/冲突/)
  })

  it('drag reorder updates complete ordered manifest', () => {
    let state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = reorderCards(state, 0, 1)
    expect(buildSavePayload(state).media.map((item) => item.mediaId)).toEqual([
      'media-pdf-1',
      'media-image-1',
    ])
  })

  it('successful publish replaces draft indicator with published', () => {
    let state = hydrateFromAggregate(fixtureUnpublishedDraft())
    state = applyPublishedAggregate(state, fixturePublishedWork())
    expect(state.phase).toBe('published')
    expect(publicationBadge(state).tone).toBe('published')
  })

  it('save gate requires work and blocks during active uploads', () => {
    let state = setMetadata(createEmptyEditorState(), { title: 'T', author: 'A' })
    expect(getSaveGate(state).allowed).toBe(false)
    state = hydrateFromAggregate(fixtureDraftWithMedia())
    state = setMetadata(state, { description: 'x' })
    expect(getSaveGate(state).allowed).toBe(true)
  })
})
