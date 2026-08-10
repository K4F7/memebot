import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { AuthoringObjectStore, AuthorizeUploadResult } from './work-authoring'
import { getR2Connection } from './s3-storage'
import type { UploadContext } from './media-policy'

export class R2AuthoringObjectStore implements AuthoringObjectStore {
  async authorizeUpload(input: { storageKey: string; context: UploadContext; filename: string; filesize: number; mimeType: string }): Promise<AuthorizeUploadResult> {
    const connection = getR2Connection()
    if (!connection) throw new Error('R2 storage is not configured.')
    const url = await getSignedUrl(connection.client, new PutObjectCommand({
      Bucket: connection.bucket,
      ContentLength: input.filesize,
      ContentType: input.mimeType,
      Key: input.storageKey,
    }), {
      expiresIn: 600,
      signableHeaders: new Set(['content-length']),
    })
    return {
      putUrl: url,
      headers: { 'Content-Type': input.mimeType, 'Content-Length': String(input.filesize) },
      expiresAt: new Date(input.context.expiresAt).toISOString(),
      context: input.context,
    }
  }

  async head(storageKey: string): Promise<{ size: number; mimeType?: string } | null> {
    const connection = getR2Connection()
    if (!connection) throw new Error('R2 storage is not configured.')
    try {
      const result = await connection.client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: storageKey }))
      return { size: Number(result.ContentLength || 0), mimeType: result.ContentType || undefined }
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'NoSuchKey' || name === 'NotFound') return null
      throw error
    }
  }

  async delete(storageKey: string): Promise<void> {
    const connection = getR2Connection()
    if (!connection) throw new Error('R2 storage is not configured.')
    await connection.client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: storageKey }))
  }
}
