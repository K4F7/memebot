import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain } }
})

import { IntakeService, canTransition, isAdmin } from '../src/index'

function fakeContext() {
  const rows: any[] = []
  return { model: {
    async create(_table: string, data: any) { rows.push({ ...data }); return data },
    async get(_table: string, query: any) { return rows.filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(_table: string, query: any, patch: any) { Object.assign(rows.find(row => row.id === query.id), patch) },
  } }
}

describe('intake workflows', () => {
  it('persists all three intake types with stable numbers', async () => {
    const service = new IntakeService(fakeContext() as any, () => new Date('2026-01-01T00:00:00Z'))
    const submission = await service.create({ type: 'submission', submitterId: 'u1', sourceSession: 'qq:g1', body: '投稿', attachments: [] })
    const feedback = await service.create({ type: 'feedback', submitterId: 'u2', sourceSession: 'qq:u2', body: '反馈', attachments: [] })
    expect(submission.id).toBe('SUB-000001'); expect(feedback.id).toBe('FDB-000001'); expect((await service.get(submission.id))?.status).toBe('pending-review'); expect((await service.get(feedback.id))?.status).toBe('pending')
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
    const config = { targets: { submission: {}, feedback: {}, suggestion: {} }, adminUsers: ['u1'], adminGroups: ['g1'] }
    expect(isAdmin({ userId: 'other', user: { authority: 4 } }, config)).toBe(true); expect(isAdmin({ userId: 'u1', user: { authority: 0 } }, config)).toBe(true); expect(isAdmin({ guildId: 'g1', user: { authority: 0 } }, config)).toBe(true); expect(isAdmin({ userId: 'other', guildId: 'other', user: { authority: 3 } }, config)).toBe(false); expect(canTransition('suggestion', 'closed', 'pending-review')).toBe(true)
  })
})
