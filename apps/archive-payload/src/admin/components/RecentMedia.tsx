import React from 'react'

import type { DashboardMediaSummary } from '../dashboard-stats'

type RecentMediaProps = {
  items: DashboardMediaSummary[]
  createMediaHref: string
  mediaHref: (id: string) => string
}

function formatTime(value?: string): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function RecentMedia({ items, createMediaHref, mediaHref }: RecentMediaProps) {
  return (
    <section className="mb-archive-panel">
      <div className="mb-archive-panel__header">
        <h2>最近上传</h2>
        <p>最近创建的 Media，包含文件名、所属 Work 与时间。</p>
      </div>
      {items.length === 0 ? (
        <div className="mb-archive-empty">
          <p>还没有 Media。先创建 Work，再上传媒体。</p>
          <a href={createMediaHref}>上传 Media</a>
        </div>
      ) : (
        <ul className="mb-archive-list">
          {items.map((item) => (
            <li key={item.id}>
              <a href={mediaHref(item.id)}>
                <strong>{item.filename || `Media #${item.id}`}</strong>
                <span>
                  {item.workArchiveId || item.workTitle
                    ? `${item.workArchiveId || ''}${item.workArchiveId && item.workTitle ? ' · ' : ''}${item.workTitle || ''}`
                    : '未关联 Work'}
                </span>
                <em>{formatTime(item.createdAt)}</em>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
