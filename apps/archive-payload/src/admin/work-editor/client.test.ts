import { describe, expect, it, vi } from 'vitest'

import {
  AuthoringApiError,
  createWorkAuthoringClient,
  fixtureAuthorizeUploadResponse,
  fixtureCreateRequest,
  fixtureDraftWork,
  fixtureDraftWithMedia,
  fixtureFinalizeUploadResponse,
  fixturePublishedWork,
  fixtureSaveDraftRequest,
  fixtureStaleRevisionError,
  FIXTURE_REVISION_V1,
  FIXTURE_REVISION_V2,
} from '../../authoring'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Work Authoring API client', () => {
  it('creates a draft work and loads the aggregate', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/works') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual(fixtureCreateRequest())
        return jsonResponse(fixtureDraftWork())
      }
      if (url.endsWith('/works/work-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(fixtureDraftWithMedia())
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const client = createWorkAuthoringClient({ fetchImpl })
    const created = await client.createWork(fixtureCreateRequest())
    expect(created.archiveId).toBe('W1')
    expect(created.revision).toBe(FIXTURE_REVISION_V1)

    const loaded = await client.getWork('work-1')
    expect(loaded.media).toHaveLength(2)
  })

  it('saves draft and publishes with revision token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/draft')) {
        expect(JSON.parse(String(init?.body || '{}')).revision).toBe(FIXTURE_REVISION_V2)
        return jsonResponse(fixtureDraftWithMedia())
      }
      if (url.endsWith('/publish')) {
        expect(JSON.parse(String(init?.body || '{}')).revision).toBe(FIXTURE_REVISION_V2)
        return jsonResponse(fixturePublishedWork())
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const client = createWorkAuthoringClient({ fetchImpl })
    const saved = await client.saveDraft('work-1', fixtureSaveDraftRequest())
    expect(saved.media).toHaveLength(2)
    const published = await client.publish('work-1', { revision: FIXTURE_REVISION_V2 })
    expect(published.publicationStatus).toBe('published')
  })

  it('authorizes and finalizes upload, then PUTs to R2', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('presigned')) return put()
      if (url.endsWith('/authorize')) return jsonResponse(fixtureAuthorizeUploadResponse())
      if (url.endsWith('/finalize')) return jsonResponse(fixtureFinalizeUploadResponse())
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const client = createWorkAuthoringClient({ fetchImpl })
    const auth = await client.authorizeUpload('work-1', {
      revision: FIXTURE_REVISION_V1,
      filename: 'cover.png',
      filesize: 12_345,
      mimeType: 'image/png',
    })
    await client.putToR2(auth.upload.putUrl, new Blob(['x'], { type: 'image/png' }), auth.upload.headers)
    const finalized = await client.finalizeUpload('work-1', {
      revision: FIXTURE_REVISION_V1,
      uploadId: auth.upload.uploadId,
      idempotencyKey: 'idem-1',
      context: auth.upload.context,
    })
    expect(finalized.mediaItem.mediaId).toBe('media-image-1')
    expect(put).toHaveBeenCalledOnce()
  })

  it('maps stale revision responses to AuthoringApiError without silent overwrite', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(fixtureStaleRevisionError(), 409),
    ) as unknown as typeof fetch
    const client = createWorkAuthoringClient({ fetchImpl })
    await expect(client.saveDraft('work-1', fixtureSaveDraftRequest())).rejects.toMatchObject({
      name: 'AuthoringApiError',
      code: 'stale_revision',
      currentRevision: FIXTURE_REVISION_V2,
    })
    try {
      await client.saveDraft('work-1', fixtureSaveDraftRequest())
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringApiError)
      if (error instanceof AuthoringApiError) {
        expect(error.aggregate?.media).toHaveLength(2)
      }
    }
  })
})
