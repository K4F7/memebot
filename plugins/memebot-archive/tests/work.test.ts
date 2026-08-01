import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: Object.assign((...args: unknown[]) => args, { file: (...args: unknown[]) => args }) }
})

import { ArchiveService, KoishiArchiveMetadataRepository, WorkPreviewStore } from '../src/index'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
async function tempRoot() { const root = await mkdtemp(join(tmpdir(), 'memebot-work-')); roots.push(root); return root }

function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries: Array<{ name: string; data?: string; flags?: number; external?: number }>) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const raw = Buffer.from(entry.data ?? ''); const compressed = deflateRawSync(raw); const crc = crc32(raw)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((entry.external ?? 0) >>> 0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, name); offset += local.length + name.length + compressed.length
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]))
}
function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return { model: {
    async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async create(name: string, data: any) { table(name).push({ ...data }); return data },
    async set(name: string, query: any, patch: any) { const row = table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (row) Object.assign(row, patch) },
  } }
}

describe('work packages and previews', () => {
  it('persists W identifiers and submits the authoritative ZIP through the injected backup boundary', async () => {
    const root = await tempRoot(); const ctx = fakeContext() as any; const enqueued: string[] = []
    const metadata = new KoishiArchiveMetadataRepository(ctx)
    const service = new ArchiveService({ config: { localPath: root }, metadata, backupQueue: { async enqueue(attachment) { enqueued.push(attachment.relativePath) } } })
    await service.initialize()
    const work = await service.publishWork({ authority: 4 }, { title: '作品', author: '作者', description: '说明', attachment: { filename: 'work.zip', contentType: 'application/zip', data: zip([{ name: 'README.txt', data: 'hello' }]) } })
    expect(work.id).toBe('W1'); expect(enqueued).toEqual(['W1/work.zip'])
    const restarted = new ArchiveService({ config: { localPath: root }, metadata }); await restarted.initialize()
    expect(restarted.getWork('w1')?.title).toBe('作品')
    expect(restarted.searchWorks({ text: '作者' })[0].id).toBe('W1')
  })

  it('extracts a confined tree and classifies safe previews without executing web content', async () => {
    const root = await tempRoot(); const previews = new WorkPreviewStore(root)
    const tree = await previews.build('W1', zip([{ name: 'README.txt', data: 'hello' }, { name: 'site/index.html', data: '<script>alert(1)</script>' }, { name: 'run.exe', data: 'MZ' }]))
    expect(tree.map(item => item.path)).toEqual(['README.txt', 'site/index.html', 'run.exe'])
    expect((await previews.preview('W1', 'README.txt')).text).toBe('hello')
    expect((await previews.preview('W1', 'site/index.html')).sandbox).toBe('allow-downloads')
    expect((await previews.preview('W1', 'run.exe')).previewable).toBe(false)
  })

  it.each([
    ['traversal', [{ name: '../escape.txt', data: 'bad' }], '路径'],
    ['absolute path', [{ name: '/escape.txt', data: 'bad' }], '路径'],
    ['encrypted entry', [{ name: 'secret.txt', data: 'bad', flags: 1 }], '加密'],
    ['symlink', [{ name: 'link', data: 'target', external: 0o120777 << 16 }], '符号链接'],
  ])('rejects %s', async (_label, entries, message) => {
    const root = await tempRoot(); await expect(new WorkPreviewStore(root).build('W1', zip(entries))).rejects.toThrow(message)
  })

  it('rejects more than 2000 entries', async () => {
    const root = await tempRoot(); const entries = Array.from({ length: 2001 }, (_, index) => ({ name: `${index}.txt`, data: '' }))
    await expect(new WorkPreviewStore(root).build('W1', zip(entries))).rejects.toThrow('2000')
  })
})
