/**
 * Shared Work Authoring API contract for Issues #59 (backend) and #60 (frontend).
 *
 * Base path: `/api/work-authoring/v1`
 * Authentication: Payload Admin session cookie (credentials: 'include').
 * Every aggregate mutation supplies the last observed opaque `revision` token.
 */

export const WORK_AUTHORING_API_PREFIX = '/api/work-authoring/v1'

export type PublicationStatus = 'draft' | 'published' | 'unpublished_draft'

export type AuthoringErrorCode =
  | 'validation'
  | 'unsupported_file'
  | 'oversize_file'
  | 'upload_authorization_expired'
  | 'r2_transfer_failed'
  | 'upload_finalization_failed'
  | 'stale_revision'
  | 'publication_failed'
  | 'not_found'
  | 'unauthorized'
  | 'conflict'
  | 'unknown'

export interface MediaManifestItem {
  mediaId: string
  /** Full display filename including extension. */
  filename: string
  /** Fixed extension without the leading dot (e.g. "png", "pdf"). */
  extension: string
  mimeType: string
  filesize: number
  alt?: string
  caption?: string
  /** Authenticated Admin preview URL (image thumbnail or PDF open target). */
  previewUrl?: string
  /** Stable content fingerprint for advisory probable-duplicate warnings. */
  contentFingerprint?: string
  isImage: boolean
  isPdf: boolean
}

export interface PublishedSummary {
  revision: string
  title: string
  author: string
  description?: string
  media: MediaManifestItem[]
  publishedAt: string
}

export interface WorkAggregate {
  workId: string
  archiveId: string
  revision: string
  publicationStatus: PublicationStatus
  title: string
  author: string
  description?: string
  media: MediaManifestItem[]
  published?: PublishedSummary
}

export interface ManifestSaveEntry {
  mediaId: string
  filename: string
  alt?: string
  caption?: string
}

export interface CreateWorkRequest {
  title: string
  author: string
  description?: string
}

export interface SaveDraftRequest {
  revision: string
  title: string
  author: string
  description?: string
  media: ManifestSaveEntry[]
}

export interface PublishRequest {
  revision: string
}

export interface AuthorizeUploadRequest {
  revision: string
  filename: string
  filesize: number
  mimeType: string
  /** Original browser selection index; used only for client ordering, not storage. */
  selectionIndex?: number
  /** When set, finalization replaces this Media Item in the draft manifest. */
  replaceMediaId?: string
}

export interface AuthorizeUploadResponse {
  revision: string
  upload: {
    uploadId: string
    putUrl: string
    headers?: Record<string, string>
    expiresAt: string
    storageKey: string
    /** Opaque signed context returned unchanged to finalize. */
    context: unknown
  }
}

export interface FinalizeUploadRequest {
  revision: string
  uploadId: string
  idempotencyKey: string
  context: unknown
  selectionIndex?: number
  replaceMediaId?: string
  /** Optional client-side content fingerprint for advisory duplicate detection. */
  contentFingerprint?: string
}

export interface FinalizeUploadResponse extends WorkAggregate {
  mediaItem: MediaManifestItem
  probableDuplicate?: {
    existingMediaId: string
    filename: string
  }
}

export interface AuthoringErrorBody {
  error: {
    code: AuthoringErrorCode
    message: string
    field?: string
    mediaId?: string
    uploadId?: string
    currentRevision?: string
    aggregate?: WorkAggregate
  }
}

export class AuthoringApiError extends Error {
  readonly code: AuthoringErrorCode
  readonly status: number
  readonly field?: string
  readonly mediaId?: string
  readonly uploadId?: string
  readonly currentRevision?: string
  readonly aggregate?: WorkAggregate

  constructor(status: number, body: AuthoringErrorBody['error']) {
    super(body.message)
    this.name = 'AuthoringApiError'
    this.status = status
    this.code = body.code
    this.field = body.field
    this.mediaId = body.mediaId
    this.uploadId = body.uploadId
    this.currentRevision = body.currentRevision
    this.aggregate = body.aggregate
  }
}

export function isAuthoringApiError(value: unknown): value is AuthoringApiError {
  return value instanceof AuthoringApiError
}

export function splitFilename(filename: string): { basename: string; extension: string } {
  const trimmed = filename.trim()
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { basename: trimmed, extension: '' }
  }
  return {
    basename: trimmed.slice(0, lastDot),
    extension: trimmed.slice(lastDot + 1).toLowerCase(),
  }
}

export function joinFilename(basename: string, extension: string): string {
  const base = basename.trim() || 'untitled'
  const ext = extension.trim().replace(/^\./, '').toLowerCase()
  return ext ? `${base}.${ext}` : base
}
