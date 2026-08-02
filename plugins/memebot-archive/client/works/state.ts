export const workPageSizes = [20, 50, 100] as const

export type WorkPageSize = typeof workPageSizes[number]

export interface WorksRouteState {
  search: string
  selected: string
  page: number
  pageSize: WorkPageSize
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value[0])
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(scalar(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function normalizeWorksRoute(query: Record<string, unknown>): WorksRouteState {
  const requestedSize = positiveInteger(query.workPageSize, 20)
  return {
    search: scalar(query.workSearch).trim(),
    selected: /^W\d+$/.test(scalar(query.work)) ? scalar(query.work) : '',
    page: positiveInteger(query.workPage, 1),
    pageSize: workPageSizes.includes(requestedSize as WorkPageSize) ? requestedSize as WorkPageSize : 20,
  }
}

export function toWorksQuery(state: WorksRouteState): Record<string, string> {
  return {
    tab: 'works',
    ...(state.search && { workSearch: state.search }),
    ...(state.selected && { work: state.selected }),
    workPage: String(state.page),
    workPageSize: String(state.pageSize),
  }
}

export function paginateWorks<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export class LatestRequest {
  private sequence = 0

  start() {
    return ++this.sequence
  }

  isCurrent(request: number) {
    return request === this.sequence
  }
}
