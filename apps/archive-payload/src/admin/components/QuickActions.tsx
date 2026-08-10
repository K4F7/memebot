import React from 'react'

type QuickActionsProps = {
  createWorkHref: string
  createMediaHref: string
  worksHref: string
  mediaHref: string
}

export function QuickActions({
  createWorkHref,
  createMediaHref,
  worksHref,
  mediaHref,
}: QuickActionsProps) {
  return (
    <section className="mb-archive-panel">
      <div className="mb-archive-panel__header">
        <h2>快捷入口</h2>
        <p>Phase 1 只提供创建入口。后续 Work 工作流可在这里扩展为：基本信息 → 上传媒体 → 调整顺序 → 完成。</p>
      </div>
      <div className="mb-archive-actions">
        <a className="mb-archive-action mb-archive-action--primary" href={createWorkHref}>
          创建 Work
        </a>
        <a className="mb-archive-action" href={createMediaHref}>
          上传 Media
        </a>
        <a className="mb-archive-action mb-archive-action--ghost" href={worksHref}>
          浏览 Works
        </a>
        <a className="mb-archive-action mb-archive-action--ghost" href={mediaHref}>
          浏览 Media
        </a>
      </div>
    </section>
  )
}
