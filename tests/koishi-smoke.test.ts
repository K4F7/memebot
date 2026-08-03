import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import access from '../plugins/memebot-access/src'
import activity from '../plugins/memebot-activity/src'
import archive, { ArchiveService, type ArchiveSession } from '../plugins/memebot-archive/src'
import faq from '../plugins/memebot-faq/src'
import intake from '../plugins/memebot-intake/src'
import { createDeliveryCapture, createKoishiTestHarness, qqQuotedCommand, type KoishiTestHarness } from './koishi'

const harnesses: KoishiTestHarness[] = []
const temporaryArchiveRoots: string[] = []

async function temporaryArchiveRoot() {
  const root = await mkdtemp(join(tmpdir(), 'memebot-archive-routes-'))
  temporaryArchiveRoots.push(root)
  return root
}

const activityWithAccess = {
  name: 'test-activity-with-access',
  apply(ctx: any, config: any) {
    const result: { service?: any } = {}
    access.apply(ctx, config.access)
    ctx.inject(['access'], (injected: any) => { result.service = activity.apply(injected, config.activity) })
    return result
  },
}

const faqWithAccess = {
  name: 'test-faq-with-access',
  apply(ctx: any, config: any) {
    const result: { service?: any } = {}
    access.apply(ctx, config.access)
    ctx.inject(['access'], (injected: any) => {
      faq.apply(injected, config.faq)
      result.service = injected.faq
    })
    return result
  },
}

const intakeWithAccess = {
  name: 'test-intake-with-access',
  apply(ctx: any, config: any) {
    const result: { service?: any } = {}
    access.apply(ctx, config.access)
    ctx.inject(['access'], (injected: any) => {
      intake.apply(injected, config.intake)
      result.service = injected.intake
    })
    return result
  },
}

const archiveWithAccess = {
  name: 'test-archive-with-access',
  apply(ctx: any, config: any) {
    const result: { service?: ArchiveService } = {}
    access.apply(ctx, config.access)
    ctx.inject(['access'], (injected: any) => {
      result.service = archive.apply(injected, config.archive)
    })
    return result
  },
}

const allProtectedPluginsWithAccess = {
  name: 'test-all-protected-plugins-with-access',
  apply(ctx: any, config: any) {
    const result: Record<string, unknown> = {}
    access.apply(ctx, config.access)
    ctx.inject(['access'], (injected: any) => {
      result.activity = activity.apply(injected, config.activity)
      faq.apply(injected, config.faq)
      result.faq = injected.faq
      intake.apply(injected, config.intake)
      result.intake = injected.intake
      result.archive = archive.apply(injected, config.archive)
    })
    return result
  },
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.stop()))
  await Promise.all(temporaryArchiveRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('standalone plugin command smoke behaviors', () => {
  it('rejects every protected consumer entry when Access is absent', () => {
    const consumers = [
      ['memebot-activity', activity, { notificationUsers: [], notificationGroups: [] }],
      ['memebot-faq', faq, { pageSize: 10 }],
      ['memebot-intake', intake, {}],
      ['memebot-archive', archive, {}],
    ] as const

    for (const [name, plugin, config] of consumers) {
      expect(() => plugin.apply({} as any, config as any), name).toThrow(`${name} requires memebot-access`)
    }
  })

  it('loads Access and all four protected consumers in one Context', async () => {
    for (const plugin of [access, activity, faq, intake, archive]) expect(typeof plugin.apply).toBe('function')
    const harness = await createKoishiTestHarness(allProtectedPluginsWithAccess, {
      access: { administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }] },
      activity: { notificationUsers: [], notificationGroups: [] },
      faq: { pageSize: 10 }, intake: {}, archive: {},
    })
    harnesses.push(harness)
    const administrator = await harness.client({ userId: '10001', channelId: '20001' })

    await expect(administrator.receive('access.list')).resolves.toEqual(['显式管理员：10001\n管理群：20001'])
    await expect(administrator.receive('activity')).resolves.toEqual(['暂无即将开始或进行中的活动。'])
    await expect(administrator.receive('faq')).resolves.toEqual(['暂无公开 FAQ。'])
    await expect(administrator.receive('intake')).resolves.toEqual(['暂无记录。'])
    await expect(administrator.receive('archive.issues')).resolves.toEqual(['没有找到 Newspaper Issue。'])
  })

  it('keeps Activity public while Access separates administrator reads from writes', async () => {
    const harness = await createKoishiTestHarness(activityWithAccess, {
      access: { administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }] },
      activity: { notificationUsers: [], notificationGroups: [] },
    })
    harnesses.push(harness)
    const ordinary = await harness.client({ userId: '10002', channelId: 'unlisted' })
    const privateOrdinary = await harness.client({ userId: '10003' })
    const administrator = await harness.client({ userId: '10001', channelId: 'unlisted' })
    const privateAdministrator = await harness.client({ userId: '10001' })

    await expect(ordinary.receive('activity')).resolves.toEqual(['暂无即将开始或进行中的活动。'])
    await expect(privateOrdinary.receive('activity')).resolves.toEqual(['暂无即将开始或进行中的活动。'])
    await expect(ordinary.receive('activity.history')).resolves.toEqual(['你不是管理员。'])
    await expect(administrator.receive('activity.history')).resolves.toEqual(['暂无历史活动。'])
    await expect(administrator.receive('activity.cancel 1')).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])
    await expect(privateAdministrator.receive('activity.cancel 1')).resolves.toEqual(['活动不存在'])
  })

  it('lists persistent Access sets only for authorized readers', async () => {
    const harness = await createKoishiTestHarness(access, {
      administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }],
    })
    harnesses.push(harness)
    const administrator = await harness.client({ userId: '10001', channelId: 'unlisted' })
    const ordinary = await harness.client({ userId: '10002', channelId: '20001' })

    await expect(ordinary.receive('access.list')).resolves.toEqual(['你不是管理员。'])
    await expect(administrator.receive('access.list')).resolves.toEqual([
      '显式管理员：10001\n管理群：20001',
    ])
  })

  it('applies authorized Access additions to the next decision immediately', async () => {
    const harness = await createKoishiTestHarness(access, {
      administrators: [{ qq: '10001' }], managementGroups: [],
    })
    harnesses.push(harness)
    const administratorInGroup = await harness.client({ userId: '10001', channelId: '20001' })
    const administratorInPrivate = await harness.client({ userId: '10001' })
    const ordinary = await harness.client({ userId: '10002', channelId: '20001' })

    await expect(ordinary.receive('access.admin.add 10002')).resolves.toEqual(['你不是管理员。'])
    await expect(administratorInGroup.receive('access.group.add 20001')).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])
    await expect(administratorInPrivate.receive('access.group.add 20001')).resolves.toEqual(['管理群 20001 已添加。'])
    await expect(administratorInPrivate.receive('access.group.add 20001')).resolves.toEqual(['管理群 20001 已存在，无需重复添加。'])
    await expect(administratorInGroup.receive('access.admin.add 10002')).resolves.toEqual(['显式管理员 10002 已添加。'])
    await expect(administratorInGroup.receive('access.admin.add 10002')).resolves.toEqual(['显式管理员 10002 已存在，无需重复添加。'])
    await expect(ordinary.receive('access.list')).resolves.toEqual([
      '显式管理员：10001、10002\n管理群：20001',
    ])
  })

  it('makes Access removals idempotent while rejecting chat-side self-removal', async () => {
    const harness = await createKoishiTestHarness(access, {
      administrators: [{ qq: '10001' }, { qq: '10002' }], managementGroups: [{ qq: '20001' }],
    })
    harnesses.push(harness)
    const self = await harness.client({ userId: '10001' })
    const operator = await harness.client({ userId: '40001', authority: 4 })
    const removed = await harness.client({ userId: '10002' })

    await expect(self.receive('access.admin.rm 10001')).resolves.toEqual([
      '不能通过 QQ 命令移除当前操作账号。',
    ])
    await expect(operator.receive('access.admin.rm 10002')).resolves.toEqual(['显式管理员 10002 已移除。'])
    await expect(operator.receive('access.admin.rm 10002')).resolves.toEqual(['显式管理员 10002 不存在，无需移除。'])
    await expect(operator.receive('access.group.rm 20001')).resolves.toEqual(['管理群 20001 已移除。'])
    await expect(operator.receive('access.group.rm 20001')).resolves.toEqual(['管理群 20001 不存在，无需移除。'])
    await expect(removed.receive('access.list')).resolves.toEqual(['你不是管理员。'])
  })

  it('rejects non-decimal Access command identifiers', async () => {
    const harness = await createKoishiTestHarness(access, {
      administrators: [{ qq: '10001' }], managementGroups: [],
    })
    harnesses.push(harness)
    const administrator = await harness.client({ userId: '10001' })

    for (const command of [
      'access.admin.add 10a',
      'access.admin.rm +10002',
      'access.group.add 20.001',
      'access.group.rm group-1',
    ]) {
      await expect(administrator.receive(command)).resolves.toEqual(['QQ 号必须是纯数字。'])
    }
  })

  it('loads activity and lists activities through a Mock session', async () => {
    const harness = await createKoishiTestHarness(activityWithAccess, {
      access: { administrators: [], managementGroups: [] },
      activity: { notificationUsers: [], notificationGroups: [] },
    })
    harnesses.push(harness)

    const client = await harness.client({ userId: '10001', channelId: '20001' })
    await expect(client.receive('activity')).resolves.toEqual([
      '暂无即将开始或进行中的活动。',
    ])
  })

  it('drives public discovery and the complete guided Activity administration route', async () => {
    const harness = await createKoishiTestHarness(activityWithAccess, {
      access: { administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }] },
      activity: { notificationUsers: [{ qq: '30001' }], notificationGroups: [] },
    })
    harnesses.push(harness)
    await harness.registerBroadcastTargets(['qq:30001'])
    const client = await harness.client({ userId: '10001', channelId: '20001' })
    const member = await harness.client({ userId: '10002', channelId: '20001' })
    const now = Date.now()
    const upcomingStart = new Date(now + 24 * 60 * 60_000).toISOString()
    const upcomingEnd = new Date(now + 26 * 60 * 60_000).toISOString()
    const started = client.receive('activity.add')
    for (const input of ['例会', upcomingStart, upcomingEnd, '-', '-', '-', '仅保存']) {
      await new Promise<void>(resolve => setImmediate(resolve))
      void client.receive(input)
    }
    await expect(started).resolves.toEqual(expect.arrayContaining([
      '请输入活动标题。', expect.stringContaining('请选择“仅保存”或“保存并通知”'), expect.stringContaining('活动创建成功'),
    ]))
    expect(harness.broadcasts).toEqual([])
    const service = (harness.pluginResult as any).service
    await service.create({
      title: '进行中的活动',
      startAt: new Date(now - 60 * 60_000),
      endAt: new Date(now + 60 * 60_000),
    })
    await expect(member.receive('activity')).resolves.toEqual([
      expect.stringMatching(/活动 #2：进行中的活动[\s\S]*活动 #1：例会/),
    ])
    await expect(member.receive('activity #1')).resolves.toEqual([expect.stringContaining('活动 #1：例会')])

    const editing = client.receive('activity.edit 1')
    for (const input of ['标题，地点', '更新后的例会', '新活动室', '保存并通知']) {
      await new Promise<void>(resolve => setImmediate(resolve))
      void client.receive(input)
    }
    await expect(editing).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('请输入要修改的字段'),
      expect.stringContaining('活动更新成功；记录已保存，通知已送达。'),
    ]))
    expect(harness.broadcasts).toEqual([{
      targets: ['qq:30001'], content: expect.stringContaining('活动 #1：更新后的例会'),
    }])
    await expect(member.receive('activity #1')).resolves.toEqual([expect.stringContaining('地点：新活动室')])

    const cancelling = client.receive('activity.cancel 1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('仅保存')
    await expect(cancelling).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('活动已取消；已仅保存，未请求通知。'),
    ]))
    expect(harness.broadcasts).toHaveLength(1)
    await expect(member.receive('activity')).resolves.toEqual([expect.not.stringContaining('更新后的例会')])
    await expect(client.receive('activity.history')).resolves.toEqual([expect.stringContaining('活动 #1：更新后的例会')])
    await expect(member.receive('activity #1')).resolves.toEqual([expect.stringContaining('状态：cancelled')])
  })

  it('publishes and retrieves authoritative Archive attachments through compact QQ routes', async () => {
    const root = await temporaryArchiveRoot()
    const harness = await createKoishiTestHarness(archiveWithAccess, {
      access: { administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }] },
      archive: { localPath: root },
    })
    harnesses.push(harness)
    const administrator = await harness.client({ userId: '10001', channelId: '20001' })
    const member = await harness.client({ userId: '10002', channelId: '20001' })
    const pdf = Buffer.from('%PDF-1.7\nroute evidence\n%%EOF').toString('base64')
    const zip = 'UEsDBBQAAAAIAAAAAACGphA2BwAAAAUAAAAKAAAAUkVBRE1FLnR4dMtIzcnJBwBQSwECHgMUAAAACAAAAAAAhqYQNgcAAAAFAAAACgAAAAAAAAAAAAAAAAAAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAAAvAAAAAAA='
    const paper = JSON.stringify({
      month: '2026-08', issueNumber: '8', title: 'August',
      attachment: { filename: 'august.pdf', contentType: 'application/pdf', data: `data:application/pdf;base64,${pdf}` },
    })
    const work = JSON.stringify({
      title: 'Work', author: 'Alice',
      attachment: { filename: 'work.zip', contentType: 'application/zip', data: `data:application/zip;base64,${zip}` },
    })

    await expect(administrator.receive(`archive.issue-publish ${paper}`)).resolves.toEqual(['已发布 Newspaper Issue P1。'])
    await expect(administrator.receive(`archive.work-publish ${work}`)).resolves.toEqual(['已发布 Work W1。'])
    await expect(member.receive('archive.search paper August')).resolves.toEqual(['P1 2026-08 第8期 August'])
    await expect(member.receive('archive.search works Alice')).resolves.toEqual(['W1 Alice - Work'])
    await expect(member.receive('archive P1')).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('P1 2026-08 第8期 August'),
      expect.stringContaining('august.pdf'),
    ]))
    await expect(member.receive('archive W1')).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('W1 Alice - Work'),
      expect.stringContaining('work.zip'),
    ]))

    await expect(administrator.receive('archive.issue-edit P1 Y {"title":"August-Revised"}')).resolves.toEqual(['已更新 Newspaper Issue P1。'])
    await expect(administrator.receive('archive.work-edit W1 Y {"title":"Work-Revised"}')).resolves.toEqual(['已更新 Work W1。'])
    await expect(member.receive('archive.search paper Revised')).resolves.toEqual(['P1 2026-08 第8期 August-Revised'])
    await expect(member.receive('archive.search works Revised')).resolves.toEqual(['W1 Alice - Work-Revised'])

    const service = (harness.pluginResult as any).service as ArchiveService
    const retryPending = vi.spyOn(service, 'retryPending').mockResolvedValue(undefined)
    await expect(administrator.receive('archive.retry')).resolves.toEqual(['已重试待同步附件。'])
    expect(retryPending).toHaveBeenCalledOnce()

    const removing = administrator.receive('archive.rm W1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void administrator.receive('确认')
    await expect(removing).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('W1 Alice - Work-Revised'),
      expect.stringContaining('已移除 Work W1，保留 30 天'),
    ]))
    await expect(member.receive('archive W1')).resolves.toEqual(['Work 不存在。'])
  })

  it('uses Access identity for Archive management reads and Access location for mutations', async () => {
    const harness = await createKoishiTestHarness(archiveWithAccess, {
      access: { administrators: [{ qq: '10002' }], managementGroups: [{ qq: '20001' }] }, archive: {},
    })
    harnesses.push(harness)
    const ordinary = await harness.client({ userId: '10003', channelId: '20001' })
    const administrator = await harness.client({ userId: '10002', channelId: 'unlisted' })
    const metadata = '{"month":"2026-08","issueNumber":"8","title":"Issue"}'

    await expect(ordinary.receive(`archive.issue-preview ${metadata}`)).resolves.toEqual(['你不是管理员。'])
    await expect(administrator.receive(`archive.issue-preview ${metadata}`)).resolves.toEqual([expect.stringContaining('Newspaper Issue')])
    await expect(administrator.receive(`archive.issue-publish ${metadata}`)).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])
  })

  it('navigates Publication Appearances and related search through a Mock session', async () => {
    const harness = await createKoishiTestHarness(archiveWithAccess, { access: { administrators: [], managementGroups: [] }, archive: {} })
    harnesses.push(harness)
    const service = (harness.pluginResult as any).service as ArchiveService
    const client = await harness.client({ userId: '10002', channelId: '20001' })
    await client.receive('archive.issues')
    service.db.issues.push({ id: 'P1', issueNumber: '1', month: '2026-08', title: 'Issue', publishedAt: new Date(), lifecycle: 'active' })
    service.db.works.push({ id: 'W1', title: 'Work', author: 'Alice', description: 'Related description', publishedAt: new Date(), lifecycle: 'active' })
    await service.associateWork({ authority: 4 }, 'P1', { workId: 'W1', page: '3', section: 'Features', displayOrder: 1 })
    expect(service.searchIssues('Alice').map(item => item.id)).toEqual(['P1'])

    await expect(client.receive('archive.search paper Alice')).resolves.toEqual([expect.stringContaining('P1 2026-08 第1期 Issue')])
    await expect(client.receive('archive.search works Related')).resolves.toEqual([expect.stringContaining('W1 Alice - Work')])
    await expect(client.receive('archive P1')).resolves.toEqual([expect.stringContaining('W1 Alice - Work · 第3页 · Features')])
  })

  it('shows the Archive target and requires explicit confirmation before soft deletion', async () => {
    const harness = await createKoishiTestHarness(archiveWithAccess, {
      access: { administrators: [{ qq: '10002' }], managementGroups: [{ qq: '20001' }] }, archive: {},
    })
    harnesses.push(harness)
    const service = (harness.pluginResult as any).service as ArchiveService
    const client = await harness.client({ userId: '10002', channelId: '20001' })
    await client.receive('archive.issues')
    service.db.works.push({ id: 'W1', title: 'Work to remove', author: 'Alice', publishedAt: new Date(), lifecycle: 'active' })

    const started = client.receive('archive.rm W1')
    await new Promise<void>(resolve => setImmediate(resolve))
    const confirmation = client.receive('确认')
    await confirmation

    await expect(started).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('W1 Alice - Work to remove'),
      expect.stringContaining('已移除 Work W1，保留 30 天'),
    ]))
    expect(service.getWork('W1')).toBeUndefined()
    expect(service.listRemoved({ authority: 4 })[0]).toMatchObject({ id: 'W1', lifecycle: 'removed' })
  })

  it('represents QQ-style IDs and quoted messages at the Mock boundary', async () => {
    const harness = await createKoishiTestHarness(archiveWithAccess, { access: { administrators: [], managementGroups: [] }, archive: {} })
    harnesses.push(harness)

    const client = await harness.client({ userId: '2854196310', channelId: '768284112' })
    await expect(client.receive(
      qqQuotedCommand('741224233071829312', '上一条 QQ 消息', 'archive.issues'),
    )).resolves.toEqual(['没有找到 Newspaper Issue。'])

    expect(harness.messages).toContainEqual({
      userId: '2854196310',
      channelId: '768284112',
      quote: { messageId: '741224233071829312', content: '上一条 QQ 消息' },
    })
  })

  it('captures forward attempts and ordinary-delivery fallback', async () => {
    const harness = await createKoishiTestHarness(archiveWithAccess, { access: { administrators: [], managementGroups: [] }, archive: {} })
    harnesses.push(harness)
    const issue = {
      id: 'issue-2026-08',
      issueNumber: '8',
      month: '2026-08',
      title: '八月刊',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    }
    const service = (harness.pluginResult as any).service
    service.db.issues.push(issue)
    const capture = createDeliveryCapture({ failForward: true })
    const client = await harness.client({ userId: '2854196310', channelId: '768284112' })
    const session = harness.app.mock.session(client.event)

    await service.sendIssue(session as unknown as ArchiveSession, issue.id, capture.sender)

    expect(capture.forwarded).toEqual([issue])
    expect(capture.ordinary).toEqual([issue])
    expect(service.fallbackEvents).toEqual([{
      id: issue.id,
      kind: 'issue',
      reason: 'forward-message unavailable or failed',
    }])
  })

  it('pages public FAQ entries and opens answers by stable reference', async () => {
    const harness = await createKoishiTestHarness(faqWithAccess, {
      access: { administrators: [], managementGroups: [] }, faq: { pageSize: 1 },
    })
    harnesses.push(harness)
    const service = (harness.pluginResult as any).service
    await service.create({ question: '公开问题一', answer: '公开答案一' })
    await service.create({ question: '隐藏问题', answer: '隐藏答案', visible: false })
    await service.create({ question: '公开问题二', answer: '公开答案二' })
    const client = await harness.client({ userId: '10003', channelId: '20001' })
    await expect(client.receive('faq')).resolves.toEqual([
      expect.stringMatching(/FAQ（第 1\/2 页）[\s\S]*#1 公开问题一/),
    ])
    await expect(client.receive('faq 2')).resolves.toEqual([
      expect.stringMatching(/FAQ（第 2\/2 页）[\s\S]*#3 公开问题二/),
    ])
    await expect(client.receive('faq #1')).resolves.toEqual([
      'FAQ #1\n问题：公开问题一\n答案：公开答案一',
    ])
    await expect(client.receive('faq #2')).resolves.toEqual(['FAQ 编号不存在。'])
  })

  it('uses Access identity for FAQ reads and Access location for mutations', async () => {
    const harness = await createKoishiTestHarness(faqWithAccess, {
      access: { administrators: [{ qq: '10005' }], managementGroups: [{ qq: '20001' }] },
      faq: { pageSize: 10 },
    })
    harnesses.push(harness)
    const service = (harness.pluginResult as any).service
    const entry = await service.create({ question: '隐藏问题', answer: '隐藏答案', visible: false })

    const denied = await harness.client({ userId: '10003', channelId: '20001', authority: 3 })
    await expect(denied.receive(`faq #${entry.id}`)).resolves.toEqual(['FAQ 编号不存在。'])
    await expect(denied.receive('faq.manage')).resolves.toEqual(['你不是管理员。'])
    await expect(denied.receive('faq.add')).resolves.toEqual(['你不是管理员。'])

    const administrator = await harness.client({ userId: '10005', channelId: 'unlisted' })
    await expect(administrator.receive(`faq #${entry.id}`)).resolves.toEqual([
      `FAQ #${entry.id}\n问题：隐藏问题\n答案：隐藏答案`,
    ])
    await expect(administrator.receive('faq.manage')).resolves.toEqual(['1. [隐藏] 隐藏问题'])
    await expect(administrator.receive(`faq.rm #${entry.id}`)).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])
  })

  it('drives the complete guided FAQ administration route through Mock prompts', async () => {
    const harness = await createKoishiTestHarness(faqWithAccess, {
      access: { administrators: [{ qq: '10005' }], managementGroups: [{ qq: '20001' }] },
      faq: { pageSize: 10 },
    })
    harnesses.push(harness)
    const client = await harness.client({ userId: '10005', channelId: '20001' })
    const started = client.receive('faq.add')
    await new Promise<void>(resolve => setImmediate(resolve))
    const question = client.receive('如何投稿？')
    await new Promise<void>(resolve => setImmediate(resolve))
    const answer = client.receive('使用 /submit。')
    await new Promise<void>(resolve => setImmediate(resolve))
    const confirmation = client.receive('确认')
    await Promise.all([question, answer, confirmation])
    await expect(started).resolves.toEqual(expect.arrayContaining([
      '请输入问题。', '请输入答案。', expect.stringContaining('FAQ 新增成功'),
    ]))
    await expect(client.receive('faq #1')).resolves.toEqual([
      'FAQ #1\n问题：如何投稿？\n答案：使用 /submit。',
    ])

    const editing = client.receive('faq.edit #1')
    for (const input of ['两者', '怎样投稿？', '请使用 /submit。', '确认']) {
      await new Promise<void>(resolve => setImmediate(resolve))
      void client.receive(input)
    }
    await expect(editing).resolves.toEqual(expect.arrayContaining([
      expect.stringContaining('请选择要修改的内容'),
      expect.stringContaining('FAQ 编辑成功'),
    ]))
    await expect(client.receive('faq #1')).resolves.toEqual([
      'FAQ #1\n问题：怎样投稿？\n答案：请使用 /submit。',
    ])
    await expect(client.receive('faq.rm #1')).resolves.toEqual(['请先隐藏 FAQ，再永久删除。'])

    const hiding = client.receive('faq.hide #1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('确认')
    await expect(hiding).resolves.toEqual(expect.arrayContaining(['已隐藏 FAQ #1。']))
    const member = await harness.client({ userId: '10006', channelId: '20001' })
    await expect(member.receive('faq #1')).resolves.toEqual(['FAQ 编号不存在。'])
    await expect(client.receive('faq.manage')).resolves.toEqual(['1. [隐藏] 怎样投稿？'])

    const showing = client.receive('faq.show #1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('确认')
    await expect(showing).resolves.toEqual(expect.arrayContaining(['已公开 FAQ #1。']))
    await expect(member.receive('faq #1')).resolves.toEqual([
      'FAQ #1\n问题：怎样投稿？\n答案：请使用 /submit。',
    ])

    const hidingAgain = client.receive('faq.hide #1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('确认')
    await expect(hidingAgain).resolves.toEqual(expect.arrayContaining(['已隐藏 FAQ #1。']))
    const cancelledRemoval = client.receive('faq.rm #1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('取消')
    await expect(cancelledRemoval).resolves.toEqual(expect.arrayContaining(['已取消永久删除。']))
    await expect(client.receive('faq #1')).resolves.toEqual([
      'FAQ #1\n问题：怎样投稿？\n答案：请使用 /submit。',
    ])

    const removal = client.receive('faq.rm #1')
    await new Promise<void>(resolve => setImmediate(resolve))
    void client.receive('确认')
    await expect(removal).resolves.toEqual(expect.arrayContaining(['已永久删除 FAQ #1。']))
    await expect(client.receive('faq #1')).resolves.toEqual(['FAQ 编号不存在。'])
    await expect(client.receive('faq.manage')).resolves.toEqual(['暂无 FAQ。'])
  })

  it('loads intake and invokes an administrator command through a Mock session', async () => {
    const harness = await createKoishiTestHarness(intakeWithAccess, {
      access: { administrators: [], managementGroups: [{ qq: '20001' }] }, intake: {},
    })
    harnesses.push(harness)

    const client = await harness.client({ userId: '10004', channelId: '20001', authority: 4 })
    await expect(client.receive('intake.admin.list')).resolves.toEqual(['暂无记录。'])
    const member = await harness.client({ userId: '10007', channelId: '20001' })
    await expect(member.receive('feedback')).resolves.toEqual(['此类型尚未配置通知目标，暂时无法开始收集。'])
  })

  it('uses Access for Intake reads, writes, self-claim, and transfer targets', async () => {
    const harness = await createKoishiTestHarness(intakeWithAccess, {
      access: { administrators: [{ qq: '10001' }, { qq: '10002' }], managementGroups: [{ qq: '20001' }] },
      intake: {},
    })
    harnesses.push(harness)
    const service = (harness.pluginResult as any).service
    await harness.registerBroadcastTargets(['qq:10006'])
    await service.create({ type: 'feedback', submitterId: '10006', sourceSession: 'qq:u1', body: '反馈', attachments: [] })
    await service.create({ type: 'suggestion', submitterId: '10007', sourceSession: 'qq:u2', body: '建议', attachments: [] })

    const member = await harness.client({ userId: '10006', channelId: 'unlisted' })
    await expect(member.receive('intake')).resolves.toEqual(['反馈#1 pending'])
    const administrator = await harness.client({ userId: '10001', channelId: 'unlisted' })
    await expect(administrator.receive('intake')).resolves.toEqual([
      expect.stringContaining('反馈#1 pending'),
    ])
    await expect(administrator.receive('intake.admin.list')).resolves.toEqual([
      expect.stringContaining('[反馈#1]'),
    ])
    await expect(administrator.receive('intake.admin.claim 反馈#1')).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])

    const implicitAdministrator = await harness.client({ userId: '40001', authority: 4 })
    await expect(implicitAdministrator.receive('intake.admin.claim 反馈#1')).resolves.toEqual([
      expect.stringContaining('认领人 QQ: 40001'),
    ])
    expect(harness.broadcasts).toEqual([{
      targets: ['qq:10006'],
      content: expect.stringContaining('反馈#1 已由管理员 40001 认领'),
    }])
    await implicitAdministrator.receive('intake.admin.claim 反馈#1')
    expect(harness.broadcasts).toHaveLength(1)
    await expect(implicitAdministrator.receive('intake.admin.transfer 反馈#1 40002')).resolves.toEqual([
      '转交目标必须是已持久化的显式管理员 QQ。',
    ])
    await expect(implicitAdministrator.receive('intake.admin.transfer 反馈#1 10002')).resolves.toEqual([
      expect.stringContaining('认领人 QQ: 10002'),
    ])
  })

  it('captures ordinary replies and configured broadcasts from a Mock command', async () => {
    const harness = await createKoishiTestHarness(intakeWithAccess, {
      access: { administrators: [], managementGroups: [] },
      intake: { targets: {
        feedback: { users: [{ qq: '30001' }], groups: [{ qq: '40001' }] },
      } },
    })
    harnesses.push(harness)
    await harness.registerBroadcastTargets(['qq:30001', 'qq:40001'])

    const client = await harness.client({ userId: '10006', channelId: '20001' })
    await expect(client.receive('feedback')).resolves.toEqual([
      '已开始收集。请连续发送文字、图片或附件；单独发送“提交”完成，发送“取消”放弃。',
    ])
    await expect(client.receive('网络断开')).resolves.toEqual(['已收集：1 条消息，0 张图片，0 个其他附件。'])
    await expect(client.receive('提交')).resolves.toEqual(['已提交 反馈#1，管理员通知已送达。'])
    expect(harness.broadcasts).toEqual([
      {
        targets: ['qq:30001'],
        content: expect.stringContaining('[反馈#1] feedback pending'),
      },
      {
        targets: ['qq:30001'],
        content: expect.stringContaining('<message forward>'),
      },
      {
        targets: ['qq:40001'],
        content: expect.stringContaining('[反馈#1] feedback pending'),
      },
      {
        targets: ['qq:40001'],
        content: expect.stringContaining('<message forward>'),
      },
    ])
    await expect(client.receive('intake 反馈#1')).resolves.toEqual([expect.stringContaining('[反馈#1]')])
    const stranger = await harness.client({ userId: '10008', channelId: '20001' })
    await expect(stranger.receive('intake 反馈#1')).resolves.toEqual(['记录不存在或无权查看。'])
  })

  it('authorizes quoted Intake claims and exact work-state actions through persisted message IDs', async () => {
    const harness = await createKoishiTestHarness(intakeWithAccess, {
      access: { administrators: [{ qq: '10001' }, { qq: '10002' }], managementGroups: [{ qq: '20001' }] },
      intake: { targets: { feedback: { users: [{ qq: '30001' }], groups: [] } } },
    })
    harnesses.push(harness)
    await harness.registerBroadcastTargets(['qq:30001', 'qq:10006'])
    const member = await harness.client({ userId: '10006', channelId: '20001' })
    await member.receive('feedback'); await member.receive('需要处理'); await member.receive('提交')
    const mappings = await harness.app.database.get('intakeMessageMap', {})
    const messageId = mappings[0].messageId

    const stranger = await harness.client({ userId: '10003', channelId: '20001' })
    await expect(stranger.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['你不是管理员。'])
    const first = await harness.client({ userId: '10001', channelId: '20001' })
    harness.broadcasts.splice(0)
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['已认领 反馈#1。'])
    expect(harness.broadcasts).toEqual([{
      targets: ['qq:10006'],
      content: expect.stringContaining('反馈#1 已由管理员 10001 认领'),
    }])
    await expect(first.receive('intake 反馈#1')).resolves.toEqual([expect.stringContaining('feedback pending')])
    const second = await harness.client({ userId: '10002', channelId: '20001' })
    await expect(second.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['反馈#1 已由 10001 认领。'])
    expect(harness.broadcasts).toHaveLength(1)
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '这不是管理动作'))).resolves.toEqual([
      expect.stringContaining('未知管理动作'),
    ])
    expect(harness.broadcasts).toHaveLength(1)
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '转交 10002'))).resolves.toEqual([expect.stringContaining('认领人 QQ: 10002')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '取消认领'))).resolves.toEqual([expect.not.stringContaining('认领人 QQ:')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '处理中'))).resolves.toEqual([expect.stringContaining('processing')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '已解决'))).resolves.toEqual([expect.stringContaining('resolved')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '关闭'))).resolves.toEqual([expect.stringContaining('（已关闭）')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '打开'))).resolves.toEqual([expect.not.stringContaining('（已关闭）')])
  })
})
