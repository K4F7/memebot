import { MAX_MEDIA_BYTES, DISALLOWED_IMAGE_SUBTYPES, ALLOWED_MIME_EXACT } from './types'
import { splitFilename } from '../../authoring/contract'

export type FileRejectReason = 'unsupported_file' | 'oversize_file' | 'empty_name'

export interface FileValidationResult {
  ok: boolean
  reason?: FileRejectReason
  message?: string
  mimeType?: string
  extension?: string
  basename?: string
}

function normalizeMime(value: string): string {
  return value.split(';', 1)[0].trim().toLowerCase()
}

export function isAllowedMimeType(mimeType: string): boolean {
  const mime = normalizeMime(mimeType)
  if (!mime) return false
  if (ALLOWED_MIME_EXACT.has(mime)) return true
  if (!mime.startsWith('image/')) return false
  const subtype = mime.slice('image/'.length)
  if (DISALLOWED_IMAGE_SUBTYPES.has(subtype)) return false
  return true
}

export function validateSelectedFile(file: File): FileValidationResult {
  const name = file.name?.trim() || ''
  if (!name) {
    return { ok: false, reason: 'empty_name', message: '媒体文件名不能为空。' }
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return {
      ok: false,
      reason: 'oversize_file',
      message: '媒体文件不能超过 100 MB。',
    }
  }
  const mimeType = normalizeMime(file.type || '')
  if (!isAllowedMimeType(mimeType)) {
    return {
      ok: false,
      reason: 'unsupported_file',
      message: '仅支持图片（不含 SVG）或 PDF 媒体文件。',
    }
  }
  const { basename, extension } = splitFilename(name)
  return { ok: true, mimeType, basename, extension }
}

export function isImageMime(mimeType: string): boolean {
  const mime = normalizeMime(mimeType)
  return mime.startsWith('image/') && isAllowedMimeType(mime)
}

export function isPdfMime(mimeType: string): boolean {
  return normalizeMime(mimeType) === 'application/pdf'
}
