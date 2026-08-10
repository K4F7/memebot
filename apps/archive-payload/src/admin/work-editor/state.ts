import {
  joinFilename,
  splitFilename,
  type MediaManifestItem,
  type WorkAggregate,
} from '../../authoring/contract'
import { isImageMime, isPdfMime, validateSelectedFile } from './file-policy'
import type {
  AggregatePhase,
  EditorCard,
  EditorSnapshot,
  MediaCard,
  PublishGate,
  UploadCard,
  UploadPhase,
} from './types'

export type { EditorSnapshot, EditorCard, MediaCard, UploadCard, AggregatePhase, PublishGate }

let clientSeq = 0

export function resetClientIdSeq(next = 0): void {
  clientSeq = next
}

function nextClientId(prefix: string): string {
  clientSeq += 1
  return `${prefix}-${clientSeq}`
}

export function createEmptyEditorState(): EditorSnapshot {
  return {
    phase: 'idle',
    publicationStatus: 'draft',
    title: '',
    author: '',
    description: '',
    cards: [],
    dirty: false,
    loaded: false,
  }
}

function mediaToCard(media: MediaManifestItem): MediaCard {
  const { basename, extension } = splitFilename(media.filename)
  return {
    kind: 'media',
    clientId: nextClientId('media'),
    media,
    basename: basename || media.filename,
    extension: extension || media.extension,
    alt: media.alt || '',
    caption: media.caption || '',
    pendingRemoval: false,
    dirty: false,
  }
}

export function hydrateFromAggregate(aggregate: WorkAggregate): EditorSnapshot {
  return {
    phase: aggregate.publicationStatus === 'published' ? 'published' : 'ready',
    workId: aggregate.workId,
    archiveId: aggregate.archiveId,
    revision: aggregate.revision,
    baselineRevision: aggregate.revision,
    publicationStatus: aggregate.publicationStatus,
    title: aggregate.title,
    author: aggregate.author,
    description: aggregate.description || '',
    cards: aggregate.media.map(mediaToCard),
    published: aggregate.published,
    dirty: false,
    loaded: true,
  }
}

function markDirty(state: EditorSnapshot, phase: AggregatePhase = 'dirty'): EditorSnapshot {
  if (state.phase === 'conflict') {
    return { ...state, dirty: true }
  }
  return { ...state, dirty: true, phase, pageError: undefined, actionHint: undefined }
}

export function setMetadata(
  state: EditorSnapshot,
  patch: Partial<Pick<EditorSnapshot, 'title' | 'author' | 'description'>>,
): EditorSnapshot {
  const next = {
    ...state,
    ...patch,
  }
  const changed =
    next.title !== state.title || next.author !== state.author || next.description !== state.description
  if (!changed) return state
  return markDirty(next)
}

export function canStartUpload(state: EditorSnapshot): { ok: boolean; reason?: string } {
  if (!state.title.trim() || !state.author.trim()) {
    return { ok: false, reason: '请先填写标题和作者，再上传媒体文件。' }
  }
  if (state.phase === 'conflict') {
    return { ok: false, reason: '存在版本冲突，请先刷新后再上传。' }
  }
  if (state.phase === 'loading' || state.phase === 'creating' || state.phase === 'saving' || state.phase === 'publishing') {
    return { ok: false, reason: '当前操作进行中，请稍候。' }
  }
  return { ok: true }
}

export function enqueueFiles(
  state: EditorSnapshot,
  files: File[],
  options: { replaceMediaClientId?: string } = {},
): { state: EditorSnapshot; rejected: Array<{ name: string; message: string }>; accepted: UploadCard[] } {
  const gate = canStartUpload(state)
  if (!gate.ok) {
    return {
      state: { ...state, actionHint: gate.reason },
      rejected: files.map((file) => ({ name: file.name, message: gate.reason || '无法上传。' })),
      accepted: [],
    }
  }

  if (options.replaceMediaClientId) {
    return enqueueReplacement(state, files[0], options.replaceMediaClientId)
  }

  const rejected: Array<{ name: string; message: string }> = []
  const accepted: UploadCard[] = []
  const baseIndex = state.cards.length

  files.forEach((file, offset) => {
    const validation = validateSelectedFile(file)
    if (!validation.ok) {
      rejected.push({ name: file.name, message: validation.message || '文件无效。' })
      return
    }
    const card: UploadCard = {
      kind: 'upload',
      clientId: nextClientId('upload'),
      selectionIndex: baseIndex + offset,
      file,
      filename: file.name,
      extension: validation.extension || splitFilename(file.name).extension,
      mimeType: validation.mimeType || file.type,
      filesize: file.size,
      phase: 'queued',
      progress: 0,
      idempotencyKey: `idem-${Date.now()}-${clientSeq}-${offset}`,
      localPreviewUrl: isImageMime(validation.mimeType || file.type)
        ? URL.createObjectURL(file)
        : undefined,
    }
    accepted.push(card)
  })

  if (!accepted.length) {
    return {
      state: {
        ...state,
        actionHint: rejected[0]?.message,
      },
      rejected,
      accepted,
    }
  }

  return {
    state: markDirty({
      ...state,
      cards: [...state.cards, ...accepted],
      actionHint: rejected.length ? rejected.map((item) => `${item.name}: ${item.message}`).join('；') : undefined,
    }),
    rejected,
    accepted,
  }
}

function enqueueReplacement(
  state: EditorSnapshot,
  file: File | undefined,
  mediaClientId: string,
): { state: EditorSnapshot; rejected: Array<{ name: string; message: string }>; accepted: UploadCard[] } {
  if (!file) {
    return { state, rejected: [], accepted: [] }
  }
  const index = state.cards.findIndex((card) => card.clientId === mediaClientId && card.kind === 'media')
  if (index < 0) {
    return {
      state: { ...state, actionHint: '找不到要替换的媒体文件。' },
      rejected: [{ name: file.name, message: '找不到要替换的媒体文件。' }],
      accepted: [],
    }
  }
  const mediaCard = state.cards[index] as MediaCard
  if (mediaCard.pendingRemoval) {
    return {
      state: { ...state, actionHint: '已标记移除的媒体文件不能替换，请先撤销移除。' },
      rejected: [{ name: file.name, message: '已标记移除的媒体文件不能替换。' }],
      accepted: [],
    }
  }
  const validation = validateSelectedFile(file)
  if (!validation.ok) {
    return {
      state: { ...state, actionHint: validation.message },
      rejected: [{ name: file.name, message: validation.message || '文件无效。' }],
      accepted: [],
    }
  }
  const replacement: UploadCard = {
    kind: 'upload',
    clientId: nextClientId('replace'),
    selectionIndex: index,
    file,
    filename: file.name,
    extension: validation.extension || splitFilename(file.name).extension,
    mimeType: validation.mimeType || file.type,
    filesize: file.size,
    phase: 'queued',
    progress: 0,
    idempotencyKey: `idem-replace-${Date.now()}-${clientSeq}`,
    replaceMediaId: mediaCard.media.mediaId,
    localPreviewUrl: isImageMime(validation.mimeType || file.type)
      ? URL.createObjectURL(file)
      : undefined,
  }
  const cards = state.cards.slice()
  cards[index] = { ...mediaCard, replacement }
  return {
    state: markDirty({ ...state, cards }),
    rejected: [],
    accepted: [replacement],
  }
}

function mapCards(state: EditorSnapshot, clientId: string, mapper: (card: EditorCard) => EditorCard): EditorSnapshot {
  return {
    ...state,
    cards: state.cards.map((card) => {
      if (card.clientId === clientId) return mapper(card)
      if (card.kind === 'media' && card.replacement?.clientId === clientId) {
        return { ...card, replacement: mapper(card.replacement) as UploadCard }
      }
      return card
    }),
  }
}

export function setUploadPhase(
  state: EditorSnapshot,
  clientId: string,
  phase: UploadPhase,
  patch: Partial<UploadCard> = {},
): EditorSnapshot {
  return mapCards(state, clientId, (card) => {
    if (card.kind !== 'upload') return card
    return {
      ...card,
      ...patch,
      phase,
      error: phase === 'failed' ? patch.error || card.error : undefined,
      errorCode: phase === 'failed' ? patch.errorCode || card.errorCode : undefined,
    }
  })
}

export function applyFinalizedUpload(
  state: EditorSnapshot,
  clientId: string,
  aggregate: WorkAggregate,
  mediaItem: MediaManifestItem,
  probableDuplicate?: { existingMediaId: string; filename: string },
): EditorSnapshot {
  const cards = state.cards.slice()
  const uploadIndex = cards.findIndex(
    (card) =>
      (card.kind === 'upload' && card.clientId === clientId)
      || (card.kind === 'media' && card.replacement?.clientId === clientId),
  )
  if (uploadIndex < 0) {
    return hydrateFromAggregate(aggregate)
  }

  const target = cards[uploadIndex]
  if (target.kind === 'media' && target.replacement) {
    // Replacement success: keep caption, adopt new filename, clear alt.
    const { basename, extension } = splitFilename(mediaItem.filename)
    cards[uploadIndex] = {
      ...target,
      media: mediaItem,
      basename: basename || mediaItem.filename,
      extension: extension || mediaItem.extension,
      alt: '',
      caption: target.caption,
      replacement: undefined,
      dirty: true,
      probableDuplicate: probableDuplicate
        ? { ...probableDuplicate, dismissed: false }
        : undefined,
    }
  } else {
    const { basename, extension } = splitFilename(mediaItem.filename)
    cards[uploadIndex] = {
      kind: 'media',
      clientId: target.clientId,
      media: mediaItem,
      basename: basename || mediaItem.filename,
      extension: extension || mediaItem.extension,
      alt: mediaItem.alt || '',
      caption: mediaItem.caption || '',
      pendingRemoval: false,
      dirty: false,
      probableDuplicate: probableDuplicate
        ? { ...probableDuplicate, dismissed: false }
        : undefined,
    }
  }

  return {
    ...state,
    workId: aggregate.workId,
    archiveId: aggregate.archiveId,
    revision: aggregate.revision,
    baselineRevision: aggregate.revision,
    publicationStatus: aggregate.publicationStatus,
    published: aggregate.published,
    cards,
    // Finalization attaches durable media; local metadata/order may still be dirty.
    dirty: state.dirty || cards.some(isCardDirty),
    phase: state.dirty || cards.some(isCardDirty) ? 'dirty' : 'ready',
    pageError: undefined,
  }
}

function isCardDirty(card: EditorCard): boolean {
  if (card.kind === 'upload') return true
  if (card.pendingRemoval) return true
  if (card.replacement) return true
  if (card.dirty) return true
  const expectedName = joinFilename(card.basename, card.extension)
  if (expectedName !== card.media.filename) return true
  if ((card.alt || '') !== (card.media.alt || '')) return true
  if ((card.caption || '') !== (card.media.caption || '')) return true
  return false
}

export function updateMediaCard(
  state: EditorSnapshot,
  clientId: string,
  patch: Partial<Pick<MediaCard, 'basename' | 'alt' | 'caption'>>,
): EditorSnapshot {
  const cards = state.cards.map((card) => {
    if (card.kind !== 'media' || card.clientId !== clientId) return card
    return { ...card, ...patch, dirty: true }
  })
  return markDirty({ ...state, cards })
}

export function markPendingRemoval(state: EditorSnapshot, clientId: string): EditorSnapshot {
  const card = state.cards.find((item) => item.clientId === clientId)
  if (!card) return state
  if (card.kind === 'upload') {
    return {
      ...state,
      cards: state.cards.filter((item) => item.clientId !== clientId),
      dirty: state.cards.some((item) => item.clientId !== clientId && isCardDirty(item)) || hasMetadataDirty(state),
      phase: 'dirty',
    }
  }
  const cards = state.cards.map((item) =>
    item.clientId === clientId && item.kind === 'media'
      ? { ...item, pendingRemoval: true, replacement: undefined, dirty: true }
      : item,
  )
  return markDirty({ ...state, cards })
}

export function undoPendingRemoval(state: EditorSnapshot, clientId: string): EditorSnapshot {
  const cards = state.cards.map((item) =>
    item.clientId === clientId && item.kind === 'media'
      ? { ...item, pendingRemoval: false, dirty: true }
      : item,
  )
  return markDirty({ ...state, cards })
}

export function dismissDuplicateWarning(state: EditorSnapshot, clientId: string): EditorSnapshot {
  const cards = state.cards.map((item) => {
    if (item.kind !== 'media' || item.clientId !== clientId || !item.probableDuplicate) return item
    return { ...item, probableDuplicate: { ...item.probableDuplicate, dismissed: true } }
  })
  return { ...state, cards }
}

export function reorderCards(state: EditorSnapshot, fromIndex: number, toIndex: number): EditorSnapshot {
  if (fromIndex === toIndex) return state
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= state.cards.length || toIndex >= state.cards.length) {
    return state
  }
  const cards = state.cards.slice()
  const [moved] = cards.splice(fromIndex, 1)
  cards.splice(toIndex, 0, moved)
  return markDirty({ ...state, cards })
}

export function moveCard(state: EditorSnapshot, clientId: string, direction: -1 | 1): EditorSnapshot {
  const index = state.cards.findIndex((card) => card.clientId === clientId)
  if (index < 0) return state
  return reorderCards(state, index, index + direction)
}

function hasMetadataDirty(state: EditorSnapshot): boolean {
  // Without a loaded aggregate we treat any non-empty create form as not yet durable.
  return Boolean(state.workId) && state.dirty
}

export function activeUploadCards(state: EditorSnapshot): UploadCard[] {
  const result: UploadCard[] = []
  for (const card of state.cards) {
    if (card.kind === 'upload' && isActiveUploadPhase(card.phase)) result.push(card)
    if (card.kind === 'media' && card.replacement && isActiveUploadPhase(card.replacement.phase)) {
      result.push(card.replacement)
    }
  }
  return result
}

function isActiveUploadPhase(phase: UploadPhase): boolean {
  return phase === 'queued' || phase === 'authorizing' || phase === 'uploading' || phase === 'finalizing' || phase === 'retrying'
}

export function hasActiveUploads(state: EditorSnapshot): boolean {
  return activeUploadCards(state).length > 0
}

export function hasFailedUploads(state: EditorSnapshot): boolean {
  return state.cards.some((card) => {
    if (card.kind === 'upload' && card.phase === 'failed') return true
    if (card.kind === 'media' && card.replacement?.phase === 'failed') return true
    return false
  })
}

export function hasIncompleteReplacements(state: EditorSnapshot): boolean {
  return state.cards.some((card) => card.kind === 'media' && Boolean(card.replacement))
}

export function readableMediaCount(state: EditorSnapshot): number {
  return state.cards.filter((card) => card.kind === 'media' && !card.pendingRemoval && !card.replacement).length
}

export function getPublishGate(state: EditorSnapshot): PublishGate {
  if (!state.workId || !state.revision) {
    return { allowed: false, reason: '请先创建并保存草稿作品。' }
  }
  if (state.phase === 'conflict') {
    return { allowed: false, reason: '存在版本冲突，请刷新后重新应用更改。' }
  }
  if (state.dirty || state.phase === 'dirty' || state.phase === 'saving') {
    return { allowed: false, reason: '请先保存草稿，再发布。' }
  }
  if (hasActiveUploads(state)) {
    return { allowed: false, reason: '仍有媒体文件上传中，无法发布。' }
  }
  if (hasFailedUploads(state)) {
    return { allowed: false, reason: '存在上传失败的媒体文件，请重试或移除后再发布。' }
  }
  if (hasIncompleteReplacements(state)) {
    return { allowed: false, reason: '存在未完成的替换，请等待完成或取消后再发布。' }
  }
  if (readableMediaCount(state) < 1) {
    return { allowed: false, reason: '至少需要一个可读的媒体文件才能发布。' }
  }
  if (state.phase === 'publishing') {
    return { allowed: false, reason: '正在发布…' }
  }
  return { allowed: true }
}

export function getSaveGate(state: EditorSnapshot): PublishGate {
  if (!state.title.trim() || !state.author.trim()) {
    return { allowed: false, reason: '标题和作者不能为空。' }
  }
  if (state.phase === 'conflict') {
    return { allowed: false, reason: '存在版本冲突，请刷新后重新应用更改。' }
  }
  if (!state.workId) {
    return { allowed: false, reason: '请先创建草稿作品。' }
  }
  if (hasActiveUploads(state)) {
    return { allowed: false, reason: '请等待上传完成后再保存草稿。' }
  }
  if (state.phase === 'saving') {
    return { allowed: false, reason: '正在保存…' }
  }
  if (!state.dirty && state.phase !== 'failure') {
    return { allowed: false, reason: '没有未保存的更改。' }
  }
  return { allowed: true }
}

export function shouldWarnOnLeave(state: EditorSnapshot): boolean {
  return hasActiveUploads(state) || state.dirty
}

export function leaveWarningMessage(state: EditorSnapshot): string {
  if (hasActiveUploads(state)) {
    return '仍有媒体文件正在上传。离开页面会中断未完成的传输，已成功确认的上传会保留在草稿中。'
  }
  return '有未保存的草稿更改。离开页面将丢失尚未保存的文本、排序、替换或移除。'
}

export function buildSavePayload(state: EditorSnapshot): {
  title: string
  author: string
  description?: string
  media: Array<{ mediaId: string; filename: string; alt?: string; caption?: string }>
  revision: string
} {
  if (!state.revision) throw new Error('缺少 revision。')
  return {
    revision: state.revision,
    title: state.title.trim(),
    author: state.author.trim(),
    description: state.description.trim() || undefined,
    media: state.cards
      .filter((card): card is MediaCard => card.kind === 'media' && !card.pendingRemoval)
      .map((card) => ({
        mediaId: card.media.mediaId,
        filename: joinFilename(card.basename, card.extension),
        alt: card.alt.trim() || undefined,
        caption: card.caption.trim() || undefined,
      })),
  }
}

export function applySavedAggregate(state: EditorSnapshot, aggregate: WorkAggregate): EditorSnapshot {
  // Preserve only non-durable upload cards that were not part of the saved manifest.
  const pendingUploads = state.cards.filter((card) => card.kind === 'upload')
  const hydrated = hydrateFromAggregate(aggregate)
  return {
    ...hydrated,
    phase: 'saved',
    cards: [...hydrated.cards, ...pendingUploads],
    dirty: pendingUploads.length > 0,
  }
}

export function applyPublishedAggregate(state: EditorSnapshot, aggregate: WorkAggregate): EditorSnapshot {
  return {
    ...hydrateFromAggregate(aggregate),
    phase: 'published',
  }
}

export function applyConflict(
  state: EditorSnapshot,
  message: string,
  currentRevision?: string,
  aggregate?: WorkAggregate,
): EditorSnapshot {
  return {
    ...state,
    phase: 'conflict',
    conflictMessage: message,
    pageError: message,
    baselineRevision: currentRevision || aggregate?.revision || state.baselineRevision,
    // Keep local cards/metadata; do not auto-merge.
  }
}

export function applyFailure(state: EditorSnapshot, message: string): EditorSnapshot {
  return {
    ...state,
    phase: 'failure',
    pageError: message,
  }
}

export function applyRevision(state: EditorSnapshot, revision: string): EditorSnapshot {
  return { ...state, revision }
}

export function previewCards(state: EditorSnapshot): MediaCard[] {
  return state.cards.filter((card): card is MediaCard => card.kind === 'media' && !card.pendingRemoval)
}

export function publicationBadge(state: EditorSnapshot): {
  label: string
  tone: 'draft' | 'published' | 'unpublished'
} {
  if (state.publicationStatus === 'published' && !state.dirty && state.phase !== 'dirty') {
    return { label: '已发布', tone: 'published' }
  }
  if (state.publicationStatus === 'unpublished_draft' || (state.published && (state.dirty || state.phase === 'dirty' || state.phase === 'saved'))) {
    return { label: '未发布的草稿更改', tone: 'unpublished' }
  }
  if (state.publicationStatus === 'published') {
    return { label: '已发布', tone: 'published' }
  }
  return { label: '草稿', tone: 'draft' }
}

export function isImageCard(card: EditorCard): boolean {
  if (card.kind === 'upload') return isImageMime(card.mimeType)
  return card.media.isImage || isImageMime(card.media.mimeType)
}

export function isPdfCard(card: EditorCard): boolean {
  if (card.kind === 'upload') return isPdfMime(card.mimeType)
  return card.media.isPdf || isPdfMime(card.media.mimeType)
}
