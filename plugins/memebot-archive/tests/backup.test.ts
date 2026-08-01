import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: Object.assign((...args: unknown[]) => args, { file: (...args: unknown[]) => args }) }
})

import { ArchivePreflight, LocalAttachmentStore, PersistentArchiveBackupQueue } from '../src/index'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), 'memebot-archive-backup-')); roots.push(root); return root }

function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return { model: {
    async create(name: string, data: any) { table(name).push({ ...data }); return data },
    async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(name: string, query: any, patch: any) { const row = table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (row) Object.assign(row, patch) },
    async remove(name: string, query: any) { const rows = table(name); for (let i = rows.length - 1; i >= 0; i--) if (Object.entries(query).every(([key, value]) => rows[i][key] === value)) rows.splice(i, 1) },
  } }
}

describe('archive preflight and persistent backup', () => {
  it('reports ready, degraded, and unavailable without exposing credentials', async () => {
    const root = await tempRoot()
    let diagnostic: Uint8Array | undefined
    const healthy = { async put(_key: string, data: Uint8Array) { diagnostic = data }, async get() { return diagnostic }, async delete() { diagnostic = undefined } }
    expect((await new ArchivePreflight(root, healthy).check()).state).toBe('ready')
    const brokenR2 = { async put() { throw new Error('credential abc-secret rejected') }, async get() { return undefined }, async delete() {} }
    const degraded = await new ArchivePreflight(root, brokenR2, ['abc-secret']).check()
    expect(degraded.state).toBe('degraded')
    expect(JSON.stringify(degraded)).not.toContain('abc-secret')
    const unavailable = await new ArchivePreflight(join(root, 'not-a-directory', 'nested'), undefined, [], async () => { throw new Error('local denied') }).check()
    expect(unavailable.state).toBe('unavailable')
  })

  it('persists attachment and manifest work, resumes after one minute, then reports complete', async () => {
    const root = await tempRoot()
    const ctx = fakeContext() as any
    let now = new Date('2026-08-02T00:00:00Z')
    let attempts = 0
    const objects = new Map<string, Uint8Array>()
    const r2 = {
      async put(key: string, data: Uint8Array) { attempts += 1; if (attempts === 1) throw new Error('offline'); objects.set(key, data) },
      async get(key: string) { return objects.get(key) },
      async delete(key: string) { objects.delete(key) },
    }
    const local = new LocalAttachmentStore(root, r2, 'club')
    const attachment = await local.save('P1', { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' })
    const states: string[] = []
    const queue = new PersistentArchiveBackupQueue(ctx, local, r2, { update: async (_kind, _id, state) => { states.push(state) } }, () => now)
    await queue.enqueue(attachment, { recordKind: 'paper', recordId: 'P1', manifest: { id: 'P1', title: 'Paper' } })
    await queue.runDue()
    expect((await queue.counts()).failed).toBe(1)

    now = new Date('2026-08-02T00:01:00Z')
    const restarted = new PersistentArchiveBackupQueue(ctx, local, r2, { update: async (_kind, _id, state) => { states.push(state) } }, () => now)
    await restarted.runDue()
    expect(await restarted.counts()).toEqual({ pending: 0, failed: 0, complete: 1 })
    expect(objects.has('club/P1/paper.pdf')).toBe(true)
    expect(objects.has('club/manifests/paper/P1.json')).toBe(true)
    expect(states.at(-1)).toBe('complete')
  })
})
