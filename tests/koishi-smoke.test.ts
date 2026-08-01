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
    await expect(client.receive('activity.list')).resolves.toEqual([
      '暂无即将开始或进行中的活动。',
    ])
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
      adminUserIds: ['10003', '10005'],
      adminGroupIds: [],
      minAuthority: 4,
      pageSize: 10,
    })
    harnesses.push(harness)

    const denied = await harness.client({ userId: '10003', channelId: '20001', authority: 3 })
    await expect(denied.receive('faq.admin.list')).resolves.toEqual([
      '只有管理员白名单中的四级及以上用户可以管理 FAQ。',
    ])

    const allowed = await harness.client({ userId: '10005', channelId: '20001', authority: 4 })
    await expect(allowed.receive('faq.admin.list')).resolves.toEqual(['暂无 FAQ。'])
  })

  it('loads intake and invokes an administrator command through a Mock session', async () => {
    const harness = await createKoishiTestHarness(intake, {})
    harnesses.push(harness)

    const client = await harness.client({ userId: '10004', channelId: '20001', authority: 4 })
    await expect(client.receive('intake.admin.list')).resolves.toEqual(['暂无记录。'])
  })

  it('captures ordinary replies and configured broadcasts from a Mock command', async () => {
    const harness = await createKoishiTestHarness(intake, {
      targets: {
        feedback: { users: ['30001'], groups: ['40001'] },
      },
    })
    harnesses.push(harness)
    await harness.registerBroadcastTargets(['qq:30001', 'qq:40001'])

    const client = await harness.client({ userId: '10006', channelId: '20001' })
    await expect(client.receive('intake.feedback 网络断开')).resolves.toEqual([
      '已受理 FDB-000001，当前状态：pending。',
    ])
    expect(harness.broadcasts).toEqual([
      {
        targets: ['qq:30001'],
        content: expect.stringContaining('[FDB-000001] feedback pending'),
      },
      {
        targets: ['qq:40001'],
        content: expect.stringContaining('[FDB-000001] feedback pending'),
      },
    ])
  })
})
