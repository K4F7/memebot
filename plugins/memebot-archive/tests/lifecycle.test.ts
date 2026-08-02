import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: Object.assign((...args: unknown[]) => args, { file: (...args: unknown[]) => args }) }
})

import { ArchiveService, KoishiArchiveMetadataRepository, LocalAttachmentStore, MemoryR2Store, PersistentArchiveCleanupQueue } from '../src/index'

const roots: string[] = []
const admin = { userId: 'owner', authority: 4 }
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), 'memebot-lifecycle-')); roots.push(root); return root }

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

function crc32(data: Uint8Array) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }; return (crc ^ 0xffffffff) >>> 0 }
function zip(content = 'hello') {
  const name = Buffer.from('README.txt'); const raw = Buffer.from(content); const compressed = deflateRawSync(raw); const crc = crc32(raw)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return new Uint8Array(Buffer.concat([local, name, compressed, central, name, end]))
}

describe('Archive removal and recovery lifecycle', () => {
  it('keeps destructive confirmation inside the domain after authorization at the entry boundary', async () => {
    const root = await tempRoot(); const service = new ArchiveService({ config: { localPath: root } })
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    await expect(service.removeIssue(admin, paper.id, '确认')).rejects.toThrow('exact Y')
    await service.removeIssue(admin, paper.id, 'Y')
    expect(service.listRemoved(admin)).toEqual([expect.objectContaining({ id: paper.id, lifecycle: 'removed' })])
  })

  it('hides a removed Work, preserves its Paper appearance, and restores the original identifier', async () => {
    const root = await tempRoot(); const context = fakeContext(); let now = new Date('2026-08-02T00:00:00Z')
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any), now: () => now })
    await service.initialize()
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const work = await service.publishWork(admin, { title: 'Published Work', author: 'Alice', attachment: { filename: 'work.zip', contentType: 'application/zip', data: zip() } })
    await service.associateWork(admin, paper.id, { workId: work.id, page: '3' })

    await service.removeWork(admin, work.id, 'Y')

    expect(service.getWork(work.id)).toBeUndefined()
    expect(service.searchWorks({ text: 'Published' })).toEqual([])
    expect(service.getPaperDetails(paper.id)?.works).toEqual([{ work: { id: 'W1', title: 'Published Work', author: 'Alice', lifecycle: 'removed' }, page: '3', section: undefined, displayOrder: 1, unavailable: true }])
    expect(service.listRemoved(admin)).toEqual([expect.objectContaining({ id: 'W1', kind: 'work', removedAt: now, expiresAt: new Date('2026-09-01T00:00:00Z') })])

    now = new Date('2026-08-03T00:00:00Z')
    await service.restoreRecord(admin, work.id)
    expect(service.getWork(work.id)?.id).toBe('W1')
    expect(service.getPaperDetails(paper.id)?.works[0]).toMatchObject({ work: { id: 'W1' }, page: '3' })
  })

  it('purges local bytes while failed R2 deletion remains durable retry work', async () => {
    const root = await tempRoot(); const context = fakeContext(); let remoteAvailable = false
    const r2 = new MemoryR2Store()
    const remove = r2.delete.bind(r2)
    r2.delete = async (key: string) => { if (!remoteAvailable) throw new Error('R2 unavailable'); await remove(key) }
    const local = new LocalAttachmentStore(root, r2)
    const cleanup = new PersistentArchiveCleanupQueue(context as any, r2)
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any), local, r2, cleanupQueue: cleanup })
    await service.initialize()
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const attachment = paper.attachment!
    await service.removeIssue(admin, paper.id, 'Y')

    const purged = await service.purgeRecord(admin, paper.id, 'Y')

    expect(purged).toMatchObject({ id: 'P1', lifecycle: 'purged', attachment: undefined })
    expect(await local.exists(attachment)).toBe(false)
    expect(await cleanup.counts()).toEqual({ pending: 0, failed: 1, complete: 0 })

    remoteAvailable = true
    await cleanup.retryNow(paper.id)
    expect(await cleanup.counts()).toEqual({ pending: 0, failed: 0, complete: 1 })
    expect(r2.objects.has(attachment.r2!.objectKey)).toBe(false)
  })

  it('retires a replaced attachment for 30 days and can restore the prior version', async () => {
    const root = await tempRoot(); const context = fakeContext(); let now = new Date('2026-08-02T00:00:00Z')
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any), now: () => now })
    await service.initialize()
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\noriginal\n%%EOF' } })
    const originalPath = paper.attachment!.relativePath

    now = new Date('2026-08-03T00:00:00Z')
    await service.replaceIssueAttachment(admin, paper.id, { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\nreplacement\n%%EOF' })

    expect(paper.attachment!.relativePath).not.toBe(originalPath)
    const [retired] = service.listRetiredAttachments(admin, paper.id)
    expect(retired).toMatchObject({ recordId: 'P1', removedAt: now, expiresAt: new Date('2026-09-02T00:00:00Z'), attachment: { relativePath: originalPath } })

    await service.restoreRetiredAttachment(admin, retired.id)
    expect(new TextDecoder().decode((await service.recover(paper))!)).toContain('original')
    expect(service.listRetiredAttachments(admin, paper.id)).toHaveLength(1)
  })

  it('restores a retired Work Package and rebuilds its preview', async () => {
    const root = await tempRoot(); const context = fakeContext(); let now = new Date('2026-08-02T00:00:00Z')
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any), now: () => now })
    await service.initialize()
    const work = await service.publishWork(admin, { title: 'Versioned Work', author: 'Alice', attachment: { filename: 'work.zip', contentType: 'application/zip', data: zip('original') } })

    now = new Date('2026-08-03T00:00:00Z')
    await service.replaceWorkAttachment(admin, work.id, { filename: 'work.zip', contentType: 'application/zip', data: zip('replacement') })
    expect((await service.previews.preview(work.id, 'README.txt')).text).toBe('replacement')

    const retired = service.listRetiredAttachments(admin, work.id)[0]
    await service.restoreRetiredAttachment(admin, retired.id)
    expect((await service.previews.preview(work.id, 'README.txt')).text).toBe('original')
  })

  it('keeps historical identity after purge until a separate anonymization action', async () => {
    const root = await tempRoot(); const context = fakeContext()
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any) })
    await service.initialize()
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const work = await service.publishWork(admin, { title: 'Personal Essay', author: 'Alice', description: 'Biography', attachment: { filename: 'work.zip', contentType: 'application/zip', data: zip() } })
    await service.associateWork(admin, paper.id, { workId: work.id })
    await service.removeWork(admin, work.id, 'Y')
    await service.purgeRecord(admin, work.id, 'Y')

    expect(service.getPaperDetails(paper.id)?.works[0].work).toMatchObject({ id: 'W1', title: 'Personal Essay', author: 'Alice', lifecycle: 'purged' })

    await service.anonymizeRecord(admin, work.id, 'Y')
    expect(service.getPaperDetails(paper.id)?.works[0].work).toMatchObject({ id: 'W1', title: 'Personal Essay', author: '已匿名' })
    expect(await service.lifecycleHistory(admin, work.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'remove' }), expect.objectContaining({ action: 'purge' }), expect.objectContaining({ action: 'anonymize' }),
    ]))
  })

  it('expires removed records and retired attachment versions without reusing identifiers', async () => {
    const root = await tempRoot(); const context = fakeContext(); let now = new Date('2026-08-02T00:00:00Z')
    const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(context as any), now: () => now })
    await service.initialize()
    const first = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'First', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\nfirst\n%%EOF' } })
    await service.replaceIssueAttachment(admin, first.id, { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\nsecond\n%%EOF' })
    const retired = service.listRetiredAttachments(admin, first.id)[0]
    await service.removeIssue(admin, first.id, 'Y')

    now = new Date('2026-09-02T00:00:01Z')
    await service.purgeExpired()

    expect(service.listRemoved(admin)).toEqual([expect.objectContaining({ id: 'P1', lifecycle: 'purged' })])
    expect(service.listRetiredAttachments(admin, first.id)).toEqual([])
    expect(await service.local.exists(retired.attachment)).toBe(false)
    await service.restoreRecord(admin, first.id).then(() => { throw new Error('purged record restored') }, error => expect(String(error)).toContain('not found'))
    const second = await service.publishIssue(admin, { month: '2026-09', issueNumber: '9', title: 'Second', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\nsecond\n%%EOF' } })
    expect(second.id).toBe('P2')
  })
})
