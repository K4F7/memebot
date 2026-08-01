import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain } }
})

import { countDraft, draftKey, IntakeAttachmentStore, IntakeDraftService, IntakeService, canTransition, isAdmin } from '../src/index'

function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return { model: {
    async create(name: string, data: any) { table(name).push({ ...data }); return data },
    async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(name: string, query: any, patch: any) { Object.assign(table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)), patch) },
    async remove(name: string, query: any) { const rows = table(name); const index = rows.findIndex(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (index >= 0) rows.splice(index, 1) },
  } }
}

describe('intake workflows', () => {
  it('isolates draft keys by QQ user and conversation', () => {
    expect(draftKey('10001', 'qq:group:20001')).toBe('10001\u0000qq:group:20001')
    expect(draftKey('10002', 'qq:group:20001')).not.toBe(draftKey('10001', 'qq:group:20001'))
    expect(draftKey('10001', 'qq:private:10001')).not.toBe(draftKey('10001', 'qq:group:20001'))
  })

  it('counts messages, images, and other attachments independently', () => {
    expect(countDraft({ messages: [
      { body: '文字', createdAt: 1, attachments: [{ type: 'img' }, { type: 'file' }] },
      { body: '', createdAt: 2, attachments: [{ type: 'img' }] },
    ] })).toEqual({ messages: 2, images: 2, attachments: 1 })
  })
  it('persists all three intake types with stable numbers', async () => {
    const service = new IntakeService(fakeContext() as any, () => new Date('2026-01-01T00:00:00Z'))
    const submission = await service.create({ type: 'submission', submitterId: 'u1', sourceSession: 'qq:g1', body: '投稿', attachments: [] })
    const feedback = await service.create({ type: 'feedback', submitterId: 'u2', sourceSession: 'qq:u2', body: '反馈', attachments: [] })
    expect(submission.id).toBe('投稿#1'); expect(feedback.id).toBe('反馈#1'); expect((await service.get(submission.id))?.status).toBe('pending-review'); expect((await service.get(feedback.id))?.status).toBe('pending')
    expect((await service.create({ type: 'feedback', submitterId: 'u3', sourceSession: 'qq:u3', body: '另一个反馈', attachments: [] })).id).toBe('反馈#2')
  })

  it('continues a persisted multi-message draft after service restart', async () => {
    const ctx = fakeContext() as any
    let now = new Date('2026-01-01T00:00:00Z')
    const records = new IntakeService(ctx, () => now)
    const first = new IntakeDraftService(ctx, records, new IntakeAttachmentStore('unused'), () => now)
    await first.start('suggestion', 'u1', 'qq:g1')
    expect(await first.append('u1', 'qq:g1', '第一条', [])).toEqual({ messages: 1, images: 0, attachments: 0 })
    now = new Date('2026-01-01T00:05:00Z')
    const restarted = new IntakeDraftService(ctx, records, new IntakeAttachmentStore('unused'), () => now)
    expect(await restarted.append('u1', 'qq:g1', '第二条', [])).toEqual({ messages: 2, images: 0, attachments: 0 })
    const record = await restarted.submit('u1', 'qq:g1')
    expect(record.body).toBe('第一条\n\n第二条')
    expect(record.id).toBe('建议#1')
  })

  it('expires a draft after thirty minutes of inactivity', async () => {
    const ctx = fakeContext() as any
    let now = new Date('2026-01-01T00:00:00Z')
    const drafts = new IntakeDraftService(ctx, new IntakeService(ctx, () => now), new IntakeAttachmentStore('unused'), () => now)
    await drafts.start('feedback', 'u1', 'qq:g1')
    now = new Date('2026-01-01T00:30:00.001Z')
    expect(await drafts.get('u1', 'qq:g1')).toBeUndefined()
  })

  it('keeps drafts isolated and cancellation affects only the selected conversation', async () => {
    const ctx = fakeContext() as any
    const records = new IntakeService(ctx)
    const drafts = new IntakeDraftService(ctx, records, new IntakeAttachmentStore('unused'))
    await drafts.start('feedback', 'u1', 'qq:group:g1')
    await drafts.start('suggestion', 'u1', 'qq:private:u1')
    await drafts.start('submission', 'u2', 'qq:group:g1')
    expect(await drafts.cancel('u1', 'qq:group:g1')).toBe(true)
    expect(await drafts.get('u1', 'qq:group:g1')).toBeUndefined()
    expect((await drafts.get('u1', 'qq:private:u1'))?.type).toBe('suggestion')
    expect((await drafts.get('u2', 'qq:group:g1'))?.type).toBe('submission')
  })

  it('copies temporary attachment URLs into independent local storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memebot-intake-'))
    try {
      const stored = await new IntakeAttachmentStore(root).copy(
        { url: 'data:text/plain;base64,aGVsbG8=', name: 'note.txt', type: 'file' },
        { submitterId: 'u1', sourceSession: 'qq:g1' },
      )
      expect(stored.url).toBeUndefined()
      expect(stored.size).toBe(5)
      expect(await readFile(join(root, stored.relativePath!), 'utf8')).toBe('hello')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('enforces transitions and preserves notes', async () => {
    const service = new IntakeService(fakeContext() as any)
    const record = await service.create({ type: 'feedback', submitterId: 'u1', sourceSession: 'qq:u1', body: '反馈', attachments: [] })
    await expect(service.updateStatus(record.id, 'resolved')).rejects.toThrow('不允许从 pending 变更为 resolved')
    await service.updateStatus(record.id, 'processing'); await service.addNote(record.id, '已联系提交者'); const updated = await service.updateStatus(record.id, 'resolved'); expect(updated.notes).toEqual(['已联系提交者'])
  })

  it('supports close and reopen for review decisions', async () => {
    const service = new IntakeService(fakeContext() as any); const record = await service.create({ type: 'submission', submitterId: 'u1', sourceSession: 'qq:u1', body: '投稿', attachments: [] })
    await service.updateStatus(record.id, 'approved'); await service.updateStatus(record.id, 'closed'); expect((await service.updateStatus(record.id, 'pending-review')).status).toBe('pending-review')
  })

  it('accepts authority or configured user/group administration', () => {
    const config = { targets: { submission: {}, feedback: {}, suggestion: {} }, administrators: [{ qq: 'u1' }], managementGroups: [{ qq: 'g1' }], attachmentPath: 'data' }
    expect(isAdmin({ userId: 'other', user: { authority: 4 } }, config)).toBe(true); expect(isAdmin({ userId: 'u1', user: { authority: 0 } }, config)).toBe(true); expect(isAdmin({ guildId: 'g1', user: { authority: 0 } }, config)).toBe(false); expect(isAdmin({ userId: 'other', guildId: 'other', user: { authority: 3 } }, config)).toBe(false); expect(canTransition('suggestion', 'closed', 'pending-review')).toBe(true)
  })
})
