import { describe, expect, it } from 'vitest'

import { handleWorkAuthoringApi } from './work-authoring-api'
import { AuthoringService, InMemoryAuthoringObjectStore, InMemoryWorkAuthoringRepository } from './work-authoring'

function setup() {
  const repository = new InMemoryWorkAuthoringRepository()
  const service = new AuthoringService(repository, new InMemoryAuthoringObjectStore())
  return { repository, service }
}

describe('Work Authoring API boundary', () => {
  it('requires the Payload Admin session', async () => {
    const { service } = setup()
    const response = await handleWorkAuthoringApi(new Request('https://archive.test/api/work-authoring/v1/works', { method: 'POST' }), service)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('maps stale mutations to a conflict with the current aggregate', async () => {
    const { service } = setup()
    const created = await handleWorkAuthoringApi(
      new Request('https://archive.test/api/work-authoring/v1/works', {
        method: 'POST',
        body: JSON.stringify({ title: '作品', author: '作者' }),
        headers: { 'content-type': 'application/json' },
      }),
      service,
      { user: { id: 'editor-1' } },
    )
    expect(created.status).toBe(201)
    const aggregate = await created.json() as { workId: string; revision: string }
    const saved = await handleWorkAuthoringApi(
      new Request(`https://archive.test/api/work-authoring/v1/works/${aggregate.workId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ revision: aggregate.revision, title: '新标题', author: '作者', media: [] }),
        headers: { 'content-type': 'application/json' },
      }),
      service,
      { user: { id: 'editor-1' } },
    )
    const current = await saved.json() as { revision: string }
    const stale = await handleWorkAuthoringApi(
      new Request(`https://archive.test/api/work-authoring/v1/works/${aggregate.workId}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ revision: aggregate.revision, title: '过期', author: '作者', media: [] }),
        headers: { 'content-type': 'application/json' },
      }),
      service,
      { user: { id: 'editor-2' } },
    )
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'stale_revision', currentRevision: current.revision, aggregate: { revision: current.revision } } })
  })
})
