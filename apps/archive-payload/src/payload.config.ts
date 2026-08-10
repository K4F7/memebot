import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { s3Storage } from '@payloadcms/storage-s3'
import { buildConfig } from 'payload'

import { ArchiveSequences, Media, Users, WorkMedia, Works } from './collections'
import { databaseConnectionString } from './database-config'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const isProduction = process.env.NODE_ENV === 'production'
const isBuild = process.env.PAYLOAD_BUILD === '1'
const isMigration = process.env.PAYLOAD_MIGRATION === '1'
// Vercel instances are short-lived and can scale horizontally. Schema changes
// are applied separately with the direct Neon URL, never by a request-serving
// instance.
const runtimeMigrationsEnabled = process.env.VERCEL !== '1' && process.env.PAYLOAD_RUNTIME_MIGRATIONS === '1'
const productionRequired = isMigration
  ? ['PAYLOAD_SECRET', 'DATABASE_MIGRATION_URL']
  : [
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
if (isProduction && !isBuild && !isMigration && missingProduction.length) {
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
      connectionString: databaseConnectionString(process.env),
    },
    migrationDir: path.resolve(dirname, 'migrations'),
    // Keep the legacy long-running container path opt-in. Vercel deployments
    // use the manual `yarn migrate` command instead.
    prodMigrations: runtimeMigrationsEnabled ? migrations : undefined,
    push: !isProduction,
  }),
  logger: isProduction ? nodeLogger : undefined,
  plugins: [
    s3Storage({
      enabled: r2Configured,
      bucket: process.env.R2_BUCKET || 'memebot-archive',
      collections: { media: true },
      // Vercel Functions reject request/response bodies over 4.5 MB. Let the
      // Payload admin browser upload directly to the private R2 bucket and
      // use short-lived S3 URLs for the default media handler.
      clientUploads: r2Configured,
      signedDownloads: { expiresIn: 300 },
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
