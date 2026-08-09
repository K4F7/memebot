import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import { buildConfig } from 'payload'

import { ArchiveSequences, Media, Users, WorkMedia, Works } from './collections'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const isProduction = process.env.NODE_ENV === 'production'
const isBuild = process.env.PAYLOAD_BUILD === '1'
const productionRequired = [
  'PAYLOAD_SECRET',
  'DATABASE_URL',
  'R2_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'ARCHIVE_SERVICE_TOKEN',
  'ARCHIVE_MEDIA_SIGNING_SECRET',
]
const missingProduction = productionRequired.filter((name) => !process.env[name])
if (isProduction && !isBuild && missingProduction.length) {
  throw new Error(`Missing production environment variables: ${missingProduction.join(', ')}`)
}

const r2Configured = Boolean(
  process.env.R2_BUCKET &&
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY,
)

const nodeLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: (...args: unknown[]) => console.trace(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  fatal: (...args: unknown[]) => console.error(...args),
  silent: (): undefined => undefined,
} as any

const secret = process.env.PAYLOAD_SECRET || randomUUID()

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
  },
  collections: [Users, Works, Media, WorkMedia, ArchiveSequences],
  editor: lexicalEditor(),
  secret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL,
    },
    migrationDir: path.resolve(dirname, 'migrations'),
    // A long-running VPS process can apply pending migrations before Payload
    // initializes. The deploy script only considers the release healthy after
    // this initialization has completed.
    prodMigrations: migrations,
    push: !isProduction,
  }),
  logger: isProduction ? nodeLogger : undefined,
  plugins: [
    s3Storage({
      enabled: r2Configured,
      bucket: process.env.R2_BUCKET || 'memebot-archive',
      collections: { media: true },
      disableLocalStorage: isProduction,
      config: {
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        },
        endpoint: process.env.R2_ENDPOINT,
        forcePathStyle: true,
        region: process.env.R2_REGION || 'auto',
      },
    }),
  ],
})
