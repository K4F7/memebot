import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: Object.assign((...args: unknown[]) => args, { file: (...args: unknown[]) => args }) }
})

import { ArchiveService, KoishiArchiveMetadataRepository, LocalAttachmentStore, MemoryR2Store } from '../src/index'

const roots: string[] = []
const admin = { authority: 4 }
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), 'memebot-restore-')); roots.push(root); return root }

function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return { tables, model: {
    async create(name: string, data: any) { table(name).push({ ...data }); return data },
    async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(name: string, query: any, patch: any) { const row = table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (row) Object.assign(row, patch) },
    async remove(name: string, query: any) { const rows = table(name); for (let index = rows.length - 1; index >= 0; index--) if (Object.entries(query).every(([key, value]) => rows[index][key] === value)) rows.splice(index, 1) },
  } }
}

function manifest(kind: 'paper' | 'work', record: Record<string, unknown>, checksum: string, objectKey: string, appearances: Array<Record<string, unknown>> = []) {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    recordKind: kind,
    sequence: Number(String(record.id).slice(1)),
    record: {
      ...record,
      publishedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      lifecycle: 'active',
      attachment: { relativePath: String(objectKey).split('/').slice(1).join('/'), contentType: kind === 'paper' ? 'application/pdf' : 'application/zip', size: 16, checksum, r2: { objectKey, syncState: 'synced' } },
    },
    appearances,
  }))
}

describe('R2 manifest restoration', () => {
  it('previews and safely imports a missing Paper plus its attachment and audit record', async () => {
    const root = await tempRoot(); const ctx = fakeContext(); const r2 = new MemoryR2Store()
    const bytes = new TextEncoder().encode('%PDF-1.7\n%%EOF'); const checksum = createHash('sha256').update(bytes).digest('hex')
    r2.objects.set('club/P7/paper.pdf', bytes)
    r2.objects.set('club/manifests/paper/P7.json', manifest('paper', { id: 'P7', issueNumber: '7', month: '2026-07', title: 'July' }, checksum, 'club/P7/paper.pdf'))
    const metadata = new KoishiArchiveMetadataRepository(ctx as any)
    const service = new ArchiveService({ config: { localPath: root, r2: { enabled: true, objectPrefix: 'club' } as any }, metadata, r2, local: new LocalAttachmentStore(root, r2, 'club') })
    await service.initialize()

    const preview = await service.previewRestore(admin)
    expect(preview.counts).toMatchObject({ new: 1, changed: 0, conflicting: 0, missing: 1 })
    await service.restoreFromR2(admin)

    expect(service.getIssue('P7')?.title).toBe('July')
    expect(new Uint8Array(await readFile(join(root, 'P7', 'paper.pdf')))).toEqual(bytes)
    expect(ctx.tables.get('archiveSequence')).toContainEqual({ kind: 'paper', value: 7 })
    expect(ctx.tables.get('archiveBackupJob')?.[0]).toMatchObject({ recordKind: 'paper', recordId: 'P7', state: 'complete' })
    expect((await service.restoreHistory(admin))[0]).toMatchObject({ action: 'restore', result: 'complete' })
  })

  it('does not overwrite a conflict by default and rejects corrupt remote bytes without mutation', async () => {
    const root = await tempRoot(); const ctx = fakeContext(); const r2 = new MemoryR2Store(); const metadata = new KoishiArchiveMetadataRepository(ctx as any)
    const service = new ArchiveService({ config: { localPath: root, r2: { enabled: true, objectPrefix: 'club' } as any }, metadata, r2, local: new LocalAttachmentStore(root, r2, 'club') })
    await service.initialize()
    await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Local', attachment: { filename: 'local.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const wrongChecksum = createHash('sha256').update('expected').digest('hex')
    r2.objects.set('club/P1/remote.pdf', new TextEncoder().encode('corrupt'))
    r2.objects.set('club/manifests/paper/P1.json', manifest('paper', { id: 'P1', issueNumber: '8', month: '2026-08', title: 'Remote' }, wrongChecksum, 'club/P1/remote.pdf'))

    expect((await service.previewRestore(admin)).counts.conflicting).toBe(1)
    await service.restoreFromR2(admin)
    expect(service.getIssue('P1')?.title).toBe('Local')
    await expect(service.restoreFromR2(admin, [{ recordKind: 'paper', recordId: 'P1', decision: 'r2' }])).rejects.toThrow('checksum')
    expect(service.getIssue('P1')?.title).toBe('Local')
    expect((await service.restoreHistory(admin))[0].result).toBe('failed')
  })

  it('restores Work metadata and returns a no-op preview when R2 has no manifests', async () => {
    const root = await tempRoot(); const empty = new MemoryR2Store(); const emptyService = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(fakeContext() as any), r2: empty })
    await emptyService.initialize()
    expect((await emptyService.previewRestore(admin)).counts).toEqual({ new: 0, changed: 0, conflicting: 0, missing: 0 })
    expect((await emptyService.restoreHistory(admin))[0]).toMatchObject({ action: 'preview', result: 'complete' })

    const ctx = fakeContext(); const r2 = new MemoryR2Store(); const bytes = new TextEncoder().encode('work package'); const checksum = createHash('sha256').update(bytes).digest('hex')
    const paperBytes = new TextEncoder().encode('%PDF-1.7\n%%EOF'); const paperChecksum = createHash('sha256').update(paperBytes).digest('hex')
    const appearance = { paperId: 'P3', workId: 'W4', page: '9', section: 'Features', displayOrder: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }
    r2.objects.set('memebot-archive/W4/work.zip', bytes)
    r2.objects.set('memebot-archive/P3/paper.pdf', paperBytes)
    r2.objects.set('memebot-archive/manifests/work/W4.json', manifest('work', { id: 'W4', title: 'Recovered Work', author: 'Author', description: 'From R2' }, checksum, 'memebot-archive/W4/work.zip', [appearance]))
    r2.objects.set('memebot-archive/manifests/paper/P3.json', manifest('paper', { id: 'P3', issueNumber: '3', month: '2026-03', title: 'Recovered Paper' }, paperChecksum, 'memebot-archive/P3/paper.pdf', [appearance]))
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(ctx as any), r2 }); await service.initialize(); await service.restoreFromR2(admin)
    expect(service.getWork('W4')).toMatchObject({ title: 'Recovered Work', author: 'Author', backupState: 'complete' })
    expect(service.getPaperDetails('P3')?.works[0]).toMatchObject({ page: '9', section: 'Features', work: { id: 'W4' } })
  })

  it('validates every selected object before importing any metadata', async () => {
    const root = await tempRoot(); const ctx = fakeContext(); const r2 = new MemoryR2Store(); const checksum = createHash('sha256').update('first').digest('hex')
    r2.objects.set('memebot-archive/P1/one.pdf', new TextEncoder().encode('first'))
    r2.objects.set('memebot-archive/manifests/paper/P1.json', manifest('paper', { id: 'P1', issueNumber: '1', month: '2026-01', title: 'One' }, checksum, 'memebot-archive/P1/one.pdf'))
    r2.objects.set('memebot-archive/manifests/paper/P2.json', manifest('paper', { id: 'P2', issueNumber: '2', month: '2026-02', title: 'Two' }, checksum, 'memebot-archive/P2/two.pdf'))
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(ctx as any), r2 }); await service.initialize()
    await expect(service.restoreFromR2(admin)).rejects.toThrow('missing')
    expect(service.getIssue('P1')).toBeUndefined()
    expect(service.getIssue('P2')).toBeUndefined()
  })

  it('restores manifests written before the versioned recovery format', async () => {
    const root = await tempRoot(); const ctx = fakeContext(); const r2 = new MemoryR2Store(); const bytes = new TextEncoder().encode('%PDF-1.7\n%%EOF'); const checksum = createHash('sha256').update(bytes).digest('hex')
    r2.objects.set('memebot-archive/P8/legacy.pdf', bytes)
    r2.objects.set('memebot-archive/manifests/paper/P8.json', new TextEncoder().encode(JSON.stringify({ id: 'P8', issueNumber: '8', month: '2026-08', title: 'Legacy', publishedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', lifecycle: 'active', attachment: { relativePath: 'P8/legacy.pdf', contentType: 'application/pdf', size: bytes.byteLength, checksum } })))
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(ctx as any), r2 }); await service.initialize(); await service.restoreFromR2(admin)
    expect(service.getIssue('P8')?.title).toBe('Legacy')
  })

  it('rolls back a staged overwrite when the metadata transaction fails', async () => {
    const root = await tempRoot(); const ctx = fakeContext(); const r2 = new MemoryR2Store(); const metadata = new KoishiArchiveMetadataRepository(ctx as any)
    const service = new ArchiveService({ config: { localPath: root }, metadata, r2 }); await service.initialize()
    const original = new TextEncoder().encode('%PDF-1.7\nlocal\n%%EOF')
    const paper = await service.publishIssue(admin, { month: '2026-01', issueNumber: '1', title: 'Local', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: original } })
    const remote = new TextEncoder().encode('%PDF-1.7\nremote\n%%EOF'); const checksum = createHash('sha256').update(remote).digest('hex'); const objectKey = paper.attachment!.r2!.objectKey
    r2.objects.set(objectKey, remote)
    r2.objects.set('memebot-archive/manifests/paper/P1.json', manifest('paper', { id: 'P1', issueNumber: '1', month: '2026-01', title: 'Remote' }, checksum, objectKey))
    const set = ctx.model.set.bind(ctx.model); ctx.model.set = async (name: string, query: any, patch: any) => { if (name === 'archivePaper') throw new Error('database unavailable'); return set(name, query, patch) }
    await expect(service.restoreFromR2(admin, [{ recordKind: 'paper', recordId: 'P1', decision: 'r2' }])).rejects.toThrow('database unavailable')
    expect(new Uint8Array(await readFile(join(root, paper.attachment!.relativePath)))).toEqual(original)
    expect(service.getIssue('P1')?.title).toBe('Local')
  })
})
