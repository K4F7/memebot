import {
  AuthoringApiError,
  WORK_AUTHORING_API_PREFIX,
  type AuthoringErrorBody,
  type AuthorizeUploadRequest,
  type AuthorizeUploadResponse,
  type CreateWorkRequest,
  type FinalizeUploadRequest,
  type FinalizeUploadResponse,
  type PublishRequest,
  type SaveDraftRequest,
  type WorkAggregate,
} from './contract'

export type FetchLike = typeof fetch

export interface WorkAuthoringClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
  /** Prefix defaults to `/api/work-authoring/v1`. */
  apiPrefix?: string
}

function joinUrl(baseUrl: string, ...parts: string[]): string {
  const root = baseUrl.replace(/\/+$/, '')
  const path = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
  if (!root) return `/${path}`
  return `${root}/${path}`
}

async function parseError(response: Response): Promise<AuthoringApiError> {
  let body: AuthoringErrorBody | undefined
  try {
    body = (await response.json()) as AuthoringErrorBody
  } catch {
    body = undefined
  }
  if (body?.error?.code && body.error.message) {
    return new AuthoringApiError(response.status, body.error)
  }
  return new AuthoringApiError(response.status, {
    code: response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unknown',
    message: `Work Authoring API 请求失败（${response.status}）。`,
  })
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })
  if (!response.ok) throw await parseError(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function createWorkAuthoringClient(options: WorkAuthoringClientOptions = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const baseUrl = options.baseUrl || ''
  const apiPrefix = options.apiPrefix || WORK_AUTHORING_API_PREFIX

  const url = (...segments: string[]) => joinUrl(baseUrl, apiPrefix, ...segments)

  return {
    async createWork(body: CreateWorkRequest): Promise<WorkAggregate> {
      return requestJson(fetchImpl, url('works'), {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    async getWork(workId: string): Promise<WorkAggregate> {
      return requestJson(fetchImpl, url('works', workId), { method: 'GET' })
    },

    async saveDraft(workId: string, body: SaveDraftRequest): Promise<WorkAggregate> {
      return requestJson(fetchImpl, url('works', workId, 'draft'), {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    },

    async publish(workId: string, body: PublishRequest): Promise<WorkAggregate> {
      return requestJson(fetchImpl, url('works', workId, 'publish'), {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    async authorizeUpload(workId: string, body: AuthorizeUploadRequest): Promise<AuthorizeUploadResponse> {
      return requestJson(fetchImpl, url('works', workId, 'uploads', 'authorize'), {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    async finalizeUpload(workId: string, body: FinalizeUploadRequest): Promise<FinalizeUploadResponse> {
      return requestJson(fetchImpl, url('works', workId, 'uploads', 'finalize'), {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },

    async discardMedia(workId: string, mediaId: string, revision: string): Promise<WorkAggregate> {
      return requestJson(fetchImpl, url('works', workId, 'media', mediaId), {
        method: 'DELETE',
        body: JSON.stringify({ revision }),
      })
    },

    async putToR2(putUrl: string, file: Blob, headers?: Record<string, string>): Promise<void> {
      const response = await fetchImpl(putUrl, {
        method: 'PUT',
        body: file,
        headers: headers || { 'Content-Type': file.type || 'application/octet-stream' },
      })
      if (!response.ok) {
        throw new AuthoringApiError(response.status, {
          code: 'r2_transfer_failed',
          message: `R2 上传失败（${response.status}）。`,
        })
      }
    },
  }
}

export type WorkAuthoringClient = ReturnType<typeof createWorkAuthoringClient>
