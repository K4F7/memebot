export type ArchiveRecordKind = 'paper' | 'work'
export type LifecycleAction = 'remove' | 'restore' | 'purge' | 'anonymize' | 'restoreAttachment'

export interface LifecycleTarget {
  id: string
  label: string
}

export interface RemovedArchiveItem {
  kind: ArchiveRecordKind
  id: string
  title: string
  author?: string
  lifecycle: 'removed' | 'purged'
  removedAt?: string
  expiresAt?: string
  purgedAt?: string
}

export interface RetiredAttachment {
  id: string
  recordKind: ArchiveRecordKind
  recordId: string
  attachment: {
    relativePath: string
    contentType: string
    size: number
    checksum: string
  }
  lifecycle: 'retired'
  removedAt: string
  expiresAt: string
}

export interface LifecycleAuditEntry {
  id: string
  actor: string
  recordKind: ArchiveRecordKind
  recordId: string
  action: 'remove' | 'restore' | 'purge' | 'anonymize'
  details: string
  createdAt: string
}

export interface CleanupJob {
  id: string
  recordKind: ArchiveRecordKind
  recordId: string
  objectKeys: string[]
  state: 'pending' | 'failed' | 'complete'
  attempts: number
  nextAttemptAt: string
  error: string
}

export interface CleanupStatus {
  counts: { pending: number; failed: number; complete: number }
  jobs: CleanupJob[]
}
