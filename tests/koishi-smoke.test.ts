import { afterEach, describe, expect, it } from 'vitest'

import access from '../plugins/memebot-access/src'
import activity from '../plugins/memebot-activity/src'
import archive, { ArchiveService, type ArchiveSession } from '../plugins/memebot-archive/src'
import faq from '../plugins/memebot-faq/src'
import intake from '../plugins/memebot-intake/src'
import { createDeliveryCapture, createKoishiTestHarness, qqQuotedCommand, type KoishiTestHarness } from './koishi'

const harnesses: KoishiTestHarness[] = []

const activityWithAccess = {
  name: 'test-activity-with-access',
  apply(ctx: any, config: any) {
    access.apply(ctx, config.access)
    return ctx.inject(['access'], (injected: any) => activity.apply(injected, config.activity))
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

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.stop()))
})

describe('standalone plugin command smoke behaviors', () => {
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

  it('drives guided Activity creation with an explicit save-only choice', async () => {
    const harness = await createKoishiTestHarness(activityWithAccess, {
      access: { administrators: [{ qq: '10001' }], managementGroups: [{ qq: '20001' }] },
      activity: { notificationUsers: [{ qq: '30001' }], notificationGroups: [] },
    })
    harnesses.push(harness)
    const client = await harness.client({ userId: '10001', channelId: '20001' })
    const started = client.receive('activity.add')
    for (const input of ['例会', '2027-08-02T10:00:00Z', '2027-08-02T12:00:00Z', '-', '-', '-', '仅保存']) {
      await new Promise<void>(resolve => setImmediate(resolve))
      void client.receive(input)
    }
    await expect(started).resolves.toEqual(expect.arrayContaining([
      '请输入活动标题。', expect.stringContaining('请选择“仅保存”或“保存并通知”'), expect.stringContaining('活动创建成功'),
    ]))
    expect(harness.broadcasts).toEqual([])
    await expect(client.receive('activity #1')).resolves.toEqual([expect.stringContaining('活动 #1：例会')])
  })

  it('loads archive and browses issues through a Mock session', async () => {
    const harness = await createKoishiTestHarness(archive, {})
    harnesses.push(harness)

    const client = await harness.client({ userId: '10002', channelId: '20001' })
    await expect(client.receive('archive.issues')).resolves.toEqual([
      '没有找到 Newspaper Issue。',
    ])
  })

  it('navigates Publication Appearances and related search through a Mock session', async () => {
    const harness = await createKoishiTestHarness(archive, {})
    harnesses.push(harness)
    const service = harness.pluginResult as ArchiveService
    const client = await harness.client({ userId: '10002', channelId: '20001' })
    await client.receive('archive.issues')
    service.db.issues.push({ id: 'P1', issueNumber: '1', month: '2026-08', title: 'Issue', publishedAt: new Date(), lifecycle: 'active' })
    service.db.works.push({ id: 'W1', title: 'Work', author: 'Alice', description: 'Related description', publishedAt: new Date(), lifecycle: 'active' })
    await service.associateWork({ authority: 4 }, 'P1', { workId: 'W1', page: '3', section: 'Features', displayOrder: 1 })
    expect(service.searchIssues('Alice').map(item => item.id)).toEqual(['P1'])

    await expect(client.receive('archive.search paper Alice')).resolves.toEqual([expect.stringContaining('P1 2026-08 第1期 Issue')])
    await expect(client.receive('archive.search works Related')).resolves.toEqual([expect.stringContaining('W1 Alice - Work')])
    await expect(client.receive('archive P1')).resolves.toEqual([expect.stringContaining('W1 Alice - Work · 第3页 · Features')])
    await expect(service.associateWork({ authority: 1 }, 'P1', { workId: 'W1' })).rejects.toThrow('permission')
  })

  it('shows the Archive target and requires explicit confirmation before soft deletion', async () => {
    const harness = await createKoishiTestHarness(archive, { administrators: [{ qq: '10002' }], managementGroups: [] })
    harnesses.push(harness)
    const service = harness.pluginResult as ArchiveService
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
    const harness = await createKoishiTestHarness(archive, {})
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
    const harness = await createKoishiTestHarness(archive, {})
    harnesses.push(harness)
    const issue = {
      id: 'issue-2026-08',
      issueNumber: '8',
      month: '2026-08',
      title: '八月刊',
      publishedAt: new Date('2026-08-01T00:00:00Z'),
    }
    const service = harness.pluginResult
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

  it('loads FAQ and lists entries through a Mock session', async () => {
    const harness = await createKoishiTestHarness(faqWithAccess, {
      access: { administrators: [], managementGroups: [] }, faq: { pageSize: 10 },
    })
    harnesses.push(harness)

    const client = await harness.client({ userId: '10003', channelId: '20001' })
    await expect(client.receive('faq')).resolves.toEqual(['暂无公开 FAQ。'])
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

    const administrator = await harness.client({ userId: '10005', channelId: 'unlisted' })
    await expect(administrator.receive(`faq #${entry.id}`)).resolves.toEqual([
      `FAQ #${entry.id}\n问题：隐藏问题\n答案：隐藏答案`,
    ])
    await expect(administrator.receive('faq.manage')).resolves.toEqual(['1. [隐藏] 隐藏问题'])
    await expect(administrator.receive(`faq.rm #${entry.id}`)).resolves.toEqual([
      '此群不是管理群，请私聊操作或先添加该群。',
    ])
  })

  it('drives the guided FAQ add flow through Mock prompts', async () => {
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
  })

  it('loads intake and invokes an administrator command through a Mock session', async () => {
    const harness = await createKoishiTestHarness(intake, {})
    harnesses.push(harness)

    const client = await harness.client({ userId: '10004', channelId: '20001', authority: 4 })
    await expect(client.receive('intake.admin.list')).resolves.toEqual(['暂无记录。'])
    const member = await harness.client({ userId: '10007', channelId: '20001' })
    await expect(member.receive('feedback')).resolves.toEqual(['此类型尚未配置通知目标，暂时无法开始收集。'])
  })

  it('captures ordinary replies and configured broadcasts from a Mock command', async () => {
    const harness = await createKoishiTestHarness(intake, {
      targets: {
        feedback: { users: [{ qq: '30001' }], groups: [{ qq: '40001' }] },
      },
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
    const harness = await createKoishiTestHarness(intake, {
      targets: { feedback: { users: [{ qq: '30001' }], groups: [] } },
      administrators: [{ qq: '10001' }, { qq: '10002' }], managementGroups: [],
    })
    harnesses.push(harness)
    await harness.registerBroadcastTargets(['qq:30001', 'qq:10006'])
    const member = await harness.client({ userId: '10006', channelId: '20001' })
    await member.receive('feedback'); await member.receive('需要处理'); await member.receive('提交')
    const mappings = await harness.app.database.get('intakeMessageMap', {})
    const messageId = mappings[0].messageId

    const stranger = await harness.client({ userId: '10003', channelId: '20001' })
    await expect(stranger.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['没有权限。'])
    const first = await harness.client({ userId: '10001', channelId: '20001' })
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['已认领 反馈#1。'])
    const second = await harness.client({ userId: '10002', channelId: '20001' })
    await expect(second.receive(qqQuotedCommand(messageId, '管理通知', '认领'))).resolves.toEqual(['反馈#1 已由 10001 认领。'])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '转交 10002'))).resolves.toEqual([expect.stringContaining('认领人 QQ: 10002')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '取消认领'))).resolves.toEqual([expect.not.stringContaining('认领人 QQ:')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '已解决'))).resolves.toEqual([expect.stringContaining('resolved')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '关闭'))).resolves.toEqual([expect.stringContaining('（已关闭）')])
    await expect(first.receive(qqQuotedCommand(messageId, '管理通知', '打开'))).resolves.toEqual([expect.not.stringContaining('（已关闭）')])
  })
})
