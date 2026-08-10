export const ALLOWED_MEDIA_TYPES = [
  'application/pdf',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number]

export function isAllowedMediaType(value: unknown): value is AllowedMediaType {
  return typeof value === 'string' && (ALLOWED_MEDIA_TYPES as readonly string[]).includes(value.toLowerCase() as AllowedMediaType)
}

export function validateMediaMimeType(value: unknown): AllowedMediaType {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
  if (!isAllowedMediaType(mimeType)) {
    throw new Error('Media 仅支持 image/*（不含 SVG）或 application/pdf。')
  }
  return mimeType
}
