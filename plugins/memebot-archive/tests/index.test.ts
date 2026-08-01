import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => {
    const value: Record<string, unknown> = {}
    for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value
    return value
  }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain } }
})

import { ArchiveConsoleFeatures, ArchiveService, KoishiArchiveMetadataRepository, MemoryR2Store } from '../src/index'

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
  it('registers the visible Console entry and complete Paper RPC surface', async () => {
    const root = await tempRoot()
    const listeners: string[] = []
    const entries: unknown[] = []
    const ctx = { console: { addEntry(entry: unknown) { entries.push(entry) }, addListener(name: string) { listeners.push(name) } } } as any
    new ArchiveConsoleFeatures(ctx, new ArchiveService({ config: { localPath: root } }), Promise.resolve()).register()
    expect(entries).toHaveLength(1)
    expect(listeners).toEqual(expect.arrayContaining([
      'memebot/archive/papers', 'memebot/archive/paper/create', 'memebot/archive/paper/upload',
      'memebot/archive/paper/preview', 'memebot/archive/paper/edit', 'memebot/archive/paper/download',
    ]))
  })
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
      month: '2026-08', issueNumber: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' },
    })
    expect(issue.attachment?.r2?.syncState).toBe('failed')
    expect(issue.id).toBe('P1')
    await service.retryPending()
    expect(issue.attachment?.r2?.syncState).toBe('synced')
    expect(attempts).toBe(2)
  })

  it('recovers a missing local attachment from R2', async () => {
    const root = await tempRoot()
    const r2 = new MemoryR2Store()
    const service = new ArchiveService({ config: { localPath: root }, r2 })
    const issue = await service.publishIssue(admin, {
      month: '2026-08', issueNumber: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' },
    })
    await unlink(join(root, issue.attachment!.relativePath))
    expect(Array.from(await service.recover(issue))).toEqual(Array.from(new TextEncoder().encode('%PDF-1.7\n%%EOF')))
  })

  it('falls back from forward delivery to ordinary delivery', async () => {
    const root = await tempRoot()
    const service = new ArchiveService({ config: { localPath: root } })
    const issue = await service.publishIssue(admin, {
      month: '2026-08', issueNumber: '2026-08', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' },
    })
    const calls: string[] = []
    await service.sendIssue({}, issue.id, {
      async forward() { throw new Error('forward-message unavailable') },
      async ordinary(_session, item) { calls.push(item.id) },
    })
    expect(calls).toEqual([issue.id])
    expect(service.fallbackEvents[0].reason).toBe('forward-message unavailable or failed')
  })

  it('validates complete Paper metadata and the configured upload limit', async () => {
    const root = await tempRoot()
    const service = new ArchiveService({ config: { localPath: root, paperMaxMb: 0.000001 } })
    await expect(service.publishIssue(admin, {
      month: 'August', issueNumber: '8', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' },
    })).rejects.toThrow('YYYY-MM')
    await expect(service.publishIssue(admin, {
      month: '2026-08', issueNumber: '8', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' },
    })).rejects.toThrow('大小')
    const normal = new ArchiveService({ config: { localPath: root } })
    await expect(normal.publishIssue(admin, {
      month: '2026-08', issueNumber: '8', title: 'August',
      attachment: { filename: 'fake.pdf', contentType: 'application/pdf', data: 'not a PDF' },
    })).rejects.toThrow('valid PDF')
  })

  it('continues Paper identifiers and metadata across service restarts', async () => {
    const root = await tempRoot()
    const tables = new Map<string, any[]>()
    const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
    const ctx = { model: {
      async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
      async create(name: string, data: any) { table(name).push({ ...data }); return data },
      async set(name: string, query: any, patch: any) { Object.assign(table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)), patch) },
    } } as any
    const first = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(ctx) })
    await first.initialize()
    await first.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'August', attachment: { filename: 'a.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const restarted = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(ctx) })
    await restarted.initialize()
    const paper = await restarted.publishIssue(admin, { month: '2026-09', issueNumber: '9', title: 'September', attachment: { filename: 'b.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    expect(paper.id).toBe('P2')
    expect(restarted.getIssue('p1')?.title).toBe('August')
  })
})
