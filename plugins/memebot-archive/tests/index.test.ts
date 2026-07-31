import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => {
    const value: Record<string, unknown> = {}
    for (const method of ['default', 'description', 'min', 'max']) value[method] = () => value
    return value
  }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain } }
})

import { ArchiveService, MemoryR2Store } from '../src/index'

const admin = { userId: 'owner', authority: 4 }
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'memebot-archive-'))
  roots.push(root)
  return root
}

describe('archive integration paths', () => {
  it('keeps R2 failures retryable and eventually syncs', async () => {
    const root = await tempRoot()
    let attempts = 0
    const r2 = {
      data: undefined as Uint8Array | undefined,
      async put(_key: string, data: Uint8Array) {
        attempts += 1
        if (attempts === 1) throw new Error('R2 unavailable')
        this.data = data
      },
      async get() { return this.data },
    }
    const service = new ArchiveService({ config: { localPath: root }, r2 })
    const issue = await service.publishIssue(admin, {
      month: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: 'pdf' },
    })
    expect(issue.attachment?.r2?.syncState).toBe('failed')
    await service.retryPending()
    expect(issue.attachment?.r2?.syncState).toBe('synced')
    expect(attempts).toBe(2)
  })

  it('recovers a missing local attachment from R2', async () => {
    const root = await tempRoot()
    const r2 = new MemoryR2Store()
    const service = new ArchiveService({ config: { localPath: root }, r2 })
    const issue = await service.publishIssue(admin, {
      month: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: 'pdf' },
    })
    await unlink(join(root, issue.attachment!.relativePath))
    expect(Array.from(await service.recover(issue))).toEqual(Array.from(new TextEncoder().encode('pdf')))
  })

  it('falls back from forward delivery to ordinary delivery', async () => {
    const root = await tempRoot()
    const service = new ArchiveService({ config: { localPath: root } })
    const issue = await service.publishIssue(admin, {
      month: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: 'pdf' },
    })
    const calls: string[] = []
    await service.sendIssue({}, issue.id, {
      async forward() { throw new Error('forward-message unavailable') },
      async ordinary(_session, item) { calls.push(item.id) },
    })
    expect(calls).toEqual([issue.id])
    expect(service.fallbackEvents[0].reason).toBe('forward-message unavailable or failed')
  })
})
