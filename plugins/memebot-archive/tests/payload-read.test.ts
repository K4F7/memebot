import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => ({
  h: Object.assign((type: string, attrs: Record<string, unknown>, children: unknown) => ({ type, attrs, children }), {
    image: (value: string) => ({ type: 'image', value }),
    file: (value: string, attrs: Record<string, unknown>) => ({ type: 'file', value, attrs }),
  }),
}))

import { PayloadArchiveReadAdapter, PayloadArchiveReadError, sendPayloadWork } from '../src/payload-read'

describe('PayloadArchiveReadAdapter', () => {
  it('requires an HTTP(S) endpoint and a dedicated machine credential', () => {
    expect(() => new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'ftp://payload.test', serviceToken: 'token', timeoutMs: 500 })).toThrow(PayloadArchiveReadError)
    expect(() => new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: '  ', timeoutMs: 500 })).toThrow(PayloadArchiveReadError)
  })

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

  it('accepts either the Payload site root or the versioned API root', async () => {
    const requests: string[] = []
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test/api/archive/v1', serviceToken: 'machine-token', timeoutMs: 500 }, {
      fetch: (async (input, init) => {
        const request = new Request(input, init)
        requests.push(request.url)
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    })
    await expect(adapter.searchWorks()).resolves.toEqual([])
    expect(requests).toEqual(['https://payload.test/api/archive/v1/works'])
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

  it('does not add the machine credential to a relative media URL', async () => {
    const requests: Request[] = []
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }) as typeof fetch,
    })
    const media = {
      id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 3,
      access: { url: '/api/archive/v1/not-media/m1?expires=9999999999&signature=signed', expiresAt: '2030-01-01T00:00:00.000Z' },
    }
    await expect(adapter.fetchMedia(media)).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(requests[0].headers.get('authorization')).toBeNull()
  })

  it('rejects malformed media descriptors instead of passing invalid sizes through', async () => {
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async () => new Response(JSON.stringify({ data: {
        id: 'W1', title: 'Example', author: 'Alice', media: [{
          id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 'not-a-number',
          access: { url: '/api/archive/v1/media/m1?expires=9999999999&signature=signed', expiresAt: '2030-01-01T00:00:00.000Z' },
        }],
      } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    await expect(adapter.getWork('W1')).rejects.toMatchObject<Partial<PayloadArchiveReadError>>({ kind: 'contract' })
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

  it('treats an invalid media expiry as a protected-media failure without fetching it', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1]))) as typeof globalThis.fetch
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, { fetch })
    const media = {
      id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 1,
      access: { url: '/api/archive/v1/media/m1?signature=signed&expires=1', expiresAt: 'not-a-date' },
    }
    await expect(adapter.fetchMedia(media)).rejects.toMatchObject({ kind: 'media', status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a protected-media response whose content type disagrees with the descriptor', async () => {
    const adapter = new PayloadArchiveReadAdapter({ enabled: true, baseUrl: 'https://payload.test', serviceToken: 'token', timeoutMs: 500 }, {
      fetch: (async () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })) as typeof fetch,
    })
    const media = {
      id: 'm1', filename: 'cover.png', contentType: 'image/png', size: 1,
      access: { url: '/api/archive/v1/media/m1?signature=signed&expires=1', expiresAt: '2030-01-01T00:00:00.000Z' },
    }
    await expect(adapter.fetchMedia(media)).rejects.toMatchObject({ kind: 'media', status: 415 })
  })

  it('delivers ordered images and PDFs in one merged-forward message while reporting item failures', async () => {
    const work = {
      id: 'W1', title: 'Example', author: 'Alice',
      media: [
        { id: 'image', filename: 'cover.png', contentType: 'image/png', size: 1, caption: 'Cover', access: { url: '/media/image', expiresAt: '2030-01-01T00:00:00.000Z' } },
        { id: 'pdf', filename: 'text.pdf', contentType: 'application/pdf', size: 1, access: { url: '/media/pdf', expiresAt: '2030-01-01T00:00:00.000Z' } },
        { id: 'broken', filename: 'broken.png', contentType: 'image/png', size: 1, access: { url: '/media/broken', expiresAt: '2030-01-01T00:00:00.000Z' } },
      ],
    }
    const adapter = {
      getWork: vi.fn(async () => work),
      fetchMedia: vi.fn(async (media: typeof work.media[number]) => {
        if (media.id === 'broken') throw new PayloadArchiveReadError('media', 'broken.png 获取失败。', 503)
        return new Uint8Array([media.id === 'image' ? 1 : 2])
      }),
    }
    const session = { send: vi.fn(async () => undefined) }

    await expect(sendPayloadWork(session as any, adapter as any, 'W1')).resolves.toBe('已发送 Work W1。')
    expect(adapter.fetchMedia).toHaveBeenCalledTimes(3)
    expect(session.send).toHaveBeenCalledTimes(1)
    const forward = session.send.mock.calls[0][0] as any
    expect(forward.attrs).toEqual({ forward: true })
    expect(forward.children.map((node: any) => node.children)).toEqual([
      'W1 Alice - Example',
      ['Cover\n', { type: 'image', value: 'data:image/png;base64,AQ==' }],
      [{ type: 'file', value: 'data:application/pdf;base64,Ag==', attrs: { filename: 'text.pdf' } }],
      'broken.png 获取失败。',
    ])
  })
})
