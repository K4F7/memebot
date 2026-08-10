import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import { validateMediaMimeType } from './mime'

export const MAX_MEDIA_SIZE = 100 * 1024 * 1024
const UPLOAD_CONTEXT_TTL_SECONDS = 10 * 60
const STORAGE_KEY_PATTERN = /^media\/[0-9a-f-]{36}$/
const CONTEXT_VERSION = 1 as const

export interface UploadContext {
  version: typeof CONTEXT_VERSION
  collection: 'media'
  storageKey: string
  filename: string
  filesize: number
  mimeType: string
  expiresAt: number
  signature: string
  /** Authoring-only binding; absent for the legacy Payload upload endpoint. */
  workId?: string
  uploadId?: string
}

interface UploadContextInput {
  filename: string
  filesize: number
  mimeType: string
  storageKey: string
  workId?: string
  uploadId?: string
}

interface ContextOptions {
  now?: number
  secret?: string
  ttlSeconds?: number
}

interface MediaRequestFile {
  clientUploadContext?: unknown
  mimetype?: unknown
  name?: unknown
  size?: unknown
}

interface StorageKeyRequest {
  data?: Record<string, any>
  originalDoc?: Record<string, any>
  req: { file?: MediaRequestFile; context?: Record<string, unknown> }
}

function contextSecret(secret?: string): string {
  const value = secret || process.env.PAYLOAD_SECRET
  if (!value) throw new Error('PAYLOAD_SECRET is required for media upload signing.')
  return value
}

function canonicalContext(input: Omit<UploadContext, 'signature'>): string {
  return [
    input.version,
    input.collection,
    input.storageKey,
    input.filename,
    input.filesize,
    input.mimeType,
    input.expiresAt,
    input.workId || '',
    input.uploadId || '',
  ].join('\n')
}

function signContext(input: Omit<UploadContext, 'signature'>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalContext(input)).digest('base64url')
}

function isStorageKey(value: unknown): value is string {
  return typeof value === 'string' && STORAGE_KEY_PATTERN.test(value)
}

export function createStorageKey(): string {
  return `media/${randomUUID()}`
}

export function validateMediaUpload(input: { filename: unknown; filesize: unknown; mimeType: unknown }): { filename: string; filesize: number; mimeType: string } {
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  if (!filename) throw new Error('Media 文件名不能为空。')
  const filesize = Number(input.filesize)
  if (!Number.isSafeInteger(filesize) || filesize < 0) throw new Error('Media 文件大小无效。')
  if (filesize > MAX_MEDIA_SIZE) throw new Error('Media 文件不能超过 100 MB。')
  const mimeType = validateMediaMimeType(input.mimeType)
  return { filename, filesize, mimeType }
}

export function createUploadContext(input: UploadContextInput, options: ContextOptions = {}): UploadContext {
  const validated = validateMediaUpload(input)
  if (!isStorageKey(input.storageKey)) throw new Error('Media storage key 无效。')
  const now = options.now ?? Date.now()
  const expiresAt = now + (options.ttlSeconds ?? UPLOAD_CONTEXT_TTL_SECONDS) * 1000
  const unsigned = {
    version: CONTEXT_VERSION,
    collection: 'media' as const,
    storageKey: input.storageKey,
    filename: validated.filename,
    filesize: validated.filesize,
    mimeType: validated.mimeType,
    expiresAt,
    workId: input.workId,
    uploadId: input.uploadId,
  }
  return { ...unsigned, signature: signContext(unsigned, contextSecret(options.secret)) }
}

export function verifyUploadContext(value: unknown, options: ContextOptions = {}): UploadContext | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<UploadContext>
  if (
    candidate.version !== CONTEXT_VERSION ||
    candidate.collection !== 'media' ||
    !isStorageKey(candidate.storageKey) ||
    typeof candidate.filename !== 'string' ||
    typeof candidate.filesize !== 'number' ||
    typeof candidate.mimeType !== 'string' ||
    typeof candidate.expiresAt !== 'number' ||
    typeof candidate.signature !== 'string'
  ) return null
  if (candidate.workId !== undefined && typeof candidate.workId !== 'string') return null
  if (candidate.uploadId !== undefined && typeof candidate.uploadId !== 'string') return null

  let validated: ReturnType<typeof validateMediaUpload>
  try {
    validated = validateMediaUpload({
      filename: candidate.filename,
      filesize: candidate.filesize,
      mimeType: candidate.mimeType,
    })
  } catch {
    return null
  }
  if (validated.filename !== candidate.filename || validated.filesize !== candidate.filesize || validated.mimeType !== candidate.mimeType) return null
  if (candidate.expiresAt <= (options.now ?? Date.now())) return null

  let expected: Buffer
  let actual: Buffer
  try {
    expected = Buffer.from(signContext(candidate as Omit<UploadContext, 'signature'>, contextSecret(options.secret)))
    actual = Buffer.from(candidate.signature)
  } catch {
    return null
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return candidate as UploadContext
}

export function ensureMediaStorageKey({ data, originalDoc, req }: StorageKeyRequest): Record<string, any> | undefined {
  if (!data) return data
  const file = req.file
  if (file) {
    const context = file.clientUploadContext === undefined ? null : verifyUploadContext(file.clientUploadContext)
    if (file.clientUploadContext !== undefined && !context) throw new Error('Media client upload context 无效或已过期。')
    if (context) {
      if (file.size !== undefined && Number(file.size) !== context.filesize) throw new Error('Media client upload size 与签名不一致。')
      if (file.mimetype !== undefined && file.mimetype !== 'application/octet-stream' && validateMediaMimeType(file.mimetype) !== context.mimeType) {
        throw new Error('Media client upload MIME 与签名不一致。')
      }
    }
    data.storageKey = context?.storageKey || createStorageKey()
    return data
  }

  if (originalDoc?.storageKey) {
    if (data.storageKey && data.storageKey !== originalDoc.storageKey) throw new Error('Media storage key 不能被修改。')
    data.storageKey = originalDoc.storageKey
  } else if (data.storageKey && !isStorageKey(data.storageKey)) {
    throw new Error('Media storage key 无效。')
  } else if (!originalDoc && data.storageKey && !req.context?.workAuthoring) {
    // The Work Authoring service allocates the opaque key before creating the
    // pending Media row. The context flag is attached only to an authenticated
    // internal Payload request, never accepted from a browser collection write.
    throw new Error('Media storage key 必须由服务器随上传生成。')
  }
  return data
}

export function isValidStorageKey(value: unknown): value is string {
  return isStorageKey(value)
}
