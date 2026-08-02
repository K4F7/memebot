import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isKoishiConsoleResponse, localAppUrl, validateLocalApp, visibleStartupFailures } = require('../scripts/smoke-local-app.cjs') as {
  isKoishiConsoleResponse(statusCode: number | undefined, body: string): boolean
  localAppUrl(appRoot: string): string
  validateLocalApp(appRoot: string): string[]
  visibleStartupFailures(logs: string): string[]
}

const dependencies = {
  'koishi-plugin-memebot-access': 'file:../plugins/memebot-access',
  'koishi-plugin-memebot-intake': 'file:../plugins/memebot-intake',
  'koishi-plugin-memebot-faq': 'file:../plugins/memebot-faq',
  'koishi-plugin-memebot-activity': 'file:../plugins/memebot-activity',
  'koishi-plugin-memebot-archive': 'file:../plugins/memebot-archive',
}

const resolutions = {
  'koishi-plugin-memebot-access': 'file:../plugins/memebot-access',
}

const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true })
})

function fixture(manifest: object, config?: string) {
  const root = mkdtempSync(join(tmpdir(), 'memebot-local-app-'))
  fixtureRoots.push(root)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  if (config !== undefined) writeFileSync(join(root, 'koishi.yml'), config)
  return root
}

const completeConfig = `plugins:
  group:server:
    server: {}
  group:console:
    console: {}
    sandbox: {}
  group:storage:
    database-sqlite: {}
  group:memebot:
    memebot-access: {}
    memebot-intake: {}
    memebot-faq: {}
    memebot-activity: {}
    memebot-archive: {}
`

describe('local Koishi app smoke preflight', () => {
  it('keeps the entire local app outside version control', () => {
    const ignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8')
    expect(ignore.split(/\r?\n/)).toContain('/app/')
  })

  it('accepts the five local packages and required services in one config', () => {
    const root = fixture({ scripts: { start: 'koishi start' }, dependencies, resolutions }, completeConfig)
    expect(validateLocalApp(root)).toEqual([])
  })

  it('reports unavailable or incomplete environments as visible failures', () => {
    const missing = fixture({ scripts: {}, dependencies: {} })
    const errors = validateLocalApp(missing)

    expect(errors).toContain('package.json must define a start script')
    expect(errors).toContain('koishi.yml is missing')
    expect(errors).toContain('koishi-plugin-memebot-access must use file:../plugins/memebot-access')
    expect(errors).toContain('koishi-plugin-memebot-access resolution must use file:../plugins/memebot-access')
  })

  it('rejects disabled services and plugin registrations', () => {
    const root = fixture({ scripts: { start: 'koishi start' }, dependencies, resolutions }, completeConfig
      .replace('    sandbox: {}', '    ~sandbox: {}')
      .replace('    memebot-archive: {}', '    ~memebot-archive: {}'))

    expect(validateLocalApp(root)).toEqual(expect.arrayContaining([
      'koishi.yml must enable sandbox',
      'koishi.yml must enable memebot-archive',
    ]))

    const falseValues = fixture({ scripts: { start: 'koishi start' }, dependencies, resolutions }, completeConfig
      .replace('    sandbox: {}', '    sandbox: false')
      .replace('    memebot-archive: {}', '    memebot-archive: null'))
    expect(validateLocalApp(falseValues)).toEqual(expect.arrayContaining([
      'koishi.yml must enable sandbox',
      'koishi.yml must enable memebot-archive',
    ]))
  })

  it('recognizes the spawned Koishi Console rather than any HTTP listener', () => {
    expect(isKoishiConsoleResponse(200, '<script>KOISHI_CONFIG = {}</script>')).toBe(true)
    expect(isKoishiConsoleResponse(200, '<h1>unrelated service</h1>')).toBe(false)
    expect(isKoishiConsoleResponse(404, '<script>KOISHI_CONFIG = {}</script>')).toBe(false)
  })

  it('uses the isolated app server address for readiness checks', () => {
    const root = fixture({ scripts: { start: 'koishi start' }, dependencies, resolutions }, completeConfig
      .replace('    server: {}', '    server:\n      host: 127.0.0.1\n      port: 5150'))
    expect(localAppUrl(root)).toBe('http://127.0.0.1:5150/')
  })

  it('treats Koishi error records and failed plugin resolution as failures', () => {
    expect(visibleStartupFailures([
      '2026-08-02 [I] server listening',
      '2026-08-02 [E] app ValidationError: invalid seed',
      '2026-08-02 [W] config failed to resolve plugin',
      '2026-08-02 [I] app duplicate plugin detected',
    ].join('\n'))).toEqual([
      '2026-08-02 [E] app ValidationError: invalid seed',
      '2026-08-02 [W] config failed to resolve plugin',
      '2026-08-02 [I] app duplicate plugin detected',
    ])
  })
})
