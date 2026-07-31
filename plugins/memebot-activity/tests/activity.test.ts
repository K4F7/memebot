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
  buildBroadcastTargets,
  effectiveStatus,
  isAdministrator,
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

  it('requires both authority and an administrator whitelist match', () => {
    const config = { adminUserIds: ['10001'], adminGroupIds: ['20001'] }
    expect(isAdministrator({ userId: '10001', user: { authority: 4 } }, config)).toBe(true)
    expect(isAdministrator({ guildId: '20001', user: { authority: 4 } }, config)).toBe(true)
    expect(isAdministrator({ userId: '10001', user: { authority: 3 } }, config)).toBe(false)
    expect(isAdministrator({ userId: 'other', user: { authority: 5 } }, config)).toBe(false)
  })

  it('routes optional broadcasts to all configured users and groups', async () => {
    const rows: Activity[] = []
    const broadcast = vi.fn(async () => [])
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
      adminUserIds: [],
      adminGroupIds: [],
      broadcastUserIds: ['10001', '10002'],
      broadcastGroupIds: ['20001', '10001'],
      broadcastPlatform: 'qq',
    }
    const service = new ActivityService(ctx, config)

    await service.create(baseActivity, false)
    expect(broadcast).not.toHaveBeenCalled()
    await service.create({ ...baseActivity, title: '需要广播' }, true)
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
      adminUserIds: [],
      adminGroupIds: [],
      broadcastUserIds: [],
      broadcastGroupIds: [],
      broadcastPlatform: 'qq',
    })

    expect((await service.update(1, { status: 'active' })).status).toBe('active')
    expect((await service.cancel(1)).status).toBe('cancelled')
  })
})
