import type { AdminViewServerProps } from 'payload'
import { Gutter } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import React from 'react'

import { IncompleteWorks } from './components/IncompleteWorks'
import { QuickActions } from './components/QuickActions'
import { RecentMedia } from './components/RecentMedia'
import { StatCard } from './components/StatCard'
import { loadDashboardStats } from './dashboard-stats'

/**
 * Phase 1 Admin homepage skeleton.
 *
 * Reserved future Work workflow steps (not implemented here):
 * 1. 基本信息
 * 2. 上传媒体
 * 3. 调整顺序
 * 4. 完成
 *
 * Do not invent draft/publish states in this phase.
 */
export default async function Dashboard(props: AdminViewServerProps) {
  const {
    initPageResult: {
      req: {
        payload,
        user,
        payload: {
          config: {
            routes: { admin: adminRoute },
            serverURL,
          },
        },
      },
    },
  } = props

  const stats = await loadDashboardStats(payload, user)

  const collectionPath = (slug: string, suffix: '' | '/create' = '') =>
    formatAdminURL({
      adminRoute,
      path: `/collections/${slug}${suffix}`,
      serverURL,
      relative: true,
    })

  const documentPath = (slug: string, id: string) =>
    formatAdminURL({
      adminRoute,
      path: `/collections/${slug}/${id}`,
      serverURL,
      relative: true,
    })

  const createWorkHref = collectionPath('works', '/create')
  const createMediaHref = collectionPath('media', '/create')
  const worksHref = collectionPath('works')
  const mediaHref = collectionPath('media')

  return (
    <Gutter className="dashboard mb-archive-dashboard">
      <header className="mb-archive-dashboard__hero">
        <div>
          <p className="mb-archive-dashboard__eyebrow">Archive operations</p>
          <h1>MemeBot 档案管理</h1>
          <p className="mb-archive-dashboard__lede">
            以 Work / Media / WorkMedia 为中心的运营首页。创建后请补齐媒体关系；已撤回 Media 会保留审计痕迹，不会物理删除。
          </p>
        </div>
      </header>

      <div className="mb-archive-stats">
        <StatCard
          label="Work 总数"
          value={stats.totalWorks}
          hint="全部 Work 记录"
          href={worksHref}
        />
        <StatCard
          label="待补媒体的 Work"
          value={stats.incompleteWorks}
          hint="尚无有效可读媒体"
          href={worksHref}
          tone={stats.incompleteWorks > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="已撤回 Media"
          value={stats.withdrawnMedia}
          hint="保留元数据与 R2 对象"
          href={mediaHref}
          tone={stats.withdrawnMedia > 0 ? 'muted' : 'default'}
        />
      </div>

      <QuickActions
        createWorkHref={createWorkHref}
        createMediaHref={createMediaHref}
        worksHref={worksHref}
        mediaHref={mediaHref}
      />

      <div className="mb-archive-grid">
        <IncompleteWorks
          items={stats.incompleteWorkItems}
          total={stats.incompleteWorks}
          createWorkHref={createWorkHref}
          workHref={(id) => documentPath('works', id)}
        />
        <RecentMedia
          items={stats.recentMedia}
          createMediaHref={createMediaHref}
          mediaHref={(id) => documentPath('media', id)}
        />
      </div>
    </Gutter>
  )
}
