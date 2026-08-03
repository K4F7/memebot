import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LatestRequest, normalizeWorksRoute, paginateWorks, toWorksQuery } from '../client/works/state'

describe('Archive Works Console state', () => {
  it('normalizes URL-backed search, selection, page, and page size', () => {
    expect(normalizeWorksRoute({
      workSearch: ['  zine  '],
      work: 'W12',
      workPage: '3',
      workPageSize: '50',
    })).toEqual({ search: 'zine', selected: 'W12', page: 3, pageSize: 50 })

    expect(normalizeWorksRoute({ work: 'P1', workPage: '-2', workPageSize: '25' }))
      .toEqual({ search: '', selected: '', page: 1, pageSize: 20 })
  })

  it('writes only navigable Works state to the URL', () => {
    expect(toWorksQuery({ search: 'hello', selected: 'W2', page: 2, pageSize: 100 })).toEqual({
      tab: 'works',
      workSearch: 'hello',
      work: 'W2',
      workPage: '2',
      workPageSize: '100',
    })
    expect(toWorksQuery({ search: '', selected: '', page: 1, pageSize: 20 })).toEqual({
      tab: 'works',
      workPage: '1',
      workPageSize: '20',
    })
  })

  it('paginates predictably and rejects stale request results', () => {
    expect(paginateWorks(['W1', 'W2', 'W3'], 2, 2)).toEqual(['W3'])
    const requests = new LatestRequest()
    const first = requests.start()
    const second = requests.start()
    expect(requests.isCurrent(first)).toBe(false)
    expect(requests.isCurrent(second)).toBe(true)
  })
})

describe('Archive Works Console components', () => {
  it('keeps the complete Works path in themed Vue SFCs', async () => {
    const root = join(__dirname, '../client')
    const files = await Promise.all([
      'regions/WorksRegion.vue',
      'works/WorkFormDialog.vue',
      'works/AppearanceFormDialog.vue',
      'works/WorkPreviewDialog.vue',
    ].map(path => readFile(join(root, path), 'utf8')))
    const source = files.join('\n')

    expect(source).toContain('<el-table')
    expect(source).toContain('class="work-card"')
    expect(source).toContain(':page-sizes="[20, 50, 100]"')
    expect(source).toContain('<el-dialog')
    expect(source).toContain('fullscreen')
    expect(source).toContain('messageBox.confirm')
    expect(source).toContain("memebot/archive/appearance/save")
    expect(source).toContain("memebot/archive/appearance/remove")
    expect(source).toContain('aria-live="assertive"')
    expect(source).toContain(':loading="submitting"')
    expect(source).toContain('formError.value = cause instanceof Error')
    expect(source).toContain('const work = appearanceWork.value')
    expect(source).toContain('request !== appearanceRequest')
    expect(source).toContain('selection === workSelection')
    expect(source).toContain('sandbox="allow-downloads"')
    expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/)
    expect(source).not.toMatch(/\bstyle\s*=/)
  })

  it('preserves every existing Work RPC event name', async () => {
    const source = await readFile(join(__dirname, '../src/index.ts'), 'utf8')
    for (const event of [
      'memebot/archive/works',
      'memebot/archive/work/details',
      'memebot/archive/work/create',
      'memebot/archive/work/edit',
      'memebot/archive/work/upload',
      'memebot/archive/work/tree',
      'memebot/archive/work/preview',
      'memebot/archive/work/file',
      'memebot/archive/work/download',
    ]) expect(source).toContain(`'${event}'`)
  })
})
