export const archiveTabs = [
  { id: 'issues', label: 'Newspaper Issues' },
  { id: 'works', label: 'Works' },
  { id: 'storage', label: '存储与恢复' },
  { id: 'lifecycle', label: '生命周期审计' },
] as const

export type ArchiveTab = typeof archiveTabs[number]['id']

export function normalizeArchiveTab(value: unknown): ArchiveTab {
  const candidate = Array.isArray(value) ? value[0] : value
  return archiveTabs.some(tab => tab.id === candidate) ? candidate as ArchiveTab : 'issues'
}

export function toArchiveTabQuery(tab: ArchiveTab): Record<string, string> {
  return { tab }
}
