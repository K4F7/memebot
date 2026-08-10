import { describe, expect, it, vi } from 'vitest'

import {
  isCompleteWork,
  loadDashboardStats,
  summarizeMedia,
  summarizeWork,
  type DashboardPayload,
} from './dashboard-stats'

describe('dashboard completeness helpers', () => {
  it('treats a work as complete only with WorkMedia to non-withdrawn media of the same work', () => {
    const relationships = [
      {
        work: 1,
        media: { id: 10, work: 1, withdrawnAt: null },
      },
      {
        work: 2,
        media: { id: 11, work: 2, withdrawnAt: '2026-01-01T00:00:00.000Z' },
      },
      {
        work: 3,
        media: { id: 12, work: 99, withdrawnAt: null },
      },
    ]

    expect(isCompleteWork('1', relationships)).toBe(true)
    expect(isCompleteWork('2', relationships)).toBe(false)
    expect(isCompleteWork('3', relationships)).toBe(false)
    expect(isCompleteWork('4', relationships)).toBe(false)
  })

  it('summarizes works and media for dashboard cards', () => {
    expect(summarizeWork({
      id: 7,
      archiveId: 'W7',
      title: 'Poster',
      author: 'Ada',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })).toEqual({
      id: '7',
      archiveId: 'W7',
      title: 'Poster',
      author: 'Ada',
      updatedAt: '2026-08-01T00:00:00.000Z',
    })

    expect(summarizeMedia({
      id: 3,
      filename: 'cover.png',
      createdAt: '2026-08-02T00:00:00.000Z',
      work: { id: 7, archiveId: 'W7', title: 'Poster' },
    })).toEqual({
      id: '3',
      filename: 'cover.png',
      workId: '7',
      workTitle: 'Poster',
      workArchiveId: 'W7',
      createdAt: '2026-08-02T00:00:00.000Z',
      withdrawnAt: undefined,
    })
  })
})

describe('loadDashboardStats', () => {
  it('counts incomplete works and withdrawn media from Local API results', async () => {
    const payload: DashboardPayload = {
      count: vi.fn(async (args) => {
        if (args.collection === 'works') return { totalDocs: 3 }
        if (args.collection === 'media') return { totalDocs: 1 }
        return { totalDocs: 0 }
      }),
      find: vi.fn(async (args) => {
        if (args.collection === 'works') {
          return {
            docs: [
              { id: 1, archiveId: 'W1', title: 'Complete', author: 'A' },
              { id: 2, archiveId: 'W2', title: 'Incomplete', author: 'B' },
              { id: 3, archiveId: 'W3', title: 'Withdrawn only', author: 'C' },
            ],
          }
        }
        if (args.collection === 'work-media') {
          return {
            docs: [
              { work: 1, media: { id: 10, work: 1, withdrawnAt: null } },
              { work: 3, media: { id: 11, work: 3, withdrawnAt: '2026-01-01T00:00:00.000Z' } },
            ],
          }
        }
        if (args.collection === 'media') {
          return {
            docs: [
              {
                id: 20,
                filename: 'latest.pdf',
                createdAt: '2026-08-03T00:00:00.000Z',
                work: { id: 1, archiveId: 'W1', title: 'Complete' },
              },
            ],
          }
        }
        return { docs: [] }
      }),
    }

    const stats = await loadDashboardStats(payload, { id: 1 })

    expect(stats.totalWorks).toBe(3)
    expect(stats.incompleteWorks).toBe(2)
    expect(stats.withdrawnMedia).toBe(1)
    expect(stats.incompleteWorkItems.map((item) => item.archiveId)).toEqual(['W2', 'W3'])
    expect(stats.recentMedia[0]).toMatchObject({
      filename: 'latest.pdf',
      workArchiveId: 'W1',
    })

    expect(payload.count).toHaveBeenCalledWith(expect.objectContaining({
      collection: 'works',
      overrideAccess: false,
      user: { id: 1 },
    }))
    expect(payload.count).toHaveBeenCalledWith(expect.objectContaining({
      collection: 'media',
      where: { withdrawnAt: { exists: true } },
      overrideAccess: false,
      user: { id: 1 },
    }))
  })

  it('returns empty incomplete and recent lists when there is no content', async () => {
    const payload: DashboardPayload = {
      count: vi.fn(async () => ({ totalDocs: 0 })),
      find: vi.fn(async () => ({ docs: [] })),
    }

    const stats = await loadDashboardStats(payload, { id: 1 })

    expect(stats).toEqual({
      totalWorks: 0,
      incompleteWorks: 0,
      withdrawnMedia: 0,
      incompleteWorkItems: [],
      recentMedia: [],
    })
  })
})
