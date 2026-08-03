import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LatestIssueRequest, normalizeIssuesRoute, paginateIssues, toIssuesQuery } from '../client/issues/state'

describe('Archive Newspaper Issues Console state', () => {
  it('normalizes URL-backed search, selection, page, and page size', () => {
    expect(normalizeIssuesRoute({
      issueSearch: ['  august  '], issue: 'P12', issuePage: '3', issuePageSize: '50',
    })).toEqual({ search: 'august', selected: 'P12', page: 3, pageSize: 50 })
    expect(normalizeIssuesRoute({ issue: 'W1', issuePage: '0', issuePageSize: '25' }))
      .toEqual({ search: '', selected: '', page: 1, pageSize: 20 })
  })

  it('writes navigable Newspaper Issues state and paginates predictably', () => {
    expect(toIssuesQuery({ search: 'zine', selected: 'P2', page: 2, pageSize: 100 })).toEqual({
      tab: 'issues', issueSearch: 'zine', issue: 'P2', issuePage: '2', issuePageSize: '100',
    })
    expect(paginateIssues(['P1', 'P2', 'P3'], 2, 2)).toEqual(['P3'])
  })

  it('rejects stale list and preview responses', () => {
    const requests = new LatestIssueRequest()
    const first = requests.start()
    const second = requests.start()
    expect(requests.isCurrent(first)).toBe(false)
    expect(requests.isCurrent(second)).toBe(true)
  })
})

describe('Archive Newspaper Issues Console components', () => {
  it('implements responsive management, reusable forms, focus restoration, and on-demand PDF preview', async () => {
    const root = join(__dirname, '../client')
    const files = await Promise.all([
      'regions/NewspaperIssuesRegion.vue',
      'issues/IssueFormDialog.vue',
      'issues/IssuePreviewDialog.vue',
    ].map(path => readFile(join(root, path), 'utf8')))
    const [regionSource, , previewSource] = files
    const source = files.join('\n')

    expect(source).toContain('<el-table')
    expect(source).toContain('class="issue-card"')
    expect(source).toContain(':page-sizes="[20, 50, 100]"')
    expect(source).toContain('messageBox.confirm')
    expect(source).toContain('formError')
    expect(source).not.toMatch(/<el-form[^>]*:disabled="submitting"/)
    expect(source).toContain('<el-button @click="requestClose">取消</el-button>')
    expect(source).not.toContain('<el-button :disabled="submitting" @click="requestClose">')
    expect(source).toContain('if (submitting.value || !dirty.value) return true')
    expect(source).toContain('<el-button type="primary" :loading="submitting" @click="save">')
    expect(source).toContain('@closed')
    expect(source).toContain('.focus()')
    expect(source).toContain('fullscreen')
    expect(source).toContain('@open="loadPreview"')
    expect(source).not.toMatch(/<iframe[^>]*\bsandbox=/s)
    expect(source).toContain('URL.createObjectURL')
    expect(source).toContain('URL.revokeObjectURL')
    expect(regionSource).toContain('URL.createObjectURL')
    expect(regionSource).toContain('URL.revokeObjectURL')
    expect(previewSource).toMatch(/watch\(\(\) => props\.paper\?\.id,[\s\S]*props\.modelValue[\s\S]*loadPreview/)
    expect(source).toMatch(/\.issues-pagination\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/)
    expect(source).not.toMatch(/\bstyle\s*=/)
  })

  it('preserves every Paper RPC event name', async () => {
    const source = await readFile(join(__dirname, '../src/index.ts'), 'utf8')
    for (const event of [
      'memebot/archive/papers',
      'memebot/archive/paper/details',
      'memebot/archive/paper/create',
      'memebot/archive/paper/edit',
      'memebot/archive/paper/upload',
      'memebot/archive/paper/preview',
      'memebot/archive/paper/download',
    ]) expect(source).toContain(`'${event}'`)
  })
})
