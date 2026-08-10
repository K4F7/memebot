import React from 'react'

import type { DashboardWorkSummary } from '../dashboard-stats'

type IncompleteWorksProps = {
  items: DashboardWorkSummary[]
  total: number
  createWorkHref: string
  workHref: (id: string) => string
}

export function IncompleteWorks({ items, total, createWorkHref, workHref }: IncompleteWorksProps) {
  return (
    <section className="mb-archive-panel">
      <div className="mb-archive-panel__header">
        <h2>待补媒体的 Work</h2>
        <p>尚无有效 WorkMedia（指向未撤回 Media）的 Work，不满足 Archive 读合同。</p>
      </div>
      {items.length === 0 ? (
        <div className="mb-archive-empty">
          <p>当前没有待补媒体的 Work。</p>
          <a href={createWorkHref}>创建新的 Work</a>
        </div>
      ) : (
        <>
          <ul className="mb-archive-list">
            {items.map((item) => (
              <li key={item.id}>
                <a href={workHref(item.id)}>
                  <strong>{item.archiveId || item.id}</strong>
                  <span>{item.title || '未命名 Work'}</span>
                  <em>{item.author || '未知作者'}</em>
                </a>
              </li>
            ))}
          </ul>
          {total > items.length ? (
            <p className="mb-archive-panel__footer">另有 {total - items.length} 个未全部列出。</p>
          ) : null}
        </>
      )}
    </section>
  )
}
