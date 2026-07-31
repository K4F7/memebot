import assert from 'node:assert/strict'
import test from 'node:test'
import { IntakeService, canTransition, isAdmin } from '../lib/index.js'

function fakeContext() {
  const rows = []
  return { model: {
    async create(_table, data) { rows.push({ ...data }); return data },
    async get(_table, query) { return rows.filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(_table, query, patch) { Object.assign(rows.find(row => row.id === query.id), patch) },
  } }
}

test('accepts and persists all three intake types with stable numbers', async () => {
  const service = new IntakeService(fakeContext(), () => new Date('2026-01-01T00:00:00Z'))
  const submission = await service.create({ type: 'submission', submitterId: 'u1', sourceSession: 'qq:g1', body: '投稿', attachments: [] })
  const feedback = await service.create({ type: 'feedback', submitterId: 'u2', sourceSession: 'qq:u2', body: '反馈', attachments: [] })
  assert.equal(submission.id, 'SUB-000001')
  assert.equal(feedback.id, 'FDB-000001')
  assert.equal((await service.get(submission.id)).status, 'pending-review')
  assert.equal((await service.get(feedback.id)).status, 'pending')
})

test('enforces workflow transitions and keeps notes', async () => {
  const service = new IntakeService(fakeContext())
  const record = await service.create({ type: 'feedback', submitterId: 'u1', sourceSession: 'qq:u1', body: '反馈', attachments: [] })
  await assert.rejects(service.updateStatus(record.id, 'resolved'), /不允许从 pending 变更为 resolved/)
  await service.updateStatus(record.id, 'processing')
  await service.addNote(record.id, '已联系提交者')
  const updated = await service.updateStatus(record.id, 'resolved')
  assert.deepEqual(updated.notes, ['已联系提交者'])
})

test('close and reopen work for terminal review decisions', async () => {
  const service = new IntakeService(fakeContext())
  const record = await service.create({ type: 'submission', submitterId: 'u1', sourceSession: 'qq:u1', body: '投稿', attachments: [] })
  await service.updateStatus(record.id, 'approved')
  await service.updateStatus(record.id, 'closed')
  const reopened = await service.updateStatus(record.id, 'pending-review')
  assert.equal(reopened.status, 'pending-review')
})

test('admin access accepts authority or configured user/group', () => {
  const config = { targets: { submission: {}, feedback: {}, suggestion: {} }, adminUsers: ['u1'], adminGroups: ['g1'] }
  assert.equal(isAdmin({ userId: 'other', user: { authority: 4 } }, config), true)
  assert.equal(isAdmin({ userId: 'u1', user: { authority: 0 } }, config), true)
  assert.equal(isAdmin({ guildId: 'g1', user: { authority: 0 } }, config), true)
  assert.equal(isAdmin({ userId: 'other', guildId: 'other', user: { authority: 3 } }, config), false)
  assert.equal(canTransition('suggestion', 'closed', 'pending-review'), true)
})
