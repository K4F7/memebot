import assert from 'node:assert/strict'
import test from 'node:test'
import { FaqService, formatFaqList, isAdministrator, paginate, selectNumber } from '../lib/index.js'

function fakeContext() {
  const rows = []
  let sequence = 0
  return {
    rows,
    model: {
      async create(_table, data) {
        const row = { ...data, id: ++sequence }
        rows.push(row)
        return row
      },
      async get(_table, query) {
        return rows.filter(row => Object.entries(query).every(([key, value]) => row[key] === value))
      },
      async set(_table, query, patch) {
        for (const row of rows.filter(row => row.id === query.id)) Object.assign(row, patch)
      },
      async remove(_table, query) {
        const index = rows.findIndex(row => row.id === query.id)
        if (index >= 0) rows.splice(index, 1)
      },
    },
  }
}

test('CRUD validates and persists complete Question and Answer entries', async () => {
  const ctx = fakeContext()
  const service = new FaqService(ctx)
  const created = await service.create({ question: '  如何投稿？ ', answer: ' 使用投稿命令。 ' })
  assert.equal(created.question, '如何投稿？')
  assert.equal(created.answer, '使用投稿命令。')
  assert.equal(created.visible, true)

  const updated = await service.update(created.id, { question: '在哪里投稿？', answer: '在群内使用投稿命令。' })
  assert.equal(updated.question, '在哪里投稿？')
  assert.equal((await service.get(created.id)).answer, '在群内使用投稿命令。')

  await service.remove(created.id)
  assert.equal(await service.get(created.id), undefined)
  await assert.rejects(service.create({ question: '', answer: 'answer' }), /问题不能为空/)
})

test('hidden entries never appear in public pages or numbered selection', async () => {
  const service = new FaqService(fakeContext())
  const first = await service.create({ question: '公开一', answer: '答案一' })
  const hidden = await service.create({ question: '隐藏', answer: '秘密' })
  const third = await service.create({ question: '公开二', answer: '答案二' })
  await service.setVisibility(hidden.id, false)

  const page = await service.listPublic(1, 10)
  assert.deepEqual(page.items.map(item => item.id), [first.id, third.id])
  assert.equal(selectNumber(page.items, 2).answer, '答案二')
  assert.equal(selectNumber(page.items, 3), undefined)
})

test('pagination covers first, next, and end-of-list pages with ten entries', () => {
  const entries = Array.from({ length: 21 }, (_, index) => ({ id: index + 1, question: '问题 ' + (index + 1) }))
  assert.deepEqual(paginate(entries, 1, 10).items.map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(paginate(entries, 2, 10).items.map(item => item.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  const end = paginate(entries, 3, 10)
  assert.deepEqual(end.items.map(item => item.id), [21])
  assert.equal(paginate(entries, 99, 10).currentPage, 3)
  assert.match(formatFaqList(end), /第 3\/3 页/)
})

test('administrator requires both authority and a matching whitelist entry', () => {
  const config = { adminUserIds: ['10001'], adminGroupIds: ['20001'], minAuthority: 4 }
  assert.equal(isAdministrator({ userId: '10001', user: { authority: 4 } }, config), true)
  assert.equal(isAdministrator({ guildId: '20001', user: { authority: 5 } }, config), true)
  assert.equal(isAdministrator({ userId: '10001', user: { authority: 3 } }, config), false)
  assert.equal(isAdministrator({ userId: 'other', guildId: 'other', user: { authority: 5 } }, config), false)
})
