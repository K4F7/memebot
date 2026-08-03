import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultRecoveryDecisions, healthPresentation, presentConsoleError, recoveryKey, toRestoreSelections, unresolvedConflicts } from '../client/storage/state'

describe('Archive storage and recovery Console state', () => {
  it('presents every health state with text instead of color alone', () => {
    expect(healthPresentation('ready')).toMatchObject({ label: '就绪', type: 'success' })
    expect(healthPresentation('degraded')).toMatchObject({ label: '降级', type: 'warning' })
    expect(healthPresentation('unavailable')).toMatchObject({ label: '不可用', type: 'danger' })
  })

  it('presents remote failures without exposing transport stacks or local paths', () => {
    expect(presentConsoleError('Error: R2 manifest listing is unavailable\n    at ArchiveService.previewRestore (D:\\private\\app\\index.js:10:2)'))
      .toBe('R2 manifest listing is unavailable')
    expect(presentConsoleError(new Error('storage health check failed'))).toBe('storage health check failed')
    expect(presentConsoleError('EACCES: open /var/lib/memebot/archive.db')).toBe('EACCES: open [路径已隐藏]')
  })

  it('requires explicit conflict choices and builds auditable restore selections', () => {
    const entries = [
      { recordKind: 'paper' as const, recordId: 'P1', status: 'new' as const, missingAttachment: true },
      { recordKind: 'work' as const, recordId: 'W2', status: 'changed' as const, missingAttachment: false },
      { recordKind: 'paper' as const, recordId: 'P3', status: 'conflicting' as const, missingAttachment: false },
    ]
    const decisions = defaultRecoveryDecisions(entries)
    expect(decisions).toEqual({ 'paper:P1': 'r2', 'work:W2': 'local' })
    expect(unresolvedConflicts(entries, decisions)).toEqual(['paper:P3'])
    decisions[recoveryKey(entries[2])] = 'r2'
    expect(toRestoreSelections(entries, decisions)).toEqual([
      { recordKind: 'paper', recordId: 'P1', decision: 'r2' },
      { recordKind: 'work', recordId: 'W2', decision: 'local' },
      { recordKind: 'paper', recordId: 'P3', decision: 'r2' },
    ])
  })
})

describe('Archive storage and recovery Console component', () => {
  it('implements actionable, responsive, context-preserving health, backup, recovery, and history states', async () => {
    const source = await readFile(join(__dirname, '../client/regions/StorageRecoveryRegion.vue'), 'utf8')
    for (const event of [
      'memebot/archive/status',
      'memebot/archive/recheck',
      'memebot/archive/backup/status',
      'memebot/archive/backup/retry',
      'memebot/archive/restore/preview',
      'memebot/archive/restore/apply',
      'memebot/archive/restore/history',
    ]) expect(source).toContain(`'${event}'`)
    expect(source).toContain('<el-table')
    expect(source).toContain('class="storage-card"')
    expect(source).toContain('<el-radio-group')
    expect(source).toContain('messageBox.confirm')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('Promise.allSettled')
    expect(source).toContain('v-loading="')
    expect(source).toMatch(/@media \(max-width: 767px\)/)
    expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/)
    expect(source).not.toMatch(/\bstyle\s*=/)
  })
})
