import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  ACCESS_PACKAGE,
  ArtifactContractError,
  discoverPublishablePlugins,
  verifyExtractedArtifact,
  withArtifactStaging,
} = require('../scripts/check-plugin-artifacts.cjs') as {
  ACCESS_PACKAGE: string
  ArtifactContractError: new (pluginName: string, violation: string) => Error & { pluginName: string, violation: string }
  discoverPublishablePlugins(repositoryRoot: string): Array<{
    directory: string
    root: string
    manifest: {
      name: string
      dependencies?: Record<string, string>
      repository?: { type?: string, url?: string, directory?: string }
    }
  }>
  verifyExtractedArtifact(extractedRoot: string, options?: Record<string, unknown>): { name: string }
  withArtifactStaging<T>(fn: (stagingRoot: string) => T): T
}

const repositoryRoot = process.cwd()
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true })
})

function extractedFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'memebot-artifact-fixture-'))
  fixtureRoots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(root, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, contents)
  }
  return root
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'koishi-plugin-memebot-fixture',
    version: '1.0.0',
    main: 'lib/index.js',
    types: 'lib/index.d.ts',
    files: ['lib'],
    repository: {
      type: 'git',
      url: 'https://github.com/K4F7/memebot.git',
      directory: 'plugins/memebot-fixture',
    },
    ...overrides,
  }
}

function validPluginSource() {
  return [
    'exports.name = "memebot-fixture"',
    'exports.apply = function apply() {}',
    'exports.default = exports',
    '',
  ].join('\n')
}

function validArtifact(overrides: Record<string, unknown> = {}, extraFiles: Record<string, string> = {}) {
  return extractedFixture({
    'package.json': JSON.stringify(validManifest(overrides), null, 2),
    'lib/index.js': validPluginSource(),
    'lib/index.d.ts': 'export const apply: () => void\n',
    ...extraFiles,
  })
}

function expectContractFailure(run: () => unknown, pluginName: string, violation: RegExp | string) {
  try {
    run()
    throw new Error('expected artifact contract failure')
  } catch (cause) {
    expect(cause).toBeInstanceOf(ArtifactContractError)
    const error = cause as Error & { pluginName: string, violation: string }
    expect(error.pluginName).toBe(pluginName)
    expect(error.message).toContain(pluginName)
    expect(error.message).toMatch(/independent package artifact contract/)
    if (typeof violation === 'string') expect(error.violation).toContain(violation)
    else expect(error.violation).toMatch(violation)
    expect(error.message).not.toMatch(/\/tmp\/|memebot-artifact-fixture-|memebot-plugin-artifacts-/)
    expect(error.message).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|credentials?/i)
  }
}

describe('publishable plugin artifact metadata', () => {
  it('declares canonical K4F7/memebot repository metadata for every plugin', () => {
    const plugins = discoverPublishablePlugins(repositoryRoot)
    expect(plugins.map(plugin => plugin.manifest.name)).toEqual([
      'koishi-plugin-memebot-access',
      'koishi-plugin-memebot-activity',
      'koishi-plugin-memebot-archive',
      'koishi-plugin-memebot-faq',
      'koishi-plugin-memebot-intake',
    ])

    for (const plugin of plugins) {
      expect(plugin.manifest.repository).toEqual({
        type: 'git',
        url: 'https://github.com/K4F7/memebot.git',
        directory: plugin.directory,
      })
    }
  })

  it('requires protected business plugins to depend on Access', () => {
    const plugins = discoverPublishablePlugins(repositoryRoot)
    const protectedPlugins = plugins.filter(plugin => plugin.manifest.name !== ACCESS_PACKAGE && plugin.manifest.name !== 'koishi-plugin-memebot-archive')

    expect(protectedPlugins.map(plugin => plugin.manifest.name)).toEqual([
      'koishi-plugin-memebot-activity',
      'koishi-plugin-memebot-faq',
      'koishi-plugin-memebot-intake',
    ])
    for (const plugin of protectedPlugins) {
      expect(plugin.manifest.dependencies?.[ACCESS_PACKAGE]).toBe('workspace:^')
    }
  })
})

describe('extracted plugin artifact contract', () => {
  it('accepts a complete independently loadable plugin artifact', () => {
    const root = validArtifact({
      dependencies: { [ACCESS_PACKAGE]: '^0.1.0-alpha.2' },
    })

    expect(verifyExtractedArtifact(root, {
      pluginName: 'koishi-plugin-memebot-fixture',
      pluginDirectory: 'plugins/memebot-fixture',
      requiresAccess: true,
      accessVersion: '0.1.0-alpha.2',
    }).name).toBe('koishi-plugin-memebot-fixture')
  })

  it('rejects a missing declared JavaScript entry', () => {
    const root = extractedFixture({
      'package.json': JSON.stringify(validManifest(), null, 2),
      'lib/index.d.ts': 'export const apply: () => void\n',
    })

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
      }),
      'koishi-plugin-memebot-fixture',
      'missing its declared JavaScript entry',
    )
  })

  it('rejects an unresolved workspace dependency range', () => {
    const root = validArtifact({
      dependencies: { [ACCESS_PACKAGE]: 'workspace:^' },
    })

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
        requiresAccess: true,
        accessVersion: '0.1.0-alpha.2',
      }),
      'koishi-plugin-memebot-fixture',
      'workspace: dependency range',
    )
  })

  it('rejects a malformed packed manifest', () => {
    const root = extractedFixture({
      'package.json': '{ name: koishi-plugin-memebot-fixture, }',
      'lib/index.js': validPluginSource(),
      'lib/index.d.ts': 'export const apply: () => void\n',
    })

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
      }),
      'koishi-plugin-memebot-fixture',
      'packed manifest is malformed',
    )
  })

  it('rejects an unloadable packed CommonJS entry', () => {
    const root = validArtifact({}, {
      'lib/index.js': 'throw new Error("secret token NPM_TOKEN=abc and path /tmp/hidden")\n',
    })

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
      }),
      'koishi-plugin-memebot-fixture',
      'packed CommonJS entry cannot be loaded',
    )
  })

  it('rejects a packed entry that does not export apply', () => {
    const root = validArtifact({}, {
      'lib/index.js': 'exports.default = { name: "memebot-fixture" }\n',
    })

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
      }),
      'koishi-plugin-memebot-fixture',
      'must export an apply function',
    )
  })

  it('rejects a protected plugin without a concrete Access dependency', () => {
    const root = validArtifact()

    expectContractFailure(
      () => verifyExtractedArtifact(root, {
        pluginName: 'koishi-plugin-memebot-fixture',
        pluginDirectory: 'plugins/memebot-fixture',
        requiresAccess: true,
        accessVersion: '0.1.0-alpha.2',
      }),
      'koishi-plugin-memebot-fixture',
      'concrete compatible dependency',
    )
  })
})

describe('artifact check command surface', () => {
  it('registers one root command and documents the independent package boundary', () => {
    const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8')
    const agents = readFileSync(resolve(repositoryRoot, 'AGENTS.md'), 'utf8')

    expect(rootManifest.scripts['check:plugin-artifacts']).toBe('node scripts/check-plugin-artifacts.cjs')
    expect(readme).toContain('yarn check:plugin-artifacts')
    expect(readme).toMatch(/independent package boundary/i)
    expect(agents).toContain('yarn check:plugin-artifacts')
  })

  it('stages pack output outside the repository and deletes it afterwards', () => {
    const created = withArtifactStaging((stagingRoot) => {
      expect(stagingRoot.startsWith(tmpdir())).toBe(true)
      expect(stagingRoot.includes(repositoryRoot)).toBe(false)
      writeFileSync(join(stagingRoot, 'probe.tgz'), 'probe')
      return stagingRoot
    })

    expect(() => readFileSync(join(created, 'probe.tgz'))).toThrow()
  })
})
