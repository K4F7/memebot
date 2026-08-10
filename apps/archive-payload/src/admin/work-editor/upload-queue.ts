import { AuthoringApiError, type WorkAuthoringClient } from '../../authoring'
import {
  activeUploadCards,
  applyFinalizedUpload,
  applyRevision,
  setUploadPhase,
} from './state'
import type { EditorSnapshot, UploadCard } from './types'

export interface UploadQueueOptions {
  client: WorkAuthoringClient
  concurrency?: number
  getState: () => EditorSnapshot
  setState: (next: EditorSnapshot | ((prev: EditorSnapshot) => EditorSnapshot)) => void
  ensureWorkId: () => Promise<string>
}

/**
 * Bounded-concurrency upload queue.
 * R2 PUTs run in parallel; finalization is serialized so revision tokens stay ordered.
 */
export function createUploadQueue(options: UploadQueueOptions) {
  const concurrency = Math.max(1, options.concurrency ?? 3)
  let running = 0
  let finalizeChain: Promise<void> = Promise.resolve()
  let stopped = false
  const inFlight = new Set<string>()

  function schedule(): void {
    if (stopped) return
    const state = options.getState()
    const waiting = activeUploadCards(state).filter(
      (card) => (card.phase === 'queued' || card.phase === 'retrying') && !inFlight.has(card.clientId),
    )
    while (running < concurrency && waiting.length) {
      const next = waiting.shift()!
      void runOne(next)
    }
  }

  async function runOne(card: UploadCard): Promise<void> {
    running += 1
    inFlight.add(card.clientId)
    try {
      await transfer(card)
    } finally {
      running -= 1
      inFlight.delete(card.clientId)
      schedule()
    }
  }

  async function transfer(card: UploadCard): Promise<void> {
    const workId = await options.ensureWorkId()
    let state = options.getState()
    if (!state.revision) {
      options.setState((prev) =>
        setUploadPhase(prev, card.clientId, 'failed', {
          error: '缺少 revision，无法上传。',
          errorCode: 'validation',
        }),
      )
      return
    }

    options.setState((prev) => setUploadPhase(prev, card.clientId, 'authorizing', { progress: 0 }))
    state = options.getState()

    try {
      const auth = await options.client.authorizeUpload(workId, {
        revision: state.revision!,
        filename: card.filename,
        filesize: card.filesize,
        mimeType: card.mimeType,
        selectionIndex: card.selectionIndex,
        replaceMediaId: card.replaceMediaId,
      })

      options.setState((prev) =>
        applyRevision(
          setUploadPhase(prev, card.clientId, 'uploading', {
            uploadId: auth.upload.uploadId,
            progress: 10,
          }),
          auth.revision,
        ),
      )

      await options.client.putToR2(auth.upload.putUrl, card.file, auth.upload.headers)
      options.setState((prev) => setUploadPhase(prev, card.clientId, 'finalizing', { progress: 80 }))

      await enqueueFinalize(async () => {
        const current = options.getState()
        if (!current.revision) throw new Error('缺少 revision。')
        const finalized = await options.client.finalizeUpload(workId, {
          revision: current.revision,
          uploadId: auth.upload.uploadId,
          idempotencyKey: card.idempotencyKey,
          context: auth.upload.context,
          selectionIndex: card.selectionIndex,
          replaceMediaId: card.replaceMediaId,
        })
        options.setState((prev) =>
          applyFinalizedUpload(
            prev,
            card.clientId,
            finalized,
            finalized.mediaItem,
            finalized.probableDuplicate,
          ),
        )
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传失败。'
      const code = error instanceof AuthoringApiError ? error.code : 'unknown'
      options.setState((prev) =>
        setUploadPhase(prev, card.clientId, 'failed', {
          error: message,
          errorCode: code,
          progress: 0,
        }),
      )
      if (error instanceof AuthoringApiError && error.currentRevision) {
        options.setState((prev) => applyRevision(prev, error.currentRevision!))
      }
    }
  }

  function enqueueFinalize(task: () => Promise<void>): Promise<void> {
    const run = finalizeChain.then(task, task)
    finalizeChain = run.then(
      (): void => undefined,
      (): void => undefined,
    )
    return run
  }

  return {
    kick(): void {
      schedule()
    },
    retry(clientId: string): void {
      options.setState((prev) => setUploadPhase(prev, clientId, 'retrying', { error: undefined, errorCode: undefined }))
      schedule()
    },
    stop(): void {
      stopped = true
    },
  }
}

export type UploadQueue = ReturnType<typeof createUploadQueue>
