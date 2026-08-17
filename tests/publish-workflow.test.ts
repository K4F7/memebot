import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const publishWorkflow = readFileSync(resolve(repositoryRoot, '.github/workflows/publish.yml'), 'utf8')
const readme = readFileSync(resolve(repositoryRoot, 'README.md'), 'utf8')
const agents = readFileSync(resolve(repositoryRoot, 'AGENTS.md'), 'utf8')

function permissionEntries(source: string) {
  return [...source.matchAll(/^permissions:\n((?:[ \t]+[a-z-]+:[ \t]*\w+[ \t]*\n)+)/gm)]
    .flatMap(([, block]) => [...block.matchAll(/^[ \t]+([a-z-]+):[ \t]*(\w+)[ \t]*$/gm)]
      .map(([, key, value]) => [key, value] as const))
}

describe('trusted publishing workflow contract', () => {
  it('grants only contents read and OIDC identity-token write on a GitHub-hosted runner', () => {
    expect(publishWorkflow).toMatch(/^\s+runs-on:\s+ubuntu-latest\s*$/m)
    expect(publishWorkflow).not.toMatch(/self-hosted/)
    expect(permissionEntries(publishWorkflow)).toEqual([
      ['contents', 'read'],
      ['id-token', 'write'],
    ])
  })

  it('rejects token authentication and direct workspace publication', () => {
    expect(publishWorkflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/i)
    expect(publishWorkflow).not.toMatch(/\byarn publish\b/)
    expect(publishWorkflow).not.toMatch(/working-directory:\s+\$\{\{\s*steps\.plugin\.outputs\.directory\s*\}\}/)
    expect(publishWorkflow).not.toMatch(/^\s+- run: npm publish --access public --tag/m)
  })

  it('verifies Node and npm trusted-publishing minimums before publication', () => {
    expect(publishWorkflow).toContain('22.14.0')
    expect(publishWorkflow).toContain('11.5.1')
    const runtimeStep = publishWorkflow.indexOf('22.14.0')
    const publishStep = publishWorkflow.indexOf('npm publish')
    expect(runtimeStep).toBeGreaterThan(-1)
    expect(publishStep).toBeGreaterThan(runtimeStep)
  })

  it('packs the selected plugin, validates that tarball, then publishes it with npm CLI', () => {
    expect(publishWorkflow).toMatch(/check-plugin-artifacts\.cjs --pack-selected/)
    const packOut = publishWorkflow.match(/--out\s+"([^"]+\.tgz)"/)
    const published = publishWorkflow.match(/npm publish\s+"([^"]+\.tgz)"/)
    expect(packOut?.[1]).toBeTruthy()
    expect(published?.[1]).toBe(packOut?.[1])
    expect(publishWorkflow).toMatch(/npm publish\s+"[^"]+\.tgz" --access public --tag/)
    expect(publishWorkflow).not.toMatch(/NPM_CONFIG_PROVENANCE=false|provenance:\s*false|--no-provenance/)
    expect(publishWorkflow).not.toMatch(/gh release|action-gh-release|softprops\/action-gh-release/)
  })

  it('keeps exact tag-to-plugin resolution and prerelease dist-tag selection', () => {
    expect(publishWorkflow).toContain('<plugin-directory>-v<version>')
    expect(publishWorkflow).toContain('npm_tag=${prerelease%%.*}')
    expect(publishWorkflow).toContain('npm_tag=latest')
    expect(publishWorkflow).toMatch(/Tag '\$\{GITHUB_REF_NAME\}' does not match a plugin and its package\.json version/)
  })
})

describe('trusted publishing release documentation', () => {
  it('documents trusted-publisher setup, OIDC, artifact flow, and auth-mismatch recovery', () => {
    for (const document of [readme, agents]) {
      expect(document).not.toMatch(/GitHub Actions secrets.*NPM_TOKEN|配置 npm access token `NPM_TOKEN`|using `NPM_TOKEN`/)
      expect(document).toMatch(/trusted publisher|Trusted Publisher|trusted publishing/i)
      expect(document).toContain('publish.yml')
      expect(document).toMatch(/id-token:\s*write|OIDC/)
      expect(document).toMatch(/tarball|Yarn.*pack|pack-selected/i)
      expect(document).toMatch(/mismatch|不匹配|authentication|鉴权/i)
    }
  })
})
