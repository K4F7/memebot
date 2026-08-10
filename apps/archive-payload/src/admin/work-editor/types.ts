import type {
  MediaManifestItem,
  PublicationStatus,
  WorkAggregate,
} from '../../authoring/contract'

export type AggregatePhase =
  | 'idle'
  | 'loading'
  | 'creating'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'publishing'
  | 'published'
  | 'conflict'
  | 'failure'

export type UploadPhase =
  | 'queued'
  | 'authorizing'
  | 'uploading'
  | 'finalizing'
  | 'uploaded'
  | 'failed'
  | 'retrying'
  | 'cancelled'

export type CardKind = 'upload' | 'media'

export interface UploadCard {
  kind: 'upload'
  clientId: string
  selectionIndex: number
  file: File
  filename: string
  extension: string
  mimeType: string
  filesize: number
  phase: UploadPhase
  progress: number
  error?: string
  errorCode?: string
  uploadId?: string
  idempotencyKey: string
  replaceMediaId?: string
  localPreviewUrl?: string
}

export interface MediaCard {
  kind: 'media'
  clientId: string
  media: MediaManifestItem
  basename: string
  extension: string
  alt: string
  caption: string
  pendingRemoval: boolean
  /** Nested replacement upload, if any. Old preview remains until success. */
  replacement?: UploadCard
  probableDuplicate?: {
    existingMediaId: string
    filename: string
    dismissed: boolean
  }
  dirty: boolean
}

export type EditorCard = UploadCard | MediaCard

export interface EditorSnapshot {
  phase: AggregatePhase
  workId?: string
  archiveId?: string
  revision?: string
  publicationStatus: PublicationStatus
  title: string
  author: string
  description: string
  cards: EditorCard[]
  published?: WorkAggregate['published']
  pageError?: string
  conflictMessage?: string
  actionHint?: string
  /** True when durable server draft diverges from local editable fields. */
  dirty: boolean
  /** Baseline revision loaded from server used for conflict recovery. */
  baselineRevision?: string
  loaded: boolean
}

export interface PublishGate {
  allowed: boolean
  reason?: string
}

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

export const ALLOWED_MIME_PREFIXES = ['image/'] as const
export const ALLOWED_MIME_EXACT = new Set(['application/pdf'])
export const DISALLOWED_IMAGE_SUBTYPES = new Set(['svg+xml', 'svg'])
