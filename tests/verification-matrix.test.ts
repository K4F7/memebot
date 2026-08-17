import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
  workspaces?: string[]
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}
const yakumoConfig = readFileSync(resolve(repositoryRoot, 'yakumo.yml'), 'utf8')
const ciWorkflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
const publishWorkflow = readFileSync(resolve(repositoryRoot, '.github/workflows/publish.yml'), 'utf8')
const verificationDoc = readFileSync(resolve(repositoryRoot, 'docs/testing/verification.md'), 'utf8')
const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8')
const agents = readFileSync(resolve(repositoryRoot, 'AGENTS.md'), 'utf8')
const archiveQq = readFileSync(resolve(repositoryRoot, 'docs/testing/archive-qq-shortcuts.md'), 'utf8')
const archiveConsole = readFileSync(resolve(repositoryRoot, 'docs/testing/archive-console-browser.md'), 'utf8')

const pluginDirectories = readdirSync(resolve(repositoryRoot, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('memebot-'))
  .map((entry) => entry.name)
  .sort()

const verificationSequence = [
  'yarn install --immutable',
  'yarn typecheck',
  'yarn test',
  'yarn build',
  'yarn check:plugin-loads',
  'yarn check:plugin-artifacts',
] as const

function yarnCommands(workflow: string) {
  return [...workflow.matchAll(/^\s+- run: (yarn .+)$/gm)].map(([, command]) => command)
}

function pluginManifest(directory: string) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, 'plugins', directory, 'package.json'), 'utf8')) as {
    name: string
    scripts?: Record<string, string>
  }
}

describe('Yakumo-managed verification matrix', () => {
  it('keeps Yakumo discovery on the existing plugin workspaces only', () => {
    expect(rootManifest.workspaces).toEqual(['plugins/*'])
    expect(pluginDirectories).toEqual([
      'memebot-access',
      'memebot-activity',
      'memebot-archive',
      'memebot-faq',
      'memebot-intake',
    ])

    expect(yakumoConfig).toMatch(/^\s*- name: yakumo\s*$/m)
    expect(yakumoConfig).toMatch(/^\s*- name: yakumo-tsc\s*$/m)
    expect(yakumoConfig).toMatch(/^\s*- name: yakumo-esbuild\s*$/m)
    expect(yakumoConfig).not.toMatch(/app\/|archive-payload|external\/|packages\//)
    expect(rootManifest.devDependencies).toMatchObject({
      yakumo: expect.any(String),
      'yakumo-esbuild': expect.any(String),
      'yakumo-tsc': expect.any(String),
    })
  })

  it('keeps the stable root commands while Yakumo orchestrates workspaces', () => {
    expect(rootManifest.scripts?.typecheck).toMatch(/^yakumo\b/)
    expect(rootManifest.scripts?.typecheck).toContain('tsconfig.tests.json')
    expect(rootManifest.scripts?.build).toMatch(/^yakumo\b/)
    expect(rootManifest.scripts?.test).toBe('vitest run')
    expect(rootManifest.scripts?.['check:plugin-loads']).toBe('node scripts/check-plugin-loads.cjs')
    expect(rootManifest.scripts?.['check:plugin-artifacts']).toBe('node scripts/check-plugin-artifacts.cjs')
    expect(rootManifest.scripts?.['smoke:local-app']).toBe('node scripts/smoke-local-app.cjs')
  })

  it('typechecks every plugin and the Access Console client without emitting build output', () => {
    for (const directory of pluginDirectories) {
      const typecheck = pluginManifest(directory).scripts?.typecheck ?? ''
      expect(typecheck, directory).toContain('--noEmit')
      expect(typecheck, directory).not.toMatch(/\btsc\s+-b\b/)
    }

    const accessTypecheck = pluginManifest('memebot-access').scripts?.typecheck ?? ''
    expect(accessTypecheck).toContain('tsconfig.client.json')
    expect(pluginManifest('memebot-access').scripts?.build).toMatch(/\bvite build\b/)
    expect(pluginManifest('memebot-access').scripts?.['build:client']).toBe('vite build')
  })

  it('keeps repository, Mock, Archive fail-closed, and smoke-helper tests on the root test command', () => {
    const requiredTests = [
      'tests/agent-delivery.test.ts',
      'tests/koishi-smoke.test.ts',
      'tests/local-app-smoke.test.ts',
      'tests/plugin-artifacts.test.ts',
      'tests/readme.test.ts',
      'tests/verification-matrix.test.ts',
      'plugins/memebot-access/tests/access.test.ts',
      'plugins/memebot-access/tests/console-client.test.ts',
      'plugins/memebot-activity/tests/activity.test.ts',
      'plugins/memebot-archive/tests/index.test.ts',
      'plugins/memebot-faq/tests/faq.test.ts',
      'plugins/memebot-intake/tests/intake.test.ts',
      'plugins/memebot-intake/tests/notification.test.ts',
    ]

    for (const relativePath of requiredTests) {
      expect(existsSync(resolve(repositoryRoot, relativePath)), relativePath).toBe(true)
    }
  })

  it('uses one service-free CI job in the agreed verification order', () => {
    const jobsBlock = ciWorkflow.split(/^jobs:\s*$/m)[1] ?? ''
    const jobNames = [...jobsBlock.matchAll(/^  ([a-z0-9-]+):\s*$/gm)].map(([, name]) => name)
    expect(jobNames).toEqual(['verify'])
    expect(ciWorkflow).not.toMatch(/postgres|postgresql|payload|NPM_TOKEN|NODE_AUTH_TOKEN|smoke:local-app/i)
    expect(ciWorkflow).not.toMatch(/^\s+services:/m)
    expect(yarnCommands(ciWorkflow)).toEqual([...verificationSequence])
  })

  it('runs plugin-load and packed artifact checks after the explicit build', () => {
    expect(yarnCommands(publishWorkflow)).toEqual([
      'yarn install --immutable',
      'yarn typecheck',
      'yarn test',
      'yarn build',
      'yarn check:plugin-loads',
      'yarn check:plugin-artifacts',
    ])
  })

  it('publishes one authoritative verification matrix for contributors, CI, and release', () => {
    for (const document of [verificationDoc, readme, agents]) {
      const start = document.indexOf('yarn install --immutable')
      expect(start).toBeGreaterThan(-1)
      const block = document.slice(start, start + 400)
      for (const command of verificationSequence) {
        expect(block).toContain(command)
      }
      expect(block.indexOf('yarn typecheck')).toBeLessThan(block.indexOf('yarn test'))
      expect(block.indexOf('yarn test')).toBeLessThan(block.indexOf('yarn build'))
      expect(block.indexOf('yarn build')).toBeLessThan(block.indexOf('yarn check:plugin-loads'))
      expect(block.indexOf('yarn check:plugin-loads')).toBeLessThan(block.indexOf('yarn check:plugin-artifacts'))
    }

    expect(verificationDoc).toMatch(/manual|手动/)
    expect(verificationDoc).toContain('yarn smoke:local-app')
    expect(readme).toContain('docs/testing/verification.md')
    expect(agents).toContain('docs/testing/verification.md')
    expect(existsSync(resolve(repositoryRoot, 'docs/testing/final-five-plugin-acceptance.md'))).toBe(false)
  })

  it('describes Archive acceptance as the fail-closed QQ read surface only', () => {
    expect(archiveQq).toMatch(/fail-closed|暂时不可用/)
    expect(archiveQq).toMatch(/does not live in this repository|不在本仓库/)
    expect(archiveConsole).toMatch(/does not live in this repository|不在本仓库/)
    expect(archiveConsole).toMatch(/fail-closed/)
    expect(archiveQq).not.toMatch(/yarn workspace koishi-plugin-memebot-archive test:browser/)
    expect(archiveConsole).not.toMatch(/MEMEBOT_ARCHIVE_WEBUI_URL|test:browser:required/)
  })
})
