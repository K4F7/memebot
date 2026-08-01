import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { R2Store } from './index'

export interface S3R2Config {
  accountId: string
  bucketName: string
  accessKeyId: string
  secretAccessKey: string
}

export class S3R2Store implements R2Store {
  private readonly client: S3Client
  constructor(private readonly config: S3R2Config, client?: S3Client) {
    this.client = client ?? new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
  }
  async put(key: string, data: Uint8Array, contentType?: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucketName, Key: key, Body: data, ContentType: contentType }))
  }
  async get(key: string) {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucketName, Key: key }))
      return response.Body ? new Uint8Array(await response.Body.transformToByteArray()) : undefined
    } catch (error) {
      const status = (error as any)?.$metadata?.httpStatusCode
      if (status === 404 || (error as any)?.name === 'NoSuchKey') return undefined
      throw error
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: key }))
  }
  async list(prefix: string) {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucketName, Prefix: prefix, ContinuationToken: continuationToken }))
      keys.push(...(response.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []))
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (continuationToken)
    return keys.sort()
  }
}
