'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Gutter, SetStepNav, useConfig } from '@payloadcms/ui'

import { createWorkEditorController, type WorkEditorController } from './controller'
import {
  getPublishGate,
  getSaveGate,
  isImageCard,
  isPdfCard,
  leaveWarningMessage,
  previewCards,
  publicationBadge,
  shouldWarnOnLeave,
} from './state'
import type { EditorCard, EditorSnapshot, MediaCard, UploadCard } from './types'
import './work-editor.css'

function isCreateSegment(value: unknown): boolean {
  return value === 'create'
}

/**
 * Keep one editor session across the create → assigned-id route transition so
 * in-flight uploads are not torn down by Next/Payload remounting the view.
 */
let sessionController: WorkEditorController | null = null
let sessionKey: string | null = null

function acquireEditorSession(workId?: string): WorkEditorController {
  const key = workId || 'create'
  if (sessionController && sessionKey === key) return sessionController
  if (sessionController && sessionKey === 'create' && workId) {
    // Same create session just received a durable id.
    sessionKey = workId
    return sessionController
  }
  if (sessionController && sessionKey && workId && sessionKey === workId) {
    return sessionController
  }
  sessionController?.dispose()
  sessionController = createWorkEditorController({ workId })
  sessionKey = key
  return sessionController
}

export function WorkEditView() {
  const params = useParams()
  const router = useRouter()
  const { config } = useConfig()
  const segments = (params?.segments as string[] | undefined) || []
  // routes: /admin/collections/works/:id or /admin/collections/works/create
  const worksIndex = segments.findIndex((segment) => segment === 'works')
  const idSegment = worksIndex >= 0 ? segments[worksIndex + 1] : segments[segments.length - 1]
  const isCreate = !idSegment || isCreateSegment(idSegment)
  const workId = isCreate ? undefined : idSegment

  const adminRoute = config?.routes?.admin || '/admin'
  const controller = acquireEditorSession(workId)
  const loadedKeyRef = useRef<string | null>(null)

  const [state, setState] = useState<EditorSnapshot>(() => controller.getState())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const replaceTargetRef = useRef<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState)
    const loadKey = workId || 'create'
    // Avoid reloading the durable draft when we only swapped create → id for the same session.
    if (loadedKeyRef.current !== loadKey) {
      const skipReload = loadedKeyRef.current === 'create' && Boolean(workId) && controller.getState().workId === workId
      loadedKeyRef.current = loadKey
      if (!skipReload) void controller.load(workId)
    }
    return () => {
      unsubscribe()
    }
  }, [controller, workId])

  useEffect(() => {
    // After Draft Work creation from the create route, move to the durable document URL.
    if (isCreate && state.workId) {
      sessionKey = state.workId
      router.replace(`${adminRoute}/collections/works/${state.workId}`)
    }
  }, [adminRoute, isCreate, router, state.workId])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldWarnOnLeave(controller.getState())) return
      event.preventDefault()
      event.returnValue = leaveWarningMessage(controller.getState())
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [controller])

  const nav = useMemo(
    () => [
      { label: '作品', url: `${adminRoute}/collections/works` },
      {
        label: state.archiveId || (isCreate ? '新建作品' : '作品编辑'),
        url: undefined,
      },
    ],
    [adminRoute, isCreate, state.archiveId],
  )

  const saveGate = getSaveGate(state)
  const publishGate = getPublishGate(state)
  const badge = publicationBadge(state)
  const preview = previewCards(state)

  const onPickFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList?.length) return
      controller.addFiles(Array.from(fileList))
    },
    [controller],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      onPickFiles(event.dataTransfer.files)
    },
    [onPickFiles],
  )

  return (
    <div className="work-editor" data-work-editor="true">
      <SetStepNav nav={nav} />
      <Gutter>
        <header className="work-editor__header">
          <div>
            <h1 className="work-editor__title">作品编辑</h1>
            <p className="work-editor__subtitle">
              在此管理作品元数据与媒体文件。保存草稿后可预览并显式发布。
            </p>
          </div>
          <div className="work-editor__badge" data-tone={badge.tone} data-testid="publication-badge">
            {badge.label}
          </div>
        </header>

        {state.pageError ? (
          <div className="work-editor__alert work-editor__alert--error" role="alert">
            {state.pageError}
            {state.phase === 'conflict' ? (
              <button
                type="button"
                className="work-editor__button work-editor__button--secondary"
                onClick={() => void controller.refreshAfterConflict()}
              >
                刷新并丢弃本地冲突状态
              </button>
            ) : null}
          </div>
        ) : null}

        {state.actionHint ? (
          <div className="work-editor__alert work-editor__alert--hint" role="status">
            {state.actionHint}
          </div>
        ) : null}

        <section className="work-editor__panel" aria-labelledby="work-meta-heading">
          <h2 id="work-meta-heading">作品信息</h2>
          <div className="work-editor__grid">
            <label className="work-editor__field">
              <span>档案编号</span>
              <input
                value={state.archiveId || '保存后自动分配'}
                readOnly
                data-testid="archive-id"
              />
            </label>
            <label className="work-editor__field">
              <span>标题 *</span>
              <input
                value={state.title}
                onChange={(event) => controller.setTitle(event.target.value)}
                data-testid="work-title"
                required
              />
            </label>
            <label className="work-editor__field">
              <span>作者 *</span>
              <input
                value={state.author}
                onChange={(event) => controller.setAuthor(event.target.value)}
                data-testid="work-author"
                required
              />
            </label>
            <label className="work-editor__field work-editor__field--wide">
              <span>描述（可选）</span>
              <textarea
                value={state.description}
                onChange={(event) => controller.setDescription(event.target.value)}
                rows={3}
                data-testid="work-description"
              />
            </label>
          </div>
        </section>

        <section className="work-editor__panel" aria-labelledby="media-heading">
          <div className="work-editor__panel-header">
            <h2 id="media-heading">媒体文件</h2>
            <span className="work-editor__muted">{state.cards.length} 项</span>
          </div>

          <div
            className="work-editor__dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
            data-testid="upload-dropzone"
          >
            <p>拖放多个图片或 PDF 到此处，或</p>
            <button
              type="button"
              className="work-editor__button"
              onClick={() => fileInputRef.current?.click()}
            >
              选择媒体文件
            </button>
            <p className="work-editor__muted">单个文件不超过 100 MB；不支持 SVG、音视频。</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf"
              multiple
              hidden
              onChange={(event) => {
                onPickFiles(event.target.files)
                event.currentTarget.value = ''
              }}
            />
          </div>

          <ul className="work-editor__cards" data-testid="media-card-list">
            {state.cards.map((card, index) => (
              <li
                key={card.clientId}
                className={[
                  'work-editor__card',
                  card.kind === 'media' && card.pendingRemoval ? 'is-pending-removal' : '',
                  card.kind === 'upload' && card.phase === 'failed' ? 'is-failed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={card.kind === 'media' && !card.pendingRemoval}
                onDragStart={() => {
                  dragIndexRef.current = index
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndexRef.current === null) return
                  controller.reorder(dragIndexRef.current, index)
                  dragIndexRef.current = null
                }}
                data-testid={`media-card-${index}`}
              >
                <MediaCardView
                  card={card}
                  index={index}
                  total={state.cards.length}
                  onMoveUp={() => controller.move(card.clientId, -1)}
                  onMoveDown={() => controller.move(card.clientId, 1)}
                  onRetry={() => {
                    if (card.kind === 'upload') controller.retryUpload(card.clientId)
                    if (card.kind === 'media' && card.replacement) {
                      controller.retryUpload(card.replacement.clientId)
                    }
                  }}
                  onRemove={() => controller.removeCard(card.clientId)}
                  onUndoRemove={() => controller.undoRemove(card.clientId)}
                  onUpdate={(patch) => controller.updateCard(card.clientId, patch)}
                  onReplace={() => {
                    replaceTargetRef.current = card.clientId
                    replaceInputRef.current?.click()
                  }}
                  onDismissDuplicate={() => controller.dismissDuplicate(card.clientId)}
                  onRemoveDuplicate={() => controller.removeCard(card.clientId)}
                />
              </li>
            ))}
          </ul>
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*,application/pdf"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              const target = replaceTargetRef.current
              if (file && target) controller.replaceMedia(target, file)
              replaceTargetRef.current = null
              event.currentTarget.value = ''
            }}
          />
        </section>

        <section className="work-editor__panel" aria-labelledby="preview-heading">
          <h2 id="preview-heading">发布预览</h2>
          <p className="work-editor__muted">预览顺序与草稿媒体文件清单一致（非 QQ 模拟）。</p>
          <ol className="work-editor__preview" data-testid="publication-preview">
            {preview.map((card) => (
              <li key={`preview-${card.clientId}`} className="work-editor__preview-item">
                <PreviewThumb card={card} />
                <div>
                  <strong>{card.basename}.{card.extension}</strong>
                  {card.caption ? <p>{card.caption}</p> : <p className="work-editor__muted">无说明</p>}
                </div>
              </li>
            ))}
            {!preview.length ? <li className="work-editor__muted">暂无媒体文件</li> : null}
          </ol>
        </section>

        <footer className="work-editor__actions">
          <button
            type="button"
            className="work-editor__button work-editor__button--secondary"
            onClick={() => router.push(`${adminRoute}/collections/works`)}
          >
            返回列表
          </button>
          <div className="work-editor__actions-right">
            <div className="work-editor__action-block">
              <button
                type="button"
                className="work-editor__button"
                disabled={!saveGate.allowed}
                onClick={() => void controller.saveDraft()}
                data-testid="save-draft"
              >
                {state.phase === 'saving' ? '保存中…' : '保存草稿'}
              </button>
              {!saveGate.allowed && saveGate.reason ? (
                <span className="work-editor__gate-reason">{saveGate.reason}</span>
              ) : null}
            </div>
            <div className="work-editor__action-block">
              <button
                type="button"
                className="work-editor__button work-editor__button--primary"
                disabled={!publishGate.allowed}
                onClick={() => void controller.publish()}
                data-testid="publish-update"
              >
                {state.phase === 'publishing' ? '发布中…' : '发布更新'}
              </button>
              {!publishGate.allowed && publishGate.reason ? (
                <span className="work-editor__gate-reason">{publishGate.reason}</span>
              ) : null}
            </div>
          </div>
        </footer>
      </Gutter>
    </div>
  )
}

function MediaCardView(props: {
  card: EditorCard
  index: number
  total: number
  onMoveUp: () => void
  onMoveDown: () => void
  onRetry: () => void
  onRemove: () => void
  onUndoRemove: () => void
  onUpdate: (patch: { basename?: string; alt?: string; caption?: string }) => void
  onReplace: () => void
  onDismissDuplicate: () => void
  onRemoveDuplicate: () => void
}) {
  const { card } = props
  if (card.kind === 'upload') {
    return <UploadCardView card={card} onRetry={props.onRetry} onRemove={props.onRemove} />
  }
  return (
    <FinalMediaCardView
      card={card}
      index={props.index}
      total={props.total}
      onMoveUp={props.onMoveUp}
      onMoveDown={props.onMoveDown}
      onRetry={props.onRetry}
      onRemove={props.onRemove}
      onUndoRemove={props.onUndoRemove}
      onUpdate={props.onUpdate}
      onReplace={props.onReplace}
      onDismissDuplicate={props.onDismissDuplicate}
      onRemoveDuplicate={props.onRemoveDuplicate}
    />
  )
}

function UploadCardView(props: {
  card: UploadCard
  onRetry: () => void
  onRemove: () => void
}) {
  const { card } = props
  return (
    <div className="work-editor__card-body">
      <div className="work-editor__thumb work-editor__thumb--placeholder">
        {isPdfCard(card) ? 'PDF' : 'IMG'}
      </div>
      <div className="work-editor__card-main">
        <div className="work-editor__card-title">
          <strong>{card.filename}</strong>
          <span className="work-editor__status" data-phase={card.phase}>
            {uploadPhaseLabel(card.phase)}
          </span>
        </div>
        {card.phase === 'uploading' || card.phase === 'authorizing' || card.phase === 'finalizing' ? (
          <div className="work-editor__progress" aria-valuenow={card.progress} role="progressbar">
            <div style={{ width: `${Math.max(card.progress, 8)}%` }} />
          </div>
        ) : null}
        {card.error ? <p className="work-editor__error">{card.error}</p> : null}
        <div className="work-editor__card-actions">
          {card.phase === 'failed' ? (
            <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onRetry}>
              重试
            </button>
          ) : null}
          <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onRemove}>
            移除
          </button>
        </div>
      </div>
    </div>
  )
}

function FinalMediaCardView(props: {
  card: MediaCard
  index: number
  total: number
  onMoveUp: () => void
  onMoveDown: () => void
  onRetry: () => void
  onRemove: () => void
  onUndoRemove: () => void
  onUpdate: (patch: { basename?: string; alt?: string; caption?: string }) => void
  onReplace: () => void
  onDismissDuplicate: () => void
  onRemoveDuplicate: () => void
}) {
  const { card } = props
  return (
    <div className="work-editor__card-body">
      <PreviewThumb card={card} />
      <div className="work-editor__card-main">
        <div className="work-editor__card-title">
          <label className="work-editor__inline-field">
            <span className="work-editor__sr-only">显示文件名</span>
            <input
              value={card.basename}
              onChange={(event) => props.onUpdate({ basename: event.target.value })}
              disabled={card.pendingRemoval}
              aria-label="显示文件名（不含扩展名）"
            />
            <span className="work-editor__extension">.{card.extension}</span>
          </label>
          {card.pendingRemoval ? <span className="work-editor__status" data-phase="pending-removal">待移除</span> : null}
          {card.replacement ? (
            <span className="work-editor__status" data-phase={card.replacement.phase}>
              替换中：{uploadPhaseLabel(card.replacement.phase)}
            </span>
          ) : null}
        </div>

        {isPdfCard(card) && card.media.previewUrl ? (
          <a className="work-editor__link" href={card.media.previewUrl} target="_blank" rel="noreferrer">
            打开 PDF 预览
          </a>
        ) : null}

        <label className="work-editor__field">
          <span>替代文本</span>
          <input
            value={card.alt}
            onChange={(event) => props.onUpdate({ alt: event.target.value })}
            disabled={card.pendingRemoval}
          />
        </label>
        <label className="work-editor__field">
          <span>说明</span>
          <input
            value={card.caption}
            onChange={(event) => props.onUpdate({ caption: event.target.value })}
            disabled={card.pendingRemoval}
          />
        </label>

        {card.replacement?.error ? <p className="work-editor__error">{card.replacement.error}</p> : null}

        {card.probableDuplicate && !card.probableDuplicate.dismissed ? (
          <div className="work-editor__alert work-editor__alert--hint" role="status">
            可能与已有媒体文件重复（{card.probableDuplicate.filename}）。
            <div className="work-editor__card-actions">
              <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onDismissDuplicate}>
                保留
              </button>
              <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onRemoveDuplicate}>
                移除
              </button>
            </div>
          </div>
        ) : null}

        <div className="work-editor__card-actions">
          <button
            type="button"
            className="work-editor__button work-editor__button--small"
            onClick={props.onMoveUp}
            disabled={props.index === 0 || card.pendingRemoval}
            aria-label="上移"
          >
            上移
          </button>
          <button
            type="button"
            className="work-editor__button work-editor__button--small"
            onClick={props.onMoveDown}
            disabled={props.index >= props.total - 1 || card.pendingRemoval}
            aria-label="下移"
          >
            下移
          </button>
          {!card.pendingRemoval ? (
            <>
              <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onReplace}>
                替换
              </button>
              <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onRemove}>
                移除
              </button>
            </>
          ) : (
            <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onUndoRemove}>
              撤销移除
            </button>
          )}
          {card.replacement?.phase === 'failed' ? (
            <button type="button" className="work-editor__button work-editor__button--small" onClick={props.onRetry}>
              重试替换
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PreviewThumb(props: { card: MediaCard | UploadCard }) {
  const { card } = props
  if (card.kind === 'media') {
    if (isImageCard(card) && card.media.previewUrl) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="work-editor__thumb" src={card.media.previewUrl} alt={card.alt || card.media.filename} />
      )
    }
    return <div className="work-editor__thumb work-editor__thumb--placeholder">{isPdfCard(card) ? 'PDF' : 'FILE'}</div>
  }
  if (card.localPreviewUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className="work-editor__thumb" src={card.localPreviewUrl} alt={card.filename} />
    )
  }
  return <div className="work-editor__thumb work-editor__thumb--placeholder">{isPdfCard(card) ? 'PDF' : 'IMG'}</div>
}

function uploadPhaseLabel(phase: UploadCard['phase']): string {
  switch (phase) {
    case 'queued':
      return '排队中'
    case 'authorizing':
      return '申请上传'
    case 'uploading':
      return '上传中'
    case 'finalizing':
      return '确认中'
    case 'uploaded':
      return '已上传'
    case 'failed':
      return '失败'
    case 'retrying':
      return '重试中'
    case 'cancelled':
      return '已取消'
    default:
      return phase
  }
}

export default WorkEditView
