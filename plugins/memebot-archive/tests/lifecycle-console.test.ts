import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Archive lifecycle Console', () => {
  it('renders every lifecycle surface and keeps destructive actions themed and accessible', async () => {
    const root = join(__dirname, '../client')
    const sources = await Promise.all([
      'regions/OpsRegion.vue',
      'lifecycle/LifecycleActionDialog.vue',
    ].map(path => readFile(join(root, path), 'utf8')))
    const source = sources.join('\n')

    for (const text of ['已移除的 Archive Items', '已退役附件', '远端删除工作', '生命周期历史']) {
      expect(source).toContain(text)
    }
    expect(source).toContain('<el-table')
    expect(source).toContain('class="lifecycle-card"')
    expect(source).toContain('aria-label="生命周期历史卡片"')
    expect(source).toContain('<el-empty v-if="!removed.length"')
    expect(source).toContain('<el-empty v-if="!retired.length"')
    expect(source).toContain('<el-dialog')
    expect(source).toContain('typedIdentifier')
    expect(source).toContain('.focus()')
    expect(source).toContain('message.success')
    expect(source).not.toMatch(/\bwindow\.(?:alert|confirm|prompt)\s*\(/)
    expect(source).not.toMatch(/\bstyle\s*=/)
  })

  it('preserves the complete lifecycle RPC surface', async () => {
    const source = await readFile(join(__dirname, '../src/index.ts'), 'utf8')
    for (const event of [
      'memebot/archive/removed',
      'memebot/archive/record/remove',
      'memebot/archive/record/restore',
      'memebot/archive/record/purge',
      'memebot/archive/record/anonymize',
      'memebot/archive/attachments/retired',
      'memebot/archive/attachment/restore',
      'memebot/archive/lifecycle/history',
      'memebot/archive/cleanup/status',
      'memebot/archive/cleanup/retry',
    ]) expect(source).toContain(`'${event}'`)
  })
})
