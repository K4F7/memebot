'use client'

import { createClientUploadHandler } from '@payloadcms/plugin-cloud-storage/client'

function joinUrl(...parts: string[]): string {
  return parts.reduce((result, part) => {
    if (!part) return result
    if (!result) return part.replace(/\/+$/, '')
    return `${result.replace(/\/+$/, '')}/${part.replace(/^\/+/, '')}`
  }, '')
}

export const R2ClientUploadHandler = createClientUploadHandler({
  handler: async ({ apiRoute, collectionSlug, file, serverHandlerPath, serverURL }) => {
    const response = await fetch(joinUrl(serverURL || '', apiRoute, serverHandlerPath), {
      body: JSON.stringify({
        collectionSlug,
        filename: file.name,
        filesize: file.size,
        mimeType: file.type,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      credentials: 'include',
    })
    if (!response.ok) throw new Error(`R2 upload signing failed (${response.status}).`)

    const payload = await response.json() as { context?: unknown; url?: unknown }
    if (typeof payload.url !== 'string' || payload.context === undefined) throw new Error('R2 upload signing response is invalid.')
    const upload = await fetch(payload.url, {
      body: file,
      headers: { 'Content-Type': file.type },
      method: 'PUT',
    })
    if (!upload.ok) throw new Error(`R2 upload failed (${upload.status}).`)
    return payload.context
  },
})
