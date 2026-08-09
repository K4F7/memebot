import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => ({
  h: Object.assign((type: string, attrs: Record<string, unknown>, children: unknown) => ({ type, attrs, children }), {
    image: (value: string) => ({ type: 'image', value }),
    file: (value: string, attrs: Record<string, unknown>) => ({ type: 'file', value, attrs }),
  }),
}))

import { PayloadArchiveReadAdapter, PayloadArchiveReadError } from '../src/payload-read'

describe('PayloadArchiveReadAdapter', () => {
  it('uses the machine credential and validates the versioned contract', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'machine-token', timeoutMs: 500 }, {
      fetch: (async (input, init) => {
        const request = new Request(input, init)
        requests.push({ url: request.url, authorization: request.headers.get('authorization') })
        return new Response(JSON.stringify({ data: [{ id: 'W1', title: 'Example', author: 'Alice' }] }), { headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    await expect(adapter.searchWorks({ text: 'example' })).resolves.toEqual([{ id: 'W1', title: 'Example', author: 'Alice', description: undefined }])
    expect(requests[0]).toMatchObject({ authorization: 'Bearer machine-token' })
    expect(requests[0].url).toContain('query=example')
  })

  it('maps unavailable APIs and keeps a missing Work distinct from failure', async () => {
    const missing = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    })
    await expect(missing.getWork('W9')).resolves.toBeUndefined()

    const unavailable = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async () => { throw new Error('offline') }) as typeof fetch,
    })
    await expect(unavailable.searchWorks()).rejects.toMatchObject<Partial<PayloadArchiveReadError>>({ kind: 'unavailable' })
  })

  it('downloads protected media without leaking the machine credential', async () => {
    const requests: Request[] = []
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (request.url.endsWith('/works/W1')) {
          return new Response(JSON.stringify({ data: {
            id: 'W1', title: 'Example', author: 'Alice', media: [{ id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 3, access: { url: '/api/archive/v1/media/m1?signature=signed&expires=9999999999', expiresAt: '2030-01-01T00:00:00.000Z' } }],
          } }), { headers: { 'content-type': 'application/json' } })
        }
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }) as typeof fetch,
    })
    const work = await adapter.getWork('W1')
    expect(work?.media[0].access.url).toContain('/api/archive/v1/media/m1')
    await expect(adapter.fetchMedia(work!.media[0])).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(requests[1].headers.get('authorization')).toBeNull()
  })

  it('does not fetch media after its signed access expires', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as typeof globalThis.fetch
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch,
      now: () => Date.parse('2030-01-02T00:00:00.000Z'),
    })
    const media = {
      id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 1,
      access: { url: '/api/archive/v1/media/m1?signature=signed&expires=1', expiresAt: '2030-01-01T00:00:00.000Z' },
    }
    await expect(adapter.fetchMedia(media)).rejects.toMatchObject({ kind: 'media', status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
