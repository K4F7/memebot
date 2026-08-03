import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const schema = () => ({ default: () => schema(), description: () => schema() })
  return {
    Schema: {
      object: schema,
      array: () => schema(),
      string: schema,
    },
  }
})

import {
  Activity,
  ActivityService,
  apply,
  buildBroadcastTargets,
  effectiveStatus,
  listVisibleActivities,
  validateActivity,
} from '../src'

const baseActivity: Activity = {
  id: 1,
  title: '例会',
  startAt: new Date('2026-08-02T10:00:00Z'),
  endAt: new Date('2026-08-02T12:00:00Z'),
  status: 'upcoming',
  location: '活动室',
  description: '月度例会',
  link: 'https://example.com',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
}

describe('activity behavior', () => {
  it('validates required fields, time order, status, and links', () => {
    expect(() => validateActivity({ title: '', startAt: '2026-08-02', endAt: '2026-08-03' })).toThrow('标题')
    expect(() => validateActivity({ title: '活动', startAt: '2026-08-03', endAt: '2026-08-02' })).toThrow('晚于')
    expect(() => validateActivity({ title: '活动', startAt: '2026-08-02', endAt: '2026-08-03', link: 'example.com' })).toThrow('http')
  })

  it('derives statuses and lists only upcoming or active activities by start time', () => {
    const now = new Date('2026-08-02T11:00:00Z')
    const active = { ...baseActivity }
    const upcoming = { ...baseActivity, id: 2, startAt: new Date('2026-08-03T10:00:00Z'), endAt: new Date('2026-08-03T12:00:00Z') }
    const ended = { ...baseActivity, id: 3, startAt: new Date('2026-08-01T10:00:00Z'), endAt: new Date('2026-08-01T12:00:00Z') }
    const cancelled = { ...upcoming, id: 4, status: 'cancelled' as const }

    expect(effectiveStatus(active, now)).toBe('active')
    expect(listVisibleActivities([upcoming, ended, cancelled, active], now).map(({ id, status }) => [id, status])).toEqual([
      [1, 'active'],
      [2, 'upcoming'],
    ])
  })

  it('refuses to start without the shared Access service', () => {
    const ctx = {
      model: { extend: vi.fn() },
      command: vi.fn(),
    } as any
    expect(() => apply(ctx, { notificationUsers: [], notificationGroups: [] })).toThrow('memebot-access')
  })

  it('routes optional broadcasts to all configured users and groups', async () => {
    const rows: Activity[] = []
    const broadcast = vi.fn(async () => ['message-1'])
    const ctx = {
      model: {
        create: vi.fn(async (_table, data) => {
          const row = { ...data, id: 1 } as Activity
          rows.push(row)
          return row
        }),
        get: vi.fn(async () => rows),
        set: vi.fn(async () => ({})),
      },
      broadcast,
    } as any
    const config = {
      notificationUsers: [{ qq: '10001' }, { qq: '10002' }],
      notificationGroups: [{ qq: '20001' }, { qq: '10001' }],
    }
    const service = new ActivityService(ctx, config)

    const saved = await service.create(baseActivity, false)
    expect(saved.notification.state).toBe('not-requested')
    expect(broadcast).not.toHaveBeenCalled()
    const notified = await service.create({ ...baseActivity, title: '需要广播' }, true)
    expect(notified.notification.state).toBe('delivered')
    expect(buildBroadcastTargets(config)).toEqual(['qq:10001', 'qq:10002', 'qq:20001'])
    expect(broadcast).toHaveBeenCalledWith(['qq:10001', 'qq:10002', 'qq:20001'], expect.stringContaining('需要广播'))
  })

  it('updates statuses and cancels activities', async () => {
    let row = { ...baseActivity }
    const ctx = {
      model: {
        get: vi.fn(async () => [row]),
        set: vi.fn(async (_table, _query, update) => {
          row = { ...row, ...update }
          return {}
        }),
      },
      broadcast: vi.fn(),
    } as any
    const service = new ActivityService(ctx, {
      notificationUsers: [],
      notificationGroups: [],
    })

    expect((await service.update(1, { status: 'active' })).activity.status).toBe('active')
    expect((await service.cancel(1)).activity.status).toBe('cancelled')
  })

  it('reports persistence and failed or unavailable notification independently', async () => {
    const rows: Activity[] = []
    const ctx = {
      model: {
        create: vi.fn(async (_table, data) => {
          const row = { ...data, id: rows.length + 1 } as Activity
          rows.push(row)
          return row
        }),
      },
      broadcast: vi.fn(async () => { throw new Error('network down') }),
    } as any
    const failed = await new ActivityService(ctx, {
      notificationUsers: [{ qq: '10001' }], notificationGroups: [],
    }).create(baseActivity, true)
    expect(failed.activity.id).toBe(1)
    expect(failed.notification).toEqual({ state: 'failed', targets: ['qq:10001'] })
    expect(rows).toHaveLength(1)

    const unavailable = await new ActivityService(ctx, {
      notificationUsers: [], notificationGroups: [],
    }).create({ ...baseActivity, title: '未配置通知' }, true)
    expect(unavailable.activity.id).toBe(2)
    expect(unavailable.notification).toEqual({ state: 'not-configured', targets: [] })
    expect(rows).toHaveLength(2)
  })
})
