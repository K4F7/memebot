import { afterEach, describe, expect, it } from 'vitest'

import activity from '../plugins/memebot-activity/src'
import archive, { type ArchiveSession } from '../plugins/memebot-archive/src'
import faq from '../plugins/memebot-faq/src'
import intake from '../plugins/memebot-intake/src'
import { createDeliveryCapture, createKoishiTestHarness, qqQuotedCommand, type KoishiTestHarness } from './koishi'

const harnesses: KoishiTestHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.stop()))
})

describe('standalone plugin command smoke behaviors', () => {
  it('loads activity and lists activities through a Mock session', async () => {
    const harness = await createKoishiTestHarness(activity, {})
    harnesses.push(harness)

    const client = await harness.client({ userId: '10001', channelId: '20001' })
    await expect(client.receive('activity')).resolves.toEqual([
      '暂无即将开始或进行中的活动。',
    ])
  })

  it('drives guided Activity creation with an explicit save-only choice', async () => {
    const harness = await createKoishiTestHarness(activity, {
      administrators: [{ qq: '10001' }], managementGroups: [], notificationUsers: [{ qq: '30001' }], notificationGroups: [],
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
    const harness = await createKoishiTestHarness(faq, {})
    harnesses.push(harness)

    const client = await harness.client({ userId: '10003', channelId: '20001' })
    await expect(client.receive('faq')).resolves.toEqual(['暂无公开 FAQ。'])
  })

  it('drives plugin permission checks with Mock user authority', async () => {
    const harness = await createKoishiTestHarness(faq, {
      administrators: [{ qq: '10005' }],
      managementGroups: [],
      pageSize: 10,
    })
    harnesses.push(harness)

    const denied = await harness.client({ userId: '10003', channelId: '20001', authority: 3 })
    await expect(denied.receive('faq.manage')).resolves.toEqual([
      '只有显式管理员 QQ 或 authority 4 用户可在管理位置管理 FAQ。',
    ])

    const allowed = await harness.client({ userId: '10005', channelId: '20001', authority: 4 })
    await expect(allowed.receive('faq.manage')).resolves.toEqual(['暂无 FAQ。'])
  })

  it('drives the guided FAQ add flow through Mock prompts', async () => {
    const harness = await createKoishiTestHarness(faq, {
      administrators: [{ qq: '10005' }], managementGroups: [], pageSize: 10,
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
        targets: ['qq:40001'],
        content: expect.stringContaining('[反馈#1] feedback pending'),
      },
    ])
    await expect(client.receive('intake 反馈#1')).resolves.toEqual([expect.stringContaining('[反馈#1]')])
    const stranger = await harness.client({ userId: '10008', channelId: '20001' })
    await expect(stranger.receive('intake 反馈#1')).resolves.toEqual(['记录不存在或无权查看。'])
  })
})
