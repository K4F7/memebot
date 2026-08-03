import type { HealthState, RestoreDecision, RestoreDecisions, RestorePreviewEntry, RestoreSelection } from './types'

type RecoveryEntry = Pick<RestorePreviewEntry, 'recordKind' | 'recordId' | 'status' | 'missingAttachment'>

export function presentConsoleError(cause: unknown) {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const message = raw
    .replace(/^Error:\s*/i, '')
    .split(/\r?\n\s*at\s+|\s+at\s+(?=[\w$.<]+\s*\()/, 1)[0]
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"\r\n]+\1/g, '$1[路径已隐藏]$1')
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, '[路径已隐藏]')
    .replace(/(^|[\s(])\/(?!\/)[^\s,;)'"\r\n]+/g, '$1[路径已隐藏]')
    .trim()
  return message || '未知错误'
}

export function healthPresentation(state: HealthState) {
  return {
    ready: { label: '就绪', type: 'success' as const, description: '本地存储与已启用的远端存储检查通过。' },
    degraded: { label: '降级', type: 'warning' as const, description: '本地存储可用，但远端存储需要处理。' },
    unavailable: { label: '不可用', type: 'danger' as const, description: '本地存储不可用，Archive 写入或恢复可能失败。' },
  }[state]
}

export function recoveryKey(entry: Pick<RecoveryEntry, 'recordKind' | 'recordId'>) {
  return `${entry.recordKind}:${entry.recordId}`
}

export function defaultRecoveryDecisions(entries: RecoveryEntry[]): RestoreDecisions {
  return Object.fromEntries(entries.flatMap((entry) => {
    if (entry.status === 'conflicting') return []
    const decision: RestoreDecision = entry.status === 'new' || entry.missingAttachment ? 'r2' : 'local'
    return [[recoveryKey(entry), decision]]
  }))
}

export function unresolvedConflicts(entries: RecoveryEntry[], decisions: RestoreDecisions) {
  return entries.filter(entry => entry.status === 'conflicting' && !decisions[recoveryKey(entry)]).map(recoveryKey)
}

export function toRestoreSelections(entries: RecoveryEntry[], decisions: RestoreDecisions): RestoreSelection[] {
  return entries.flatMap((entry) => {
    const decision = decisions[recoveryKey(entry)]
    return decision ? [{ recordKind: entry.recordKind, recordId: entry.recordId, decision }] : []
  })
}
