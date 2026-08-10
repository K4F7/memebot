import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

type StagingRunner = {
  buildStagingConfig(env?: Record<string, string>, argv?: string[]): any
  formatStagingReport(result: any): string
  runStagingSmoke(config: any, options?: any): Promise<any>
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  buildStagingConfig,
  formatStagingReport,
  runStagingSmoke,
} = require('../scripts/archive-staging-smoke.cjs') as StagingRunner

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('Archive staging smoke boundary', () => {
  it('does not execute without explicit staging credentials', async () => {
    const config = buildStagingConfig({})
    const fetch = vi.fn()

    expect(config).toMatchObject({ enabled: false, reason: 'missing-url-or-token' })
    await expect(runStagingSmoke(config, { fetch })).resolves.toMatchObject({ status: 'not-executed' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes a site URL and requires explicit opt-in for incomplete configuration', () => {
    expect(buildStagingConfig({
      MEMEBOT_ARCHIVE_STAGING_URL: 'https://archive.example/api/archive/v1/',
      MEMEBOT_ARCHIVE_STAGING_TOKEN: 'secret',
      MEMEBOT_ARCHIVE_STAGING_WORK_ID: 'w7',
    })).toMatchObject({
      enabled: true,
      siteUrl: 'https://archive.example/',
      apiUrl: 'https://archive.example/api/archive/v1/',
      workId: 'W7',
      required: false,
    })

    const required = buildStagingConfig({ MEMEBOT_ARCHIVE_STAGING_REQUIRED: '1' })
    expect(required).toMatchObject({ enabled: false, required: true, reason: 'missing-url-or-token' })
  })

  it('covers the machine read, private media, expiry, invalid credential, and redeploy seams', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)

      if (url.pathname.endsWith('/api/health')) return jsonResponse({ status: 'ok' })
      if (url.pathname.endsWith('/api/archive/v1/works') && request.method === 'GET') {
        if (request.headers.get('authorization') !== 'Bearer machine-token') return jsonResponse({ error: 'unauthorized' }, 401)
        return jsonResponse({ data: [{ id: 'W7', title: 'Staging Work', author: 'Alice' }], total: 1 })
      }
      if (url.pathname.endsWith('/api/archive/v1/works/W7')) {
        if (request.headers.get('authorization') !== 'Bearer machine-token') return jsonResponse({ error: 'unauthorized' }, 401)
        return jsonResponse({ data: {
          id: 'W7',
          title: 'Staging Work',
          author: 'Alice',
          media: [{
            id: 'media-7',
            filename: 'cover.png',
            contentType: 'image/png',
            size: 3,
            access: {
              url: 'https://archive.example/api/archive/v1/media/media-7?expires=4102444800&signature=signed',
              expiresAt: '2100-01-01T00:00:00.000Z',
            },
          }],
        } })
      }
      if (url.pathname.endsWith('/api/archive/v1/media/media-7')) {
        if (Number(url.searchParams.get('expires')) < 2_000_000_000) return jsonResponse({ error: 'expired' }, 401)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      if (url.hostname === 'after.archive.example') {
        if (url.pathname.endsWith('/api/archive/v1/works')) return jsonResponse({ data: [{ id: 'W7', title: 'Staging Work', author: 'Alice' }], total: 1 })
        if (url.pathname.endsWith('/api/archive/v1/works/W7')) return jsonResponse({ data: {
          id: 'W7', title: 'Staging Work', author: 'Alice',
          media: [{ id: 'media-7', filename: 'cover.png', contentType: 'image/png', size: 3,
            access: { url: 'https://after.archive.example/api/archive/v1/media/media-7?expires=4102444800&signature=signed', expiresAt: '2100-01-01T00:00:00.000Z' } }],
        } })
      }
      return jsonResponse({ error: 'unexpected request' }, 500)
    })

    const stateRoot = mkdtempSync(join(tmpdir(), 'memebot-archive-staging-'))
    const config = buildStagingConfig({
      MEMEBOT_ARCHIVE_STAGING_URL: 'https://archive.example',
      MEMEBOT_ARCHIVE_STAGING_TOKEN: 'machine-token',
      MEMEBOT_ARCHIVE_STAGING_WORK_ID: 'W7',
      MEMEBOT_ARCHIVE_STAGING_STATE_FILE: join(stateRoot, 'state.json'),
      MEMEBOT_ARCHIVE_STAGING_MEDIA_SIGNING_SECRET: 'signing-secret',
    })
    await expect(runStagingSmoke(config, { fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z') })).resolves.toMatchObject({ status: 'passed' })
    const result = await runStagingSmoke(config, { fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z') })
    rmSync(stateRoot, { force: true, recursive: true })
    expect(result.status).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'health', status: 'passed' }),
      expect.objectContaining({ name: 'machine-read', status: 'passed' }),
      expect.objectContaining({ name: 'private-media', status: 'passed' }),
      expect.objectContaining({ name: 'expired-media', status: 'passed' }),
      expect.objectContaining({ name: 'invalid-credential', status: 'passed' }),
      expect.objectContaining({ name: 'redeploy-persistence', status: 'passed' }),
    ]))
    expect(requests.some((request) => request.headers.get('authorization') === 'Bearer wrong-token')).toBe(true)
    expect(requests.filter((request) => request.url.includes('/media/')).every((request) => !request.headers.has('authorization'))).toBe(true)
  })

  it('reports optional outage and failed-media fixtures without hiding the core result', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/api/health')) return jsonResponse({ status: 'ok' })
      if (url.hostname === 'outage.archive.example') throw new Error('connection refused')
      if (url.pathname.endsWith('/failed-media')) return jsonResponse({ error: 'missing object' }, 404)
      if (url.pathname.endsWith('/api/archive/v1/works')) {
        if (request.headers.get('authorization') !== 'Bearer machine-token') return jsonResponse({ error: 'unauthorized' }, 401)
        return jsonResponse({ data: [{ id: 'W7', title: 'Staging Work', author: 'Alice' }], total: 1 })
      }
      if (url.pathname.endsWith('/api/archive/v1/works/W7')) return jsonResponse({ data: {
        id: 'W7', title: 'Staging Work', author: 'Alice', media: [
          { id: 'media-7', filename: 'cover.png', contentType: 'image/png', size: 1,
            access: { url: 'https://archive.example/api/archive/v1/media/media-7?expires=4102444800&signature=signed', expiresAt: '2100-01-01T00:00:00.000Z' } },
          { id: 'media-8', filename: 'missing.png', contentType: 'image/png', size: 1,
            access: { url: 'https://archive.example/api/archive/v1/media/media-8?expires=4102444800&signature=signed', expiresAt: '2100-01-01T00:00:00.000Z' } },
        ],
      } })
      if (url.pathname.endsWith('/api/archive/v1/media/media-7')) {
        if (Number(url.searchParams.get('expires')) < 2_000_000_000) return jsonResponse({ error: 'expired' }, 401)
        return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
      }
      if (url.pathname.endsWith('/api/archive/v1/media/media-8')) return jsonResponse({ error: 'missing object' }, 404)
      return jsonResponse({ error: 'unexpected request' }, 500)
    })
    const config = buildStagingConfig({
      MEMEBOT_ARCHIVE_STAGING_URL: 'https://archive.example',
      MEMEBOT_ARCHIVE_STAGING_TOKEN: 'machine-token',
      MEMEBOT_ARCHIVE_STAGING_WORK_ID: 'W7',
      MEMEBOT_ARCHIVE_STAGING_OUTAGE_URL: 'https://outage.archive.example',
      MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_URL: 'https://archive.example/api/archive/v1/media/media-8?expires=4102444800&signature=signed',
      MEMEBOT_ARCHIVE_STAGING_FAILED_MEDIA_WORK_ID: 'W7',
    })

    const result = await runStagingSmoke(config, { fetch, now: () => Date.parse('2030-01-01T00:00:00.000Z') })
    expect(result.status).toBe('passed')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'payload-outage', status: 'passed' }),
      expect.objectContaining({ name: 'failed-media', status: 'passed' }),
    ]))
    expect(formatStagingReport(result)).toContain('Archive staging smoke: PASSED')
    expect(formatStagingReport(result)).not.toContain('machine-token')
  })
})
