/**
 * Deterministic request/response/error fixtures for the Work Authoring API.
 * Shared by frontend (#60) tests and backend (#59) contract alignment.
 */

import type {
  AuthorizeUploadResponse,
  CreateWorkRequest,
  FinalizeUploadResponse,
  MediaManifestItem,
  SaveDraftRequest,
  WorkAggregate,
} from './contract'

export const FIXTURE_REVISION_V1 = 'rev-fixture-001'
export const FIXTURE_REVISION_V2 = 'rev-fixture-002'
export const FIXTURE_REVISION_V3 = 'rev-fixture-003'
export const FIXTURE_REVISION_PUBLISHED = 'rev-fixture-published-001'
export const FIXTURE_STALE_REVISION = 'rev-fixture-stale'

export const fixtureImageMedia = (overrides: Partial<MediaManifestItem> = {}): MediaManifestItem => ({
  mediaId: 'media-image-1',
  filename: 'cover.png',
  extension: 'png',
  mimeType: 'image/png',
  filesize: 12_345,
  alt: '封面',
  caption: '封面图',
  previewUrl: '/api/media/file/media-image-1',
  contentFingerprint: 'fp-cover-png',
  isImage: true,
  isPdf: false,
  ...overrides,
})

export const fixturePdfMedia = (overrides: Partial<MediaManifestItem> = {}): MediaManifestItem => ({
  mediaId: 'media-pdf-1',
  filename: 'notes.pdf',
  extension: 'pdf',
  mimeType: 'application/pdf',
  filesize: 98_765,
  caption: '正文 PDF',
  previewUrl: '/api/media/file/media-pdf-1',
  contentFingerprint: 'fp-notes-pdf',
  isImage: false,
  isPdf: true,
  ...overrides,
})

export const fixtureDraftWork = (overrides: Partial<WorkAggregate> = {}): WorkAggregate => ({
  workId: 'work-1',
  archiveId: 'W1',
  revision: FIXTURE_REVISION_V1,
  publicationStatus: 'draft',
  title: '示例作品',
  author: 'Alice',
  description: '可选描述',
  media: [],
  ...overrides,
})

export const fixtureDraftWithMedia = (): WorkAggregate =>
  fixtureDraftWork({
    revision: FIXTURE_REVISION_V2,
    media: [fixtureImageMedia(), fixturePdfMedia()],
  })

export const fixturePublishedWork = (): WorkAggregate => {
  const media = [fixtureImageMedia(), fixturePdfMedia()]
  return fixtureDraftWork({
    revision: FIXTURE_REVISION_PUBLISHED,
    publicationStatus: 'published',
    media,
    published: {
      revision: FIXTURE_REVISION_PUBLISHED,
      title: '示例作品',
      author: 'Alice',
      description: '可选描述',
      media,
      publishedAt: '2026-08-01T12:00:00.000Z',
    },
  })
}

export const fixtureUnpublishedDraft = (): WorkAggregate => {
  const publishedMedia = [fixtureImageMedia()]
  return fixtureDraftWork({
    revision: FIXTURE_REVISION_V3,
    publicationStatus: 'unpublished_draft',
    title: '示例作品（修订）',
    media: [fixtureImageMedia({ filename: 'cover-v2.png', contentFingerprint: 'fp-cover-v2' }), fixturePdfMedia()],
    published: {
      revision: FIXTURE_REVISION_PUBLISHED,
      title: '示例作品',
      author: 'Alice',
      description: '可选描述',
      media: publishedMedia,
      publishedAt: '2026-08-01T12:00:00.000Z',
    },
  })
}

export const fixtureCreateRequest = (): CreateWorkRequest => ({
  title: '示例作品',
  author: 'Alice',
  description: '可选描述',
})

export const fixtureSaveDraftRequest = (): SaveDraftRequest => ({
  revision: FIXTURE_REVISION_V2,
  title: '示例作品',
  author: 'Alice',
  description: '可选描述',
  media: [
    { mediaId: 'media-image-1', filename: 'cover.png', alt: '封面', caption: '封面图' },
    { mediaId: 'media-pdf-1', filename: 'notes.pdf', caption: '正文 PDF' },
  ],
})

export const fixtureAuthorizeUploadResponse = (
  overrides: Partial<AuthorizeUploadResponse['upload']> = {},
): AuthorizeUploadResponse => ({
  revision: FIXTURE_REVISION_V1,
  upload: {
    uploadId: 'upload-1',
    putUrl: 'https://r2.example.test/presigned/media-1',
    headers: { 'Content-Type': 'image/png' },
    expiresAt: '2099-01-01T00:00:00.000Z',
    storageKey: 'media/00000000-0000-4000-8000-000000000001',
    context: {
      version: 1,
      collection: 'media',
      storageKey: 'media/00000000-0000-4000-8000-000000000001',
      filename: 'cover.png',
      filesize: 12_345,
      mimeType: 'image/png',
      expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
      signature: 'fixture-signature',
    },
    ...overrides,
  },
})

export const fixtureFinalizeUploadResponse = (): FinalizeUploadResponse => ({
  ...fixtureDraftWork({
    revision: FIXTURE_REVISION_V2,
    media: [fixtureImageMedia()],
  }),
  mediaItem: fixtureImageMedia(),
})

export const fixtureFinalizeWithDuplicateWarning = (): FinalizeUploadResponse => ({
  ...fixtureDraftWork({
    revision: FIXTURE_REVISION_V2,
    media: [fixtureImageMedia(), fixtureImageMedia({ mediaId: 'media-image-2', filename: 'cover-copy.png' })],
  }),
  mediaItem: fixtureImageMedia({ mediaId: 'media-image-2', filename: 'cover-copy.png' }),
  probableDuplicate: {
    existingMediaId: 'media-image-1',
    filename: 'cover.png',
  },
})

export const fixtureValidationError = {
  error: {
    code: 'validation' as const,
    message: '标题和作者不能为空。',
    field: 'title',
  },
}

export const fixtureUnsupportedFileError = {
  error: {
    code: 'unsupported_file' as const,
    message: '仅支持图片或 PDF 媒体文件。',
  },
}

export const fixtureOversizeFileError = {
  error: {
    code: 'oversize_file' as const,
    message: '媒体文件不能超过 100 MB。',
  },
}

export const fixtureStaleRevisionError = (aggregate: WorkAggregate = fixtureDraftWithMedia()) => ({
  error: {
    code: 'stale_revision' as const,
    message: '其他编辑者已修改该作品，请刷新后重新应用更改。',
    currentRevision: aggregate.revision,
    aggregate,
  },
})

export const fixturePublicationFailedError = {
  error: {
    code: 'publication_failed' as const,
    message: '发布失败，草稿已保留，可重试。',
  },
}

export const fixtureUploadFinalizationFailedError = {
  error: {
    code: 'upload_finalization_failed' as const,
    message: '上传确认失败，请重试该媒体文件。',
    uploadId: 'upload-1',
  },
}

export const fixtureUploadAuthExpiredError = {
  error: {
    code: 'upload_authorization_expired' as const,
    message: '上传授权已过期，请重试该媒体文件。',
    uploadId: 'upload-1',
  },
}
