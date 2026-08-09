import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getCloudflareContext, type CloudflareContext } from '@opennextjs/cloudflare'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { r2Storage } from '@payloadcms/storage-r2'
import { buildConfig } from 'payload'
import type { GetPlatformProxyOptions } from 'wrangler'

import { ArchiveSequences, Media, Users, WorkMedia, Works } from './collections'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const isProduction = process.env.NODE_ENV === 'production'
const isPayloadCli = process.argv.some((value) => typeof value === 'string' && value.includes(`${path.sep}payload${path.sep}bin`))

const cloudflareLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: (...args: unknown[]) => console.debug(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  fatal: (...args: unknown[]) => console.error(...args),
  silent: (): undefined => undefined,
} as any

const cloudflare = isPayloadCli || !isProduction
  ? await getCloudflareContextFromWrangler()
  : await getCloudflareContext({ async: true })

const secret = process.env.PAYLOAD_SECRET || 'local-development-payload-secret'
if (isProduction && secret === 'local-development-payload-secret') console.warn('PAYLOAD_SECRET is not configured; set it before deploying.')

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
  },
  collections: [Users, Works, Media, WorkMedia, ArchiveSequences],
  editor: lexicalEditor(),
  secret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: sqliteD1Adapter({ binding: cloudflare.env.D1 }),
  logger: isProduction ? cloudflareLogger : undefined,
  plugins: [
    r2Storage({
      bucket: cloudflare.env.R2,
      // Browser uploads use the R2 multipart path instead of buffering files
      // through the Worker application.
      clientUploads: true,
      collections: { media: true },
    }),
  ],
})

function getCloudflareContextFromWrangler(): Promise<CloudflareContext> {
  return import(/* webpackIgnore: true */ `${'__wrangler'.replaceAll('_', '')}`).then(
    ({ getPlatformProxy }: { getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<CloudflareContext> }) => getPlatformProxy({
      environment: process.env.CLOUDFLARE_ENV,
      remoteBindings: isProduction,
    } satisfies GetPlatformProxyOptions),
  )
}
