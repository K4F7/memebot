import { describe, expect, it } from 'vitest'

import { handleArchiveApi } from './api'
import { InMemoryArchiveStore } from './store'

class PresignedArchiveStore extends InMemoryArchiveStore {
  async createMediaAccessUrl(media: { id: string }, expiresIn: number): Promise<string> {
    return `https://r2.example.test/${media.id}?expires=${expiresIn}`
  }
}

const now = 1_700_000_000_000
const options = { serviceToken: 'machine-secret', signingSecret: 'signing-secret', now: () => now, mediaTtlSeconds: 60 }

describe('Archive Work media contract', () => {
  it('assigns never-reused W identifiers and excludes incomplete works', async () => {
    const store = new InMemoryArchiveStore()
    const first = store.createWork({ title: 'First', author: 'Alice' })
    const second = store.createWork({ title: 'Second', author: 'Bob' })
    const image = store.createMedia({ workId: first.archiveId, filename: 'cover.png', contentType: 'image/png', bytes: new Uint8Array([1, 2]) })
    const pdf = store.createMedia({ workId: first.archiveId, filename: 'text.pdf', contentType: 'application/pdf', bytes: new Uint8Array([3, 4]) })
    store.createWorkMedia({ workId: first.archiveId, mediaId: pdf.id, displayOrder: 2 })
    store.createWorkMedia({ workId: first.archiveId, mediaId: image.id, displayOrder: 1, caption: 'Cover' })

    expect((await store.searchWorks()).map((item) => item.id)).toEqual(['W1'])
    expect((await store.getWork('W1'))?.media.map((item) => item.filename)).toEqual(['cover.png', 'text.pdf'])
    expect(second.archiveId).toBe('W2')
    expect(() => store.createMedia({ workId: 'W1', filename: 'bad.svg', contentType: 'image/svg+xml', bytes: new Uint8Array() })).toThrow()
    expect(() => store.createWorkMedia({ workId: 'W2', mediaId: image.id, displayOrder: 0 })).toThrow()
  })

  it('requires machine auth and returns ordered descriptors with expiring access', async () => {
    const store = new InMemoryArchiveStore()
    const work = store.createWork({ title: 'Work', author: 'Author' })
    const media = store.createMedia({ workId: work.archiveId, filename: 'one.png', contentType: 'image/png', bytes: new Uint8Array([9, 8, 7]) })
    store.createWorkMedia({ workId: work.archiveId, mediaId: media.id, displayOrder: 0 })
    const unauthorized = await handleArchiveApi(new Request('https://archive.test/api/archive/v1/works'), store, options)
    expect(unauthorized.status).toBe(401)

    const response = await handleArchiveApi(new Request('https://archive.test/api/archive/v1/works/W1', { headers: { authorization: 'Bearer machine-secret' } }), store, options)
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.data.media[0]).toMatchObject({ filename: 'one.png', contentType: 'image/png' })
    const mediaUrl = body.data.media[0].access.url as string
    const mediaResponse = await handleArchiveApi(new Request(mediaUrl), store, options)
    expect(mediaResponse.status).toBe(200)
    expect([...new Uint8Array(await mediaResponse.arrayBuffer())]).toEqual([9, 8, 7])
  })

  it('rejects expired protected media access', async () => {
    const store = new InMemoryArchiveStore()
    const work = store.createWork({ title: 'Work', author: 'Author' })
    const media = store.createMedia({ workId: work.archiveId, filename: 'one.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) })
    store.createWorkMedia({ workId: work.archiveId, mediaId: media.id, displayOrder: 0 })
    const response = await handleArchiveApi(new Request('https://archive.test/api/archive/v1/works/W1', { headers: { authorization: 'Bearer machine-secret' } }), store, options)
    const body = await response.json() as any
    const expired = new URL(body.data.media[0].access.url)
    expired.searchParams.set('expires', String(Math.floor(now / 1000) - 1))
    expect((await handleArchiveApi(new Request(expired), store, options)).status).toBe(401)
  })

  it('redirects protected media to a presigned object URL when available', async () => {
    const store = new PresignedArchiveStore()
    const work = store.createWork({ title: 'Work', author: 'Author' })
    const media = store.createMedia({ workId: work.archiveId, filename: 'one.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) })
    store.createWorkMedia({ workId: work.archiveId, mediaId: media.id, displayOrder: 0 })

    const detail = await handleArchiveApi(
      new Request('https://archive.test/api/archive/v1/works/W1', { headers: { authorization: 'Bearer machine-secret' } }),
      store,
      options,
    )
    const body = await detail.json() as any
    const mediaResponse = await handleArchiveApi(new Request(body.data.media[0].access.url), store, options)

    expect(mediaResponse.status).toBe(302)
    expect(mediaResponse.headers.get('location')).toBe('https://r2.example.test/media-1?expires=60')
    expect(mediaResponse.headers.get('cache-control')).toBe('private, max-age=60')
  })
})
