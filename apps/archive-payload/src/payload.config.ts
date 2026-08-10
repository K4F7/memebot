import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'

import { MAX_MEDIA_SIZE } from './archive/media-policy'
import { r2StoragePlugin } from './archive/r2-payload-storage'
import { ArchiveSequences, Media, Users, WorkMedia, Works } from './collections'
import { databaseConnectionString } from './database-config'
import { seedDevelopmentAdmin } from './dev-admin'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)
const isProduction = process.env.NODE_ENV === 'production'
const isBuild = process.env.PAYLOAD_BUILD === '1'
const isMigration = process.env.PAYLOAD_MIGRATION === '1'
const isVercelProductionBuild = isBuild && process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production'
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
if (((isProduction && !isBuild && !isMigration) || isVercelProductionBuild) && missingProduction.length) {
  throw new Error(`Missing production environment variables: ${missingProduction.join(', ')}`)
}

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
    meta: {
      titleSuffix: ' · MemeBot 档案管理',
    },
    components: {
      graphics: {
        Logo: '/admin/graphics/Logo',
        Icon: '/admin/graphics/Icon',
      },
      views: {
        dashboard: {
          Component: '/admin/Dashboard',
        },
      },
    },
  },
  collections: [Users, Works, Media, WorkMedia, ArchiveSequences],
  editor: lexicalEditor(),
  upload: {
    limits: { fileSize: MAX_MEDIA_SIZE },
  },
  secret,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
  db: postgresAdapter({
    pool: {
      connectionTimeoutMillis: 5_000,
      connectionString: databaseConnectionString(process.env),
      idleTimeoutMillis: 10_000,
      max: 5,
    },
    migrationDir: path.resolve(dirname, 'migrations'),
    // Keep the legacy long-running container path opt-in. Vercel deployments
    // use the manual `yarn migrate` command instead.
    prodMigrations: runtimeMigrationsEnabled ? migrations : undefined,
    push: !isProduction,
  }),
  logger: isProduction ? nodeLogger : undefined,
  onInit: async (payload) => {
    const result = await seedDevelopmentAdmin(payload)
    if (result.status === 'created') {
      payload.logger.info(`Created development admin account for ${result.email}.`)
    } else if (result.status === 'exists') {
      payload.logger.info(`Development admin account already exists for ${result.email}.`)
    }
  },
  plugins: [r2StoragePlugin],
})
