import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => {
    const value: Record<string, unknown> = {}
    for (const method of ['default', 'description', 'min', 'max']) value[method] = () => value
    return value
  }
  return { Context: class {}, Schema: { object: chain, array: chain, number: chain, string: chain } }
})

import { FaqService, formatFaqList, isAdministrator, paginate, selectNumber } from '../src/index'

function fakeContext() {
  const rows: any[] = []
  let sequence = 0
  return { rows, model: {
    async create(_table: string, data: any) { const row = { ...data, id: ++sequence }; rows.push(row); return row },
    async get(_table: string, query: any) { return rows.filter(row => Object.entries(query).every(([key, value]) => row[key] === value)) },
    async set(_table: string, query: any, patch: any) { for (const row of rows.filter(row => row.id === query.id)) Object.assign(row, patch) },
    async remove(_table: string, query: any) { const index = rows.findIndex(row => row.id === query.id); if (index >= 0) rows.splice(index, 1) },
  } }
}

describe('FAQ workflows', () => {
  it('validates and persists complete entries', async () => {
    const service = new FaqService(fakeContext() as any)
    const created = await service.create({ question: '  如何投稿？ ', answer: ' 使用投稿命令。 ' })
    expect(created.question).toBe('如何投稿？'); expect(created.answer).toBe('使用投稿命令。'); expect(created.visible).toBe(true)
    const updated = await service.update(created.id, { question: '在哪里投稿？', answer: '在群内使用投稿命令。' })
    expect(updated.question).toBe('在哪里投稿？'); expect((await service.get(created.id))?.answer).toBe('在群内使用投稿命令。')
    await service.remove(created.id); expect(await service.get(created.id)).toBeUndefined()
    await expect(service.create({ question: '', answer: 'answer' })).rejects.toThrow('问题不能为空')
  })

  it('hides entries from public pages and numbered selection', async () => {
    const service = new FaqService(fakeContext() as any)
    const first = await service.create({ question: '公开一', answer: '答案一' })
    const hidden = await service.create({ question: '隐藏', answer: '秘密' })
    const third = await service.create({ question: '公开二', answer: '答案二' })
    await service.setVisibility(hidden.id, false)
    const page = await service.listPublic(1, 10)
    expect(page.items.map(item => item.id)).toEqual([first.id, third.id]); expect(selectNumber(page.items, 2)?.answer).toBe('答案二'); expect(selectNumber(page.items, 3)).toBeUndefined()
  })

  it('paginates public answers by ten', () => {
    const entries = Array.from({ length: 21 }, (_, index) => ({ id: index + 1, question: '问题 ' + (index + 1) }))
    expect(paginate(entries, 1, 10).items.map(item => item.id)).toEqual([1,2,3,4,5,6,7,8,9,10]); expect(paginate(entries, 2, 10).items.map(item => item.id)).toEqual([11,12,13,14,15,16,17,18,19,20])
    const end = paginate(entries, 3, 10); expect(end.items.map(item => item.id)).toEqual([21]); expect(paginate(entries, 99, 10).currentPage).toBe(3); expect(formatFaqList(end)).toMatch(/第 3\/3 页/)
  })

  it('requires authority and a matching administrator whitelist', () => {
    const config = { adminUserIds: ['10001'], adminGroupIds: ['20001'], minAuthority: 4 }
    expect(isAdministrator({ userId: '10001', user: { authority: 4 } }, config)).toBe(true); expect(isAdministrator({ guildId: '20001', user: { authority: 5 } }, config)).toBe(true); expect(isAdministrator({ userId: '10001', user: { authority: 3 } }, config)).toBe(false); expect(isAdministrator({ userId: 'other', guildId: 'other', user: { authority: 5 } }, config)).toBe(false)
  })
})
