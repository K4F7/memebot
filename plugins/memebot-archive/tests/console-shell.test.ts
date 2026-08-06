import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { archiveTabs, normalizeArchiveTab, toArchiveTabQuery } from '../client/tab-state'

const clientRoot = join(__dirname, '../client')

async function clientSources(directory = clientRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? clientSources(join(directory, entry.name))
    : /\.(?:ts|vue)$/.test(entry.name) ? readFile(join(directory, entry.name), 'utf8') : ''))
  return nested.flat().filter(Boolean)
}

describe('Archive Console shell', () => {
  it('defines the three navigable shell tabs and normalizes URL state', () => {
    expect(archiveTabs.map(tab => [tab.id, tab.label])).toEqual([
      ['issues', '报纸期数'],
      ['works', '收录作品'],
      ['ops', '运维'],
    ])
    expect(normalizeArchiveTab('works')).toBe('works')
    expect(normalizeArchiveTab(['ops'])).toBe('ops')
    expect(normalizeArchiveTab('unknown')).toBe('issues')
    expect(toArchiveTabQuery('ops')).toEqual({ tab: 'ops' })
  })

  it('uses SFC regions without inline styles or browser-native dialogs', async () => {
    const sources = (await clientSources()).join('\n')
    expect(sources).toContain('<script setup lang="ts">')
    expect(sources).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/)
    expect(sources).not.toMatch(/(?:^|[^.\w])(?:alert|confirm|prompt)\s*\((?!\s*[A-Za-z_$][\w$]*\s*:)/m)
    expect(sources).not.toMatch(/\bstyle\s*=/)
  })

  it('uses history-producing navigation for browser back and refresh acceptance', async () => {
    const source = await readFile(join(clientRoot, 'pages/ArchivePage.vue'), 'utf8')
    expect(source).toContain('router.push')
    expect(source).not.toContain('router.replace')
  })
})
