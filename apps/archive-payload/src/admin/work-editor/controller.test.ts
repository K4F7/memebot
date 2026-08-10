import { describe, expect, it, vi, beforeEach } from 'vitest'

import {
  AuthoringApiError,
  createWorkAuthoringClient,
  fixtureAuthorizeUploadResponse,
  fixtureDraftWork,
  fixtureDraftWithMedia,
  fixtureFinalizeUploadResponse,
  fixtureImageMedia,
  fixturePublishedWork,
  fixtureStaleRevisionError,
  FIXTURE_REVISION_V1,
  FIXTURE_REVISION_V2,
  FIXTURE_REVISION_PUBLISHED,
} from '../../authoring'
import { createWorkEditorController } from './controller'
import { resetClientIdSeq } from './state'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeFile(name: string, type: string, size = 32): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('Work editor controller', () => {
  beforeEach(() => {
    resetClientIdSeq()
  })

  it('creates draft work before first upload and finalizes in selection order', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works') && init?.method === 'POST') {
        calls.push('create')
        return jsonResponse(fixtureDraftWork())
      }
      if (url.endsWith('/authorize')) {
        const body = JSON.parse(String(init?.body || '{}')) as { filename: string }
        calls.push(`authorize:${body.filename}`)
        return jsonResponse(
          fixtureAuthorizeUploadResponse({
            uploadId: `upload-${body.filename}`,
            putUrl: `https://r2.example.test/${body.filename}`,
          }),
        )
      }
      if (url.includes('r2.example.test')) {
        calls.push(`put:${url.split('/').pop()}`)
        // Complete second file before first to prove order preservation.
        if (url.endsWith('a.png')) await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/finalize')) {
        const body = JSON.parse(String(init?.body || '{}')) as { uploadId: string }
        calls.push(`finalize:${body.uploadId}`)
        const filename = body.uploadId.replace('upload-', '')
        const media = fixtureImageMedia({
          mediaId: `media-${filename}`,
          filename,
          extension: filename.endsWith('.pdf') ? 'pdf' : 'png',
          mimeType: filename.endsWith('.pdf') ? 'application/pdf' : 'image/png',
          isImage: !filename.endsWith('.pdf'),
          isPdf: filename.endsWith('.pdf'),
        })
        return jsonResponse({
          ...fixtureDraftWork({ revision: FIXTURE_REVISION_V2, media: [media] }),
          mediaItem: media,
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const client = createWorkAuthoringClient({ fetchImpl })
    const controller = createWorkEditorController({ client, concurrency: 2 })
    controller.setTitle('示例作品')
    controller.setAuthor('Alice')
    controller.addFiles([fakeFile('a.png', 'image/png'), fakeFile('b.png', 'image/png')])

    await vi.waitFor(() => {
      const cards = controller.getState().cards
      expect(cards.every((card: { kind: string }) => card.kind === 'media')).toBe(true)
    }, { timeout: 2000 })

    expect(controller.getState().cards.map((card: { kind: string; media?: { filename: string } }) => (card.kind === 'media' ? card.media?.filename : ''))).toEqual([
      'a.png',
      'b.png',
    ])
    expect(calls[0]).toBe('create')
    // Finalization may complete out of network order; selection order is preserved on cards.
    expect(calls.filter((item) => item.startsWith('finalize')).sort()).toEqual([
      'finalize:upload-a.png',
      'finalize:upload-b.png',
    ])
  })

  it('saves draft and publishes through the authoring API', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works/work-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fixtureDraftWithMedia())
      }
      if (url.endsWith('/draft')) {
        const body = JSON.parse(String(init?.body || '{}'))
        expect(body.revision).toBe(FIXTURE_REVISION_V2)
        expect(body.media.map((item: { mediaId: string }) => item.mediaId)).toEqual([
          'media-pdf-1',
          'media-image-1',
        ])
        return jsonResponse(fixtureDraftWithMedia())
      }
      if (url.endsWith('/publish')) {
        return jsonResponse(fixturePublishedWork())
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const controller = createWorkEditorController({
      client: createWorkAuthoringClient({ fetchImpl }),
      workId: 'work-1',
    })
    await controller.load()
    controller.move(controller.getState().cards[1].clientId, -1)
    await controller.saveDraft()
    expect(controller.getState().phase).toBe('saved')
    await controller.publish()
    expect(controller.getState().phase).toBe('published')
    expect(controller.getState().publicationStatus).toBe('published')
    expect(controller.getState().revision).toBe(FIXTURE_REVISION_PUBLISHED)
  })

  it('preserves local state on stale save conflict', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works/work-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fixtureDraftWithMedia())
      }
      if (url.endsWith('/draft')) {
        return jsonResponse(fixtureStaleRevisionError(), 409)
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const controller = createWorkEditorController({
      client: createWorkAuthoringClient({ fetchImpl }),
      workId: 'work-1',
    })
    await controller.load()
    controller.setTitle('本地未保存标题')
    await controller.saveDraft()
    const state = controller.getState()
    expect(state.phase).toBe('conflict')
    expect(state.title).toBe('本地未保存标题')
    expect(state.conflictMessage).toMatch(/其他编辑者/)
  })

  it('keeps draft after failed publish', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works/work-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fixtureDraftWithMedia())
      }
      if (url.endsWith('/publish')) {
        return jsonResponse(
          { error: { code: 'publication_failed', message: '发布失败，草稿已保留，可重试。' } },
          500,
        )
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const controller = createWorkEditorController({
      client: createWorkAuthoringClient({ fetchImpl }),
      workId: 'work-1',
    })
    await controller.load()
    await controller.publish()
    const state = controller.getState()
    expect(state.pageError).toMatch(/发布失败/)
    expect(state.cards).toHaveLength(2)
    expect(state.revision).toBe(FIXTURE_REVISION_V2)
  })

  it('surfaces per-file upload failure without discarding siblings', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works') && init?.method === 'POST') return jsonResponse(fixtureDraftWork())
      if (url.endsWith('/authorize')) {
        const body = JSON.parse(String(init?.body || '{}')) as { filename: string }
        if (body.filename === 'bad.png') {
          return jsonResponse(
            { error: { code: 'upload_authorization_expired', message: '上传授权已过期，请重试该媒体文件。' } },
            400,
          )
        }
        return jsonResponse(fixtureAuthorizeUploadResponse({ putUrl: 'https://r2.example.test/ok.png' }))
      }
      if (url.includes('r2.example.test')) return new Response(null, { status: 200 })
      if (url.endsWith('/finalize')) return jsonResponse(fixtureFinalizeUploadResponse())
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const controller = createWorkEditorController({
      client: createWorkAuthoringClient({ fetchImpl }),
      concurrency: 1,
    })
    controller.setTitle('T')
    controller.setAuthor('A')
    controller.addFiles([fakeFile('ok.png', 'image/png'), fakeFile('bad.png', 'image/png')])

    await vi.waitFor(() => {
      const cards = controller.getState().cards
      expect(cards.some((card: { kind: string }) => card.kind === 'media')).toBe(true)
      expect(cards.some((card: { kind: string; phase?: string }) => card.kind === 'upload' && card.phase === 'failed')).toBe(true)
    }, { timeout: 2000 })
  })
})
