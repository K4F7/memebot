export const issuePageSizes = [20, 50, 100] as const

export type IssuePageSize = typeof issuePageSizes[number]

export interface IssuesRouteState {
  search: string
  selected: string
  page: number
  pageSize: IssuePageSize
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return scalar(value[0])
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(scalar(value), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function normalizeIssuesRoute(query: Record<string, unknown>): IssuesRouteState {
  const requestedSize = positiveInteger(query.issuePageSize, 20)
  return {
    search: scalar(query.issueSearch).trim(),
    selected: /^P\d+$/.test(scalar(query.issue)) ? scalar(query.issue) : '',
    page: positiveInteger(query.issuePage, 1),
    pageSize: issuePageSizes.includes(requestedSize as IssuePageSize) ? requestedSize as IssuePageSize : 20,
  }
}

export function toIssuesQuery(state: IssuesRouteState): Record<string, string> {
  return {
    tab: 'issues',
    ...(state.search && { issueSearch: state.search }),
    ...(state.selected && { issue: state.selected }),
    issuePage: String(state.page),
    issuePageSize: String(state.pageSize),
  }
}

export function paginateIssues<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize
  return items.slice(start, start + pageSize)
}

export class LatestIssueRequest {
  private sequence = 0

  start() {
    return ++this.sequence
  }

  isCurrent(request: number) {
    return request === this.sequence
  }
}
