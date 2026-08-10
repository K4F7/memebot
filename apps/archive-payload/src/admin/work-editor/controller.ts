import {
  AuthoringApiError,
  createWorkAuthoringClient,
  type WorkAuthoringClient,
} from '../../authoring'
import {
  activeUploadCards,
  applyConflict,
  applyFailure,
  applyPublishedAggregate,
  applySavedAggregate,
  buildSavePayload,
  canStartUpload,
  createEmptyEditorState,
  enqueueFiles,
  getPublishGate,
  getSaveGate,
  hasActiveUploads,
  hydrateFromAggregate,
  markPendingRemoval,
  moveCard,
  reorderCards,
  setMetadata,
  shouldWarnOnLeave,
  undoPendingRemoval,
  updateMediaCard,
  dismissDuplicateWarning,
  type EditorSnapshot,
} from './state'
import { createUploadQueue, type UploadQueue } from './upload-queue'

export type EditorListener = (state: EditorSnapshot) => void

export interface WorkEditorControllerOptions {
  client?: WorkAuthoringClient
  workId?: string
  concurrency?: number
}

export function createWorkEditorController(options: WorkEditorControllerOptions = {}) {
  const client = options.client || createWorkAuthoringClient()
  let state: EditorSnapshot = createEmptyEditorState()
  if (options.workId) {
    state = { ...state, workId: options.workId, phase: 'loading' }
  }
  const listeners = new Set<EditorListener>()
  let queue: UploadQueue | undefined
  let createInFlight: Promise<string> | undefined

  function emit(): void {
    for (const listener of listeners) listener(state)
  }

  function setState(next: EditorSnapshot | ((prev: EditorSnapshot) => EditorSnapshot)): void {
    state = typeof next === 'function' ? next(state) : next
    emit()
  }

  function getState(): EditorSnapshot {
    return state
  }

  async function ensureWorkId(): Promise<string> {
    if (state.workId && state.revision) return state.workId
    if (createInFlight) return createInFlight

    const gate = canStartUpload(state)
    if (!gate.ok) throw new Error(gate.reason || '无法创建作品。')

    createInFlight = (async () => {
      const snapshot = getState()
      setState({ ...snapshot, phase: 'creating', pageError: undefined })
      try {
        const aggregate = await client.createWork({
          title: snapshot.title.trim(),
          author: snapshot.author.trim(),
          description: snapshot.description.trim() || undefined,
        })
        const current = getState()
        setState({
          ...hydrateFromAggregate(aggregate),
          // Keep any already-queued upload cards from the create form.
          cards: current.cards,
          dirty: current.cards.length > 0 || current.dirty,
          phase: current.cards.length > 0 || current.dirty ? 'dirty' : 'ready',
        })
        return aggregate.workId
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建作品失败。'
        setState(applyFailure(getState(), message))
        throw error
      } finally {
        createInFlight = undefined
      }
    })()

    return createInFlight
  }

  function ensureQueue(): UploadQueue {
    if (!queue) {
      queue = createUploadQueue({
        client,
        concurrency: options.concurrency,
        getState,
        setState,
        ensureWorkId,
      })
    }
    return queue
  }

  return {
    getState,
    subscribe(listener: EditorListener): () => void {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },

    setTitle(title: string): void {
      setState(setMetadata(state, { title }))
    },
    setAuthor(author: string): void {
      setState(setMetadata(state, { author }))
    },
    setDescription(description: string): void {
      setState(setMetadata(state, { description }))
    },

    async load(workId = options.workId): Promise<void> {
      if (!workId) {
        setState(createEmptyEditorState())
        return
      }
      setState({ ...state, phase: 'loading', workId, pageError: undefined })
      try {
        const aggregate = await client.getWork(workId)
        setState(hydrateFromAggregate(aggregate))
      } catch (error) {
        const message = error instanceof Error ? error.message : '加载作品失败。'
        setState(applyFailure({ ...state, workId, loaded: false }, message))
      }
    },

    addFiles(files: File[]): { rejected: Array<{ name: string; message: string }> } {
      const result = enqueueFiles(state, Array.from(files))
      setState(result.state)
      if (result.accepted.length) ensureQueue().kick()
      return { rejected: result.rejected }
    },

    replaceMedia(mediaClientId: string, file: File): { rejected: Array<{ name: string; message: string }> } {
      const result = enqueueFiles(state, [file], { replaceMediaClientId: mediaClientId })
      setState(result.state)
      if (result.accepted.length) ensureQueue().kick()
      return { rejected: result.rejected }
    },

    retryUpload(clientId: string): void {
      ensureQueue().retry(clientId)
    },

    removeCard(clientId: string): void {
      setState(markPendingRemoval(state, clientId))
    },

    undoRemove(clientId: string): void {
      setState(undoPendingRemoval(state, clientId))
    },

    updateCard(clientId: string, patch: { basename?: string; alt?: string; caption?: string }): void {
      setState(updateMediaCard(state, clientId, patch))
    },

    dismissDuplicate(clientId: string): void {
      setState(dismissDuplicateWarning(state, clientId))
    },

    reorder(fromIndex: number, toIndex: number): void {
      setState(reorderCards(state, fromIndex, toIndex))
    },

    move(clientId: string, direction: -1 | 1): void {
      setState(moveCard(state, clientId, direction))
    },

    async saveDraft(): Promise<void> {
      const snapshot = getState()
      const gate = getSaveGate(snapshot)
      if (!gate.allowed) {
        setState({ ...snapshot, actionHint: gate.reason })
        return
      }
      setState({ ...snapshot, phase: 'saving', pageError: undefined, actionHint: undefined })
      try {
        const payload = buildSavePayload(getState())
        const aggregate = await client.saveDraft(getState().workId!, payload)
        setState(applySavedAggregate(getState(), aggregate))
      } catch (error) {
        if (error instanceof AuthoringApiError && error.code === 'stale_revision') {
          setState(applyConflict(getState(), error.message, error.currentRevision, error.aggregate))
          return
        }
        const message = error instanceof Error ? error.message : '保存草稿失败。'
        setState(applyFailure(getState(), message))
      }
    },

    async publish(): Promise<void> {
      const snapshot = getState()
      const gate = getPublishGate(snapshot)
      if (!gate.allowed) {
        setState({ ...snapshot, actionHint: gate.reason })
        return
      }
      setState({ ...snapshot, phase: 'publishing', pageError: undefined, actionHint: undefined })
      try {
        const current = getState()
        const aggregate = await client.publish(current.workId!, { revision: current.revision! })
        setState(applyPublishedAggregate(getState(), aggregate))
      } catch (error) {
        if (error instanceof AuthoringApiError && error.code === 'stale_revision') {
          setState(applyConflict(getState(), error.message, error.currentRevision, error.aggregate))
          return
        }
        const message = error instanceof Error ? error.message : '发布失败。'
        // Keep draft fully visible and retryable.
        const current = getState()
        setState(applyFailure({ ...current, phase: 'ready', dirty: false }, message))
      }
    },

    async refreshAfterConflict(): Promise<void> {
      if (!state.workId) return
      // Drop local state intentionally after explicit refresh.
      await this.load(state.workId)
    },

    shouldWarnOnLeave(): boolean {
      return shouldWarnOnLeave(state)
    },

    hasActiveUploads(): boolean {
      return hasActiveUploads(state)
    },

    activeUploads() {
      return activeUploadCards(state)
    },

    dispose(): void {
      queue?.stop()
      listeners.clear()
    },
  }
}

export type WorkEditorController = ReturnType<typeof createWorkEditorController>
