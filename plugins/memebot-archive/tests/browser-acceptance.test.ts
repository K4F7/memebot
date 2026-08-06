import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const runner = join(root, 'e2e/run-browser.cjs')

describe('Archive browser acceptance contract', () => {
  it('reports unavailable browser environments as not executed', () => {
    const env = { ...process.env }
    delete env.MEMEBOT_ARCHIVE_WEBUI_URL
    const optional = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: 'utf8' })
    expect(optional.status).toBe(0)
    expect(optional.stdout).toContain('Archive browser acceptance: NOT EXECUTED')

    const required = spawnSync(process.execPath, [runner, '--required'], { cwd: root, env, encoding: 'utf8' })
    expect(required.status).toBe(1)
    expect(required.stdout).toContain('REQUIRED BUT NOT EXECUTED')
  })

  it('keeps every declared real-browser capability explicit in the suite', async () => {
    const source = await readFile(join(root, 'e2e/archive-console.pw.ts'), 'utf8')
    for (const capability of [
      '备份与恢复',
      '生命周期审计',
      '报纸期数',
      '收录作品',
      '创建 Newspaper Issue',
      '创建 Work',
      '安全派生预览',
      '添加刊载关联',
      '移除 Archive Item',
      '确认恢复 Archive Item',
      '立即重试',
      '从 R2 生成预览',
      'Auth/Login absent mode',
      'Auth/Login installed mode',
      "['light', 'dark']",
      'expectNoHorizontalScroll',
    ]) expect(source).toContain(capability)
    expect(source).toContain('NOT EXECUTED:')
    const runnerSource = await readFile(runner, 'utf8')
    expect(runnerSource).toContain('R2 Archive Backup retry: NOT EXECUTED')
    expect(runnerSource).toContain('R2 recovery preview: NOT EXECUTED')
    expect(runnerSource).toContain('Auth/Login installed mode: NOT EXECUTED')
  })
})
