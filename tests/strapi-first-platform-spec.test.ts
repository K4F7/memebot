import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const spec = readFileSync(
  resolve(process.cwd(), 'docs/specs/strapi-first-content-platform.md'),
  'utf8',
).replace(/\s+/g, ' ')
const adr = readFileSync(
  resolve(process.cwd(), 'docs/adr/0019-strapi-vercel-admin-vps-api.md'),
  'utf8',
).replace(/\s+/g, ' ')

describe('Strapi first-version content platform spec', () => {
  it('keeps the platform in an independent single Strapi 5 application', () => {
    expect(spec).toContain('K4F7/cms')
    expect(spec).toMatch(/standard Strapi 5 application/i)
    expect(spec).toMatch(/Do not split Admin and API/i)
    expect(spec).toMatch(/must not grow a Strapi application/i)
    expect(adr).toContain('K4F7/cms')
    expect(adr).toMatch(/does not\s+host, build, or configure that application/)
  })

  it('records the Vercel Admin and VPS API operating boundary', () => {
    expect(spec).toMatch(/Vercel hosts only the prebuilt Admin/)
    expect(spec).toContain('louis')
    expect(spec).toMatch(/1Panel PostgreSQL/)
    expect(spec).toMatch(/do not expose the database port/)
    expect(spec).toMatch(/explicit persistent media bind mount/)
    expect(spec).toMatch(/It is not disaster\s+recovery/)
    expect(spec).toContain('50 MiB')
    expect(adr).toMatch(/Vercel hosts only the prebuilt Admin/)
    expect(adr).toMatch(/bind-mounted media/)
    expect(adr).toMatch(/not disaster recovery/)
  })

  it('records the HMAC webhook release contract and fail-closed checks', () => {
    expect(spec).toContain('ghcr.io/k4f7/cms:<git-sha>')
    expect(spec).toMatch(/HMAC-SHA256 over the raw body and timestamp/)
    expect(spec).toMatch(/Invalid, stale, or replayed\s+requests fail closed/)
    expect(spec).toMatch(/GitHub Environment `production`/)
    expect(spec).toMatch(/health response containing the deployed Git SHA and image digest/)
    expect(adr).toContain('ghcr.io/k4f7/cms:<git-sha>')
    expect(adr).toMatch(/HMAC-SHA256/)
    expect(adr).toMatch(/Invalid webhook signatures fail closed/)
  })

  it('preserves domain vocabulary and leaves the Archive Read Contract unbound', () => {
    for (const term of [
      'Work',
      'Media Item',
      'WorkMedia Relationship',
      'Archive Administrator',
      'Archive Read Contract',
    ]) {
      expect(spec).toContain(term)
    }
    expect(spec).toMatch(/does not bind the Koishi read adapter/)
    expect(adr).toMatch(/does not bind the\s+Archive Read Contract/)
  })
})
