import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Adds the immutable R2 object identity without rewriting the named initial
 * schema migration. Existing rows get a unique UUID-shaped key before the
 * column becomes required.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "storage_key" varchar`)
  await db.execute(sql`ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "withdrawn_at" timestamp(3) with time zone`)
  await db.execute(sql`
    WITH generated AS (
      SELECT id, md5(random()::text || clock_timestamp()::text || id::text) AS value
      FROM "media"
      WHERE "storage_key" IS NULL
    )
    UPDATE "media"
    SET "storage_key" = 'media/' || substr(generated.value, 1, 8) || '-' || substr(generated.value, 9, 4) || '-' || substr(generated.value, 13, 4) || '-' || substr(generated.value, 17, 4) || '-' || substr(generated.value, 21, 12)
    FROM generated
    WHERE "media".id = generated.id
  `)
  await db.execute(sql`ALTER TABLE "media" ALTER COLUMN "storage_key" SET NOT NULL`)
  await db.execute(sql`DROP INDEX IF EXISTS "media_filename_idx"`)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "media_filename_compound_idx" ON "media" USING btree ("filename", "storage_key")`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "media_filename_idx" ON "media" USING btree ("filename")`)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "media_storage_key_idx" ON "media" USING btree ("storage_key")`)
  await db.execute(sql`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY work_id ORDER BY display_order, id) - 1 AS normalized
      FROM "work_media"
    )
    UPDATE "work_media" AS work_media
    SET display_order = -ranked.normalized - 1
    FROM ranked
    WHERE work_media.id = ranked.id
  `)
  await db.execute(sql`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY work_id ORDER BY display_order DESC, id) - 1 AS normalized
      FROM "work_media"
    )
    UPDATE "work_media" AS work_media
    SET display_order = ranked.normalized
    FROM ranked
    WHERE work_media.id = ranked.id
  `)
  await db.execute(sql`ALTER TABLE "work_media" ADD CONSTRAINT "work_media_work_display_order_unique" UNIQUE ("work_id", "display_order") DEFERRABLE INITIALLY DEFERRED`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`DROP INDEX IF EXISTS "media_storage_key_idx"`)
  await db.execute(sql`DROP INDEX IF EXISTS "media_filename_compound_idx"`)
  await db.execute(sql`ALTER TABLE "work_media" DROP CONSTRAINT IF EXISTS "work_media_work_display_order_unique"`)
  await db.execute(sql`ALTER TABLE "media" DROP COLUMN IF EXISTS "storage_key"`)
  await db.execute(sql`ALTER TABLE "media" DROP COLUMN IF EXISTS "withdrawn_at"`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "media_filename_idx" ON "media" USING btree ("filename")`)
}
