import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import { initClientUploads } from '@payloadcms/plugin-cloud-storage/utilities'
import type { Adapter } from '@payloadcms/plugin-cloud-storage/types'
import { APIError, Forbidden, type Config, type PayloadHandler, type PayloadRequest } from 'payload'
import { createReadStream } from 'node:fs'

import { getR2Connection, toWebStream, type R2Connection } from './s3-storage'
import {
  createStorageKey,
  createUploadContext,
  isValidStorageKey,
  validateMediaUpload,
  verifyUploadContext,
} from './media-policy'

const CLIENT_HANDLER_PATH = '@/archive/r2-client-upload#R2ClientUploadHandler'
const SERVER_HANDLER_PATH = '/storage-r2-generate-signed-url'
const SIGNED_DOWNLOAD_SECONDS = 300
const IMAGE_METADATA_BYTES = 256 * 1024
const PDF_VALIDATION_BYTES = 1024

function routeParameter(req: PayloadRequest, name: string): string | undefined {
  const value = (req.routeParams as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' ? value : undefined
}

function notFound(): Response {
  return new Response(null, { status: 404, statusText: 'Not Found' })
}

async function readBodyBytes(body: unknown): Promise<Buffer> {
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> }
  if (typeof candidate.transformToByteArray === 'function') {
    return Buffer.from(await candidate.transformToByteArray())
  }
  const reader = toWebStream(body).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    if (result.value) {
      chunks.push(result.value)
      total += result.value.byteLength
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

async function readR2Range(connection: R2Connection, storageKey: string, start: number, end: number): Promise<Buffer> {
  const object = await connection.client.send(new GetObjectCommand({
    Bucket: connection.bucket,
    Key: storageKey,
    Range: `bytes=${start}-${end}`,
  }))
  if (!object.Body) throw new Error('R2 object body is empty.')
  return readBodyBytes(object.Body)
}

export async function buildPdfValidationSample(
  size: number,
  readRange: (start: number, end: number) => Promise<Buffer>,
): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('PDF object size is invalid.')
  if (size <= PDF_VALIDATION_BYTES * 2) return readRange(0, size - 1)
  return Buffer.concat([
    await readRange(0, PDF_VALIDATION_BYTES - 1),
    await readRange(size - PDF_VALIDATION_BYTES, size - 1),
  ])
}

async function readR2Object(req: PayloadRequest, storageKey: string, fallbackContentType: string, fallbackSize: number): Promise<Response> {
  const connection = getR2Connection()
  if (!connection) return new Response('R2 storage is not configured.', { status: 503 })
  try {
    // Payload 3.82.1 reads this response into a Buffer while finalizing a
    // client upload. Keep that buffer bounded while supplying enough real
    // bytes for Payload's PDF/header and image metadata checks.
    const head = await connection.client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: storageKey }))
    const objectSize = Number(head.ContentLength ?? fallbackSize)
    if (!Number.isSafeInteger(objectSize) || objectSize !== fallbackSize) {
      return new Response('R2 object size does not match the signed upload.', { status: 409 })
    }
    if (!fallbackContentType.startsWith('image/')) {
      if (objectSize <= 0) return new Response('R2 PDF object is empty.', { status: 422 })
      const sample = await buildPdfValidationSample(objectSize, (start, end) => readR2Range(connection, storageKey, start, end))
      return new Response(new Uint8Array(sample), { headers: { 'Content-Length': String(sample.length), 'Content-Type': fallbackContentType } })
    }
    const object = await connection.client.send(new GetObjectCommand({
      Bucket: connection.bucket,
      Key: storageKey,
      Range: `bytes=0-${IMAGE_METADATA_BYTES - 1}`,
    }))
    if (!object.Body) return notFound()
    const headers = new Headers({
      // The bounded sample is for Payload's MIME check only. Mark it as a
      // generic body so Payload does not attempt a full image-dimension probe
      // against a truncated object; Media.beforeValidate restores the signed
      // MIME metadata before persistence.
      'Content-Type': 'application/octet-stream',
    })
    const size = object.ContentLength ?? Math.min(objectSize, IMAGE_METADATA_BYTES)
    if (size >= 0) headers.set('Content-Length', String(size))
    return new Response(toWebStream(object.Body), { headers })
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') return notFound()
    req.payload.logger.error({ err: error, storageKey, msg: 'Failed to read R2 media object.' })
    return new Response('Failed to read media object.', { status: 502 })
  }
}

export const generateR2UploadUrl: PayloadHandler = async (req) => {
  if (!req.user) throw new Forbidden()
  if (typeof req.json !== 'function') throw new APIError('Content-Type expected to be application/json', 400)

  const body = await req.json() as Record<string, unknown>
  if (body.collectionSlug !== 'media') throw new APIError('Only the media collection supports R2 uploads.', 400)
  let input: ReturnType<typeof validateMediaUpload>
  try {
    input = validateMediaUpload({ filename: body.filename, filesize: body.filesize, mimeType: body.mimeType })
  } catch (error) {
    throw new APIError(error instanceof Error ? error.message : 'Invalid media upload.', 400)
  }
  const connection = getR2Connection()
  if (!connection) throw new APIError('R2 storage is not configured.', 503)

  const storageKey = createStorageKey()
  const context = createUploadContext({ ...input, storageKey })
  const command = new PutObjectCommand({
    Bucket: connection.bucket,
    ContentLength: input.filesize,
    ContentType: input.mimeType,
    Key: storageKey,
  })
  const url = await getSignedUrl(connection.client, command, {
    expiresIn: 600,
    signableHeaders: new Set(['content-length']),
  })
  return Response.json({ context, url })
}

export function createR2MediaEndpoint(): PayloadHandler {
  return async (req) => {
    if (!req.user) return new Response('Forbidden', { status: 403 })
    const id = routeParameter(req, 'id')
    if (!id) return notFound()

    const media = await req.payload.findByID({
      collection: 'media',
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: false,
      req,
    }) as { contentType?: string; filesize?: number; storageKey?: string } | null
    if (!media?.storageKey || !isValidStorageKey(media.storageKey)) return notFound()

    const connection = getR2Connection()
    if (!connection) return new Response('R2 storage is not configured.', { status: 503 })
    const url = await getSignedUrl(
      connection.client,
      new GetObjectCommand({ Bucket: connection.bucket, Key: media.storageKey }),
      { expiresIn: SIGNED_DOWNLOAD_SECONDS },
    )
    return Response.redirect(url, 302)
  }
}

const r2Adapter: Adapter = () => ({
  name: 'r2-opaque-key',
  clientUploads: true,
  handleUpload: async ({ data, file }) => {
    if (!isValidStorageKey(data.storageKey)) throw new Error('Media storage key is missing or invalid.')
    const connection = getR2Connection()
    if (!connection) throw new Error('R2 storage is not configured.')
    const body = file.tempFilePath ? createReadStream(file.tempFilePath) : file.buffer
    await connection.client.send(new PutObjectCommand({
      Body: body,
      Bucket: connection.bucket,
      ContentLength: file.filesize,
      ContentType: file.mimeType,
      Key: data.storageKey,
    }))
    return data
  },
  handleDelete: async ({ doc }) => {
    // Physical deletion is deliberately disabled for the Archive MVP. A
    // withdrawn record retains its metadata and private R2 object for audit.
    void doc
  },
  generateURL: ({ data }) => data?.id ? `/api/media/file/${encodeURIComponent(String(data.id))}` : '',
  staticHandler: async (req, { params }) => {
    if (!req.user) return new Response('Forbidden', { status: 403 })
    const context = verifyUploadContext(params.clientUploadContext)
    if (!context) return notFound()
    return readR2Object(req, context.storageKey, context.mimeType, context.filesize)
  },
})

export function r2StoragePlugin(incomingConfig: Config): Config {
  const enabled = Boolean(getR2Connection())
  initClientUploads({
    clientHandler: CLIENT_HANDLER_PATH,
    collections: { media: {} },
    config: incomingConfig,
    enabled,
    serverHandler: generateR2UploadUrl,
    serverHandlerPath: SERVER_HANDLER_PATH,
  })

  return cloudStoragePlugin({
    collections: {
      media: {
        adapter: r2Adapter,
        disableLocalStorage: true,
        disablePayloadAccessControl: true,
      },
    },
    enabled,
  })(incomingConfig)
}
