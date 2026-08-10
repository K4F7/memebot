import { relationId } from '../archive/relations'

export type DashboardUser = {
  id?: number | string
} | null | undefined

export type DashboardPayload = {
  count(args: Record<string, unknown>): Promise<{ totalDocs: number }>
  find(args: Record<string, unknown>): Promise<{ docs?: any[]; totalDocs?: number }>
}

export type DashboardWorkSummary = {
  id: string
  archiveId: string
  title: string
  author: string
  updatedAt?: string
}

export type DashboardMediaSummary = {
  id: string
  filename: string
  workId?: string
  workTitle?: string
  workArchiveId?: string
  createdAt?: string
  withdrawnAt?: string
}

export type DashboardStats = {
  totalWorks: number
  incompleteWorks: number
  withdrawnMedia: number
  incompleteWorkItems: DashboardWorkSummary[]
  recentMedia: DashboardMediaSummary[]
}

function authArgs(user: DashboardUser) {
  if (!user) {
    return {
      overrideAccess: true as const,
    }
  }

  return {
    overrideAccess: false as const,
    user,
  }
}

function isWithdrawnMedia(media: unknown): boolean {
  const withdrawnAt = (media as { withdrawnAt?: unknown } | null | undefined)?.withdrawnAt
  return Boolean(withdrawnAt)
}

/**
 * A Work is complete (readable) when it has ≥1 WorkMedia relation to
 * non-withdrawn Media that still belongs to the same Work.
 * Incomplete Works are everything else.
 */
export function isCompleteWork(workId: string, relationships: any[]): boolean {
  return relationships.some((relationship) => {
    if (relationId(relationship?.work) !== workId) return false
    const media = relationship?.media
    if (!media || typeof media !== 'object') return false
    if (isWithdrawnMedia(media)) return false
    if (relationId(media.work) !== workId) return false
    return Boolean(relationId(media))
  })
}

export function summarizeWork(doc: any): DashboardWorkSummary {
  return {
    id: String(doc?.id ?? ''),
    archiveId: String(doc?.archiveId || ''),
    title: String(doc?.title || ''),
    author: String(doc?.author || ''),
    updatedAt: doc?.updatedAt ? String(doc.updatedAt) : undefined,
  }
}

export function summarizeMedia(doc: any): DashboardMediaSummary {
  const work = doc?.work
  const workIsObject = work && typeof work === 'object'
  return {
    id: String(doc?.id ?? ''),
    filename: String(doc?.filename || ''),
    workId: relationId(work),
    workTitle: workIsObject && work.title ? String(work.title) : undefined,
    workArchiveId: workIsObject && work.archiveId ? String(work.archiveId) : undefined,
    createdAt: doc?.createdAt ? String(doc.createdAt) : undefined,
    withdrawnAt: doc?.withdrawnAt ? String(doc.withdrawnAt) : undefined,
  }
}

export async function loadDashboardStats(
  payload: DashboardPayload,
  user: DashboardUser = undefined,
  options: { incompleteLimit?: number; recentLimit?: number } = {},
): Promise<DashboardStats> {
  const incompleteLimit = options.incompleteLimit ?? 8
  const recentLimit = options.recentLimit ?? 8
  const shared = authArgs(user)

  const [worksCount, withdrawnCount, works, relationships, recent] = await Promise.all([
    payload.count({
      collection: 'works',
      ...shared,
    }),
    payload.count({
      collection: 'media',
      ...shared,
      where: {
        withdrawnAt: {
          exists: true,
        },
      },
    }),
    payload.find({
      collection: 'works',
      depth: 0,
      limit: 0,
      pagination: false,
      sort: '-updatedAt',
      ...shared,
    }),
    payload.find({
      collection: 'work-media',
      depth: 1,
      limit: 0,
      pagination: false,
      ...shared,
    }),
    payload.find({
      collection: 'media',
      depth: 1,
      limit: recentLimit,
      pagination: false,
      sort: '-createdAt',
      ...shared,
    }),
  ])

  const workDocs = works.docs || []
  const relationshipDocs = relationships.docs || []
  const incompleteWorkItems = workDocs
    .filter((work) => !isCompleteWork(String(work.id), relationshipDocs))
    .map(summarizeWork)
    .slice(0, incompleteLimit)

  return {
    totalWorks: Number(worksCount.totalDocs || 0),
    incompleteWorks: workDocs.filter((work) => !isCompleteWork(String(work.id), relationshipDocs)).length,
    withdrawnMedia: Number(withdrawnCount.totalDocs || 0),
    incompleteWorkItems,
    recentMedia: (recent.docs || []).map(summarizeMedia),
  }
}
