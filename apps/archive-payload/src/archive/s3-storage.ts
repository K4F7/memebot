import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Readable } from 'node:stream'

export interface ObjectStoreObject {
  body?: ReadableStream<Uint8Array>
  size?: number
  httpMetadata?: { contentType?: string }
}

export interface ObjectStore {
  get(key: string): Promise<ObjectStoreObject | null>
  presignGet(key: string, expiresIn: number): Promise<string>
}

let cached: { endpoint: string; bucket: string; client: S3Client } | undefined

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>
  }
  if (typeof candidate.transformToWebStream === 'function') return candidate.transformToWebStream()
  if (body instanceof Readable) return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>
  return body as ReadableStream<Uint8Array>
}

function getClient(endpoint: string, bucket: string): S3Client {
  if (cached?.endpoint === endpoint && cached.bucket === bucket) return cached.client
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
    endpoint,
    forcePathStyle: true,
    region: process.env.R2_REGION || 'auto',
  })
  cached = { endpoint, bucket, client }
  return client
}

export function createR2ObjectStore(): ObjectStore | undefined {
  const endpoint = process.env.R2_ENDPOINT
  const bucket = process.env.R2_BUCKET
  if (!endpoint || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) return undefined

  const client = getClient(endpoint, bucket)
  return {
    async get(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        if (!object.Body) return null
        return {
          body: toWebStream(object.Body),
          size: object.ContentLength ?? undefined,
          httpMetadata: { contentType: object.ContentType || undefined },
        }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === 'NoSuchKey' || name === 'NotFound') return null
        throw error
      }
    },
    async presignGet(key, expiresIn) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: Math.max(1, Math.min(300, Math.floor(expiresIn))),
      })
    },
  }
}
