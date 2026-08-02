import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: Object.assign((...args: unknown[]) => args, { file: (...args: unknown[]) => args }) }
})

import { ArchiveService, KoishiArchiveMetadataRepository } from '../src/index'

const roots: string[] = []; const admin = { authority: 4 }
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), 'memebot-appearances-')); roots.push(root); return root }
function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return { model: {
    async create(name: string, data: any) { table(name).push({ ...data }); return data },
    async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(name: string, query: any, patch: any) { const row = table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (row) Object.assign(row, patch) },
    async remove(name: string, query: any) { const rows = table(name); for (let index = rows.length - 1; index >= 0; index--) if (Object.entries(query).every(([key, value]) => rows[index][key] === value)) rows.splice(index, 1) },
  } }
}
function crc32(data: Uint8Array) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }; return (crc ^ 0xffffffff) >>> 0 }
function zip() {
  const name = Buffer.from('README.txt'); const raw = Buffer.from('hello'); const compressed = deflateRawSync(raw); const crc = crc32(raw)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return new Uint8Array(Buffer.concat([local, name, compressed, central, name, end]))
}

describe('Publication Appearances', () => {
  it('persists ordered many-to-many relationships and exposes both navigation directions', async () => {
    const root = await tempRoot(); const metadata = new KoishiArchiveMetadataRepository(fakeContext() as any)
    const first = new ArchiveService({ config: { localPath: root }, metadata }); await first.initialize()
    const paper = await first.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const secondPaper = await first.publishIssue(admin, { month: '2026-09', issueNumber: '9', title: 'Next Issue', attachment: { filename: 'next.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const one = await first.publishWork(admin, { title: 'One', author: 'Alice', description: 'alpha', attachment: { filename: 'one.zip', contentType: 'application/zip', data: zip() } })
    const two = await first.publishWork(admin, { title: 'Two', author: 'Bob', description: 'beta', attachment: { filename: 'two.zip', contentType: 'application/zip', data: zip() } })
    await first.associateWork(admin, paper.id, { workId: two.id, section: 'Poetry', displayOrder: 2 })
    await first.associateWork(admin, paper.id, { workId: one.id, page: '3', displayOrder: 1 })
    await first.associateWork(admin, secondPaper.id, { workId: one.id, section: 'Encore', displayOrder: 1 })

    expect(first.getPaperDetails(paper.id)?.works.map(item => [item.work.id, item.page, item.section])).toEqual([[one.id, '3', undefined], [two.id, undefined, 'Poetry']])
    expect(first.getWorkDetails(one.id)?.papers.map(item => item.paper.id)).toEqual([secondPaper.id, paper.id])
    expect(first.searchIssues('Alice').map(item => item.id)).toEqual([secondPaper.id, paper.id])
    expect(first.paperDetailText(paper.id)).toContain('W1 Alice - One · 第3页')
    expect(first.workDetailText(one.id)).toContain('P1 2026-08 Issue · 第3页')

    const restarted = new ArchiveService({ config: { localPath: root }, metadata }); await restarted.initialize()
    expect(restarted.getPaperDetails(paper.id)?.works.map(item => item.work.id)).toEqual([one.id, two.id])
    expect(restarted.getWorkDetails(one.id)?.papers).toHaveLength(2)
  })

  it('can create a complete Work while associating it after boundary authorization', async () => {
    const root = await tempRoot(); const service = new ArchiveService({ config: { localPath: root }, metadata: new KoishiArchiveMetadataRepository(fakeContext() as any) }); await service.initialize()
    const paper = await service.publishIssue(admin, { month: '2026-08', issueNumber: '8', title: 'Issue', attachment: { filename: 'paper.pdf', contentType: 'application/pdf', data: '%PDF-1.7\n%%EOF' } })
    const appearance = await service.associateWork(admin, paper.id, { work: { title: 'Created', author: 'Author', attachment: { filename: 'created.zip', contentType: 'application/zip', data: zip() } }, page: '12' })
    expect(appearance.workId).toBe('W1')
    expect(service.getPaperDetails(paper.id)?.works[0].work.title).toBe('Created')
  })
})
