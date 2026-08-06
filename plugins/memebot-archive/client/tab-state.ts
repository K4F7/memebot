export const archiveTabs = [
  { id: 'issues', label: '报纸期数' },
  { id: 'works', label: '收录作品' },
  { id: 'ops', label: '运维' },
] as const

export type ArchiveTab = typeof archiveTabs[number]['id']

export function normalizeArchiveTab(value: unknown): ArchiveTab {
  const candidate = Array.isArray(value) ? value[0] : value
  return archiveTabs.some(tab => tab.id === candidate) ? candidate as ArchiveTab : 'issues'
}

export function toArchiveTabQuery(tab: ArchiveTab): Record<string, string> {
  return { tab }
}
