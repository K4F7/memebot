import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => { const value: Record<string, unknown> = {}; for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value; return value }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain, boolean: chain }, h: (...args: unknown[]) => args }
})

import { IntakeNotificationOutbox, IntakeRetentionService, IntakeService } from '../src/index'

function fakeContext() {
  const tables = new Map<string, any[]>()
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)! }
  return {
    tables,
    model: {
      async create(name: string, data: any) { table(name).push({ ...data }); return data },
      async get(name: string, query: any) { return table(name).filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
      async set(name: string, query: any, patch: any) { const row = table(name).find(row => Object.entries(query).every(([key, value]) => row[key] === value)); if (row) Object.assign(row, patch) },
      async remove(name: string, query: any) { const rows = table(name); for (let index = rows.length - 1; index >= 0; index--) if (Object.entries(query).every(([key, value]) => rows[index][key] === value)) rows.splice(index, 1) },
    },
  }
}

describe('intake notification and work tracking', () => {
  it('persists both management message mappings and resolves them after restart', async () => {
    const ctx = fakeContext() as any
    const records = new IntakeService(ctx, () => new Date('2026-08-02T00:00:00Z'))
    const record = await records.create({ type: 'feedback', submitterId: '10001', sourceSession: 'qq:private:10001', body: '反馈正文', attachments: [{ type: 'img', relativePath: 'a.png' }] })
    const sent: string[] = []
    const transport = {
      async sendSummary(_target: string, content: string) { sent.push(content); return 'summary-1' },
      async sendForward(_target: string, _record: unknown) { return 'forward-1' },
      async notifySubmitter() {},
    }
    const outbox = new IntakeNotificationOutbox(ctx, transport, () => new Date('2026-08-02T00:00:00Z'))
    expect((await outbox.enqueueAndDeliver(record, ['qq:20001'])).delivered).toBe(true)
    expect(sent[0]).toContain('反馈#1')
    expect(sent[0]).toContain('提交者 QQ: 10001')
    expect(sent[0]).toContain('请引用本消息并发送“认领”')

    const restarted = new IntakeNotificationOutbox(ctx, transport)
    expect(await restarted.resolveMessage('summary-1')).toBe('反馈#1')
    expect(await restarted.resolveMessage('forward-1')).toBe('反馈#1')
  })

  it('keeps a failed delivery durable and resumes without repeating the summary', async () => {
    const ctx = fakeContext() as any
    let now = new Date('2026-08-02T00:00:00Z')
    const records = new IntakeService(ctx, () => now)
    const record = await records.create({ type: 'submission', submitterId: '10001', sourceSession: 'qq:private:10001', body: '稿件', attachments: [] })
    let summaries = 0
    let forwards = 0
    const notices: string[] = []
    const transport = {
      async sendSummary() { summaries += 1; return 'summary-1' },
      async sendForward() { forwards += 1; if (forwards === 1) throw new Error('network down'); return 'forward-1' },
      async notifySubmitter(_user: string, content: string) { notices.push(content) },
    }
    const first = new IntakeNotificationOutbox(ctx, transport, () => now)
    expect((await first.enqueueAndDeliver(record, ['qq:20001'])).delivered).toBe(false)
    expect(notices.at(-1)).toContain('通知暂时延迟')

    now = new Date('2026-08-02T00:01:00Z')
    const restarted = new IntakeNotificationOutbox(ctx, transport, () => now)
    await restarted.retryDue()
    expect(summaries).toBe(1)
    expect(forwards).toBe(2)
    expect(notices.at(-1)).toContain('现已送达')
  })

  it('atomically claims once, records assignment history, and preserves handling state across close/reopen', async () => {
    const ctx = fakeContext() as any
    const records = new IntakeService(ctx, () => new Date('2026-08-02T00:00:00Z'))
    const record = await records.create({ type: 'feedback', submitterId: '10001', sourceSession: 'qq:private:10001', body: '反馈', attachments: [] })

    const [first, second] = await Promise.all([records.claim(record.id, 'admin-a'), records.claim(record.id, 'admin-b')])
    expect([first.assigneeId, second.assigneeId]).toEqual(['admin-a', 'admin-a'])
    expect((await records.get(record.id))?.status).toBe('processing')
    expect((await records.get(record.id))?.acceptanceNotified).toBe(false)

    await records.markAcceptanceNotified(record.id)
    await records.transfer(record.id, 'admin-b', 'admin-a')
    await records.close(record.id, 'admin-b')
    expect((await records.get(record.id))?.active).toBe(false)
    expect((await records.get(record.id))?.status).toBe('processing')
    await records.reopen(record.id, 'admin-b')
    const reopened = await records.get(record.id)
    expect(reopened?.active).toBe(true)
    expect(reopened?.status).toBe('processing')
    expect(reopened?.audit.map(event => event.action)).toEqual(['claim', 'acceptance-notified', 'transfer', 'close', 'reopen'])
  })

  it('cleans attachments ninety days after close while retaining text and history', async () => {
    const ctx = fakeContext() as any
    let now = new Date('2026-01-01T00:00:00Z')
    const records = new IntakeService(ctx, () => now)
    const record = await records.create({ type: 'submission', submitterId: '10001', sourceSession: 'qq:private:10001', body: '永久保留正文', attachments: [{ relativePath: 'submission/a.zip', type: 'file' }] })
    await records.close(record.id, 'admin')
    now = new Date('2026-04-01T00:00:00.001Z')
    const removed: string[] = []
    await new IntakeRetentionService(records, { async remove(attachment) { removed.push(attachment.relativePath!) } } as any, () => now).run()
    expect(removed).toEqual(['submission/a.zip'])
    const retained = await records.get(record.id)
    expect(retained?.body).toBe('永久保留正文')
    expect(retained?.attachments).toEqual([])
    expect(retained?.audit.map(event => event.action)).toContain('close')
  })

  it('marks the one-time acceptance notice only after successful delivery', async () => {
    const ctx = fakeContext() as any
    const records = new IntakeService(ctx)
    const record = await records.create({ type: 'suggestion', submitterId: '10001', sourceSession: 'qq:private:10001', body: '建议', attachments: [] })
    await records.claim(record.id, 'admin')
    await expect(records.deliverAcceptanceNotice(record.id, async () => { throw new Error('send failed') })).rejects.toThrow('send failed')
    expect((await records.get(record.id))?.acceptanceNotified).toBe(false)
    let delivered = 0
    expect(await records.deliverAcceptanceNotice(record.id, async () => { delivered += 1 })).toBe(true)
    expect(await records.deliverAcceptanceNotice(record.id, async () => { delivered += 1 })).toBe(false)
    expect(delivered).toBe(1)
  })
})
