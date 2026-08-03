export type HealthState = 'ready' | 'degraded' | 'unavailable'
export type CountSet = { pending: number; failed: number; complete: number }

export interface ArchiveStatus {
  state: HealthState
  lastCheck: string
  error?: string
  stores: {
    local: { ok: boolean; error?: string }
    r2: { enabled: boolean; ok?: boolean; error?: string }
  }
  queue: CountSet
}

export interface BackupJob {
  id: string
  recordKind: 'paper' | 'work'
  recordId: string
  state: 'pending' | 'failed' | 'complete'
  attempts: number
  nextAttemptAt: string
  error: string
  lastAttempt?: string
}

export interface BackupStatus {
  counts: CountSet
  jobs: BackupJob[]
}

export interface RestoreRecord {
  id: string
  title: string
  author?: string
  month?: string
  issueNumber?: string
  attachment?: { relativePath: string; checksum: string }
}

export interface RestorePreviewEntry {
  recordKind: 'paper' | 'work'
  recordId: string
  status: 'new' | 'unchanged' | 'changed' | 'conflicting'
  missingAttachment: boolean
  local?: RestoreRecord
  remote: RestoreRecord
}

export interface RestorePreview {
  counts: { new: number; changed: number; conflicting: number; missing: number }
  entries: RestorePreviewEntry[]
}

export type RestoreDecision = 'local' | 'r2'
export type RestoreDecisions = Record<string, RestoreDecision | undefined>

export interface RestoreSelection {
  recordKind: 'paper' | 'work'
  recordId: string
  decision: RestoreDecision
}

export interface RestoreResult {
  restored: number
  decisions: Array<{ key: string; decision: string; status: string }>
}

export interface RestoreAuditEntry {
  id: string
  actor: string
  action: 'preview' | 'restore'
  result: 'complete' | 'failed'
  details: string
  createdAt: string
}
