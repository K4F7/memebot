import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Stores the Work aggregate in Payload's draft/version tables and records
 * upload lifecycle state needed by the authenticated authoring boundary.
 * This migration is additive and deliberately does not rewrite the existing
 * WorkMedia collection: the published manifest is the public projection.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "enum_works_status" AS ENUM ('draft', 'published');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      CREATE TYPE "enum__works_v_version_status" AS ENUM ('draft', 'published');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      CREATE TYPE "enum_media_upload_status" AS ENUM ('pending', 'finalized');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      CREATE TYPE "enum_media_cleanups_status" AS ENUM ('pending', 'processing', 'deleted', 'failed');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    ALTER TYPE "enum_media_cleanups_status" ADD VALUE IF NOT EXISTS 'processing';
  `)

  await db.execute(sql`
    ALTER TABLE "works"
      ADD COLUMN IF NOT EXISTS "revision" varchar,
      ADD COLUMN IF NOT EXISTS "media_manifest" jsonb DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS "published_at" timestamp(3) with time zone,
      ADD COLUMN IF NOT EXISTS "_status" "enum_works_status" DEFAULT 'draft';
    ALTER TABLE "works" ALTER COLUMN "revision" SET DEFAULT '';
    UPDATE "works" SET "revision" = 'rev_legacy_' || id::text WHERE "revision" IS NULL;
    UPDATE "works" SET "media_manifest" = '[]'::jsonb WHERE "media_manifest" IS NULL;
    UPDATE "works" SET "_status" = 'draft' WHERE "_status" IS NULL;
    ALTER TABLE "works" ALTER COLUMN "revision" SET NOT NULL;
    ALTER TABLE "works" ALTER COLUMN "media_manifest" SET NOT NULL;
    ALTER TABLE "works" ALTER COLUMN "_status" SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "works__status_idx" ON "works" USING btree ("_status");
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "_works_v" (
      "id" serial PRIMARY KEY NOT NULL,
      "parent_id" integer,
      "version_archive_id" varchar,
      "version_title" varchar,
      "version_author" varchar,
      "version_description" varchar,
      "version_revision" varchar,
      "version_media_manifest" jsonb DEFAULT '[]'::jsonb,
      "version_published_at" timestamp(3) with time zone,
      "version_updated_at" timestamp(3) with time zone,
      "version_created_at" timestamp(3) with time zone,
      "version__status" "enum__works_v_version_status" DEFAULT 'draft',
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "latest" boolean
    );
    ALTER TABLE "_works_v" ADD CONSTRAINT "_works_v_parent_id_fk"
      FOREIGN KEY ("parent_id") REFERENCES "public"."works"("id") ON DELETE SET NULL ON UPDATE no action;
    CREATE INDEX IF NOT EXISTS "_works_v_parent_idx" ON "_works_v" USING btree ("parent_id");
    CREATE INDEX IF NOT EXISTS "_works_v_version_version_archive_id_idx" ON "_works_v" USING btree ("version_archive_id");
    CREATE INDEX IF NOT EXISTS "_works_v_version_version_updated_at_idx" ON "_works_v" USING btree ("version_updated_at");
    CREATE INDEX IF NOT EXISTS "_works_v_version_version_created_at_idx" ON "_works_v" USING btree ("version_created_at");
    CREATE INDEX IF NOT EXISTS "_works_v_version_version__status_idx" ON "_works_v" USING btree ("version__status");
    CREATE INDEX IF NOT EXISTS "_works_v_created_at_idx" ON "_works_v" USING btree ("created_at");
    CREATE INDEX IF NOT EXISTS "_works_v_updated_at_idx" ON "_works_v" USING btree ("updated_at");
    CREATE INDEX IF NOT EXISTS "_works_v_latest_idx" ON "_works_v" USING btree ("latest");
  `)

  await db.execute(sql`
    ALTER TABLE "media"
      ADD COLUMN IF NOT EXISTS "upload_status" "enum_media_upload_status" DEFAULT 'finalized',
      ADD COLUMN IF NOT EXISTS "upload_id" varchar,
      ADD COLUMN IF NOT EXISTS "idempotency_key" varchar,
      ADD COLUMN IF NOT EXISTS "content_fingerprint" varchar,
      ADD COLUMN IF NOT EXISTS "replace_media_id" varchar,
      ADD COLUMN IF NOT EXISTS "selection_index" numeric,
      ADD COLUMN IF NOT EXISTS "ever_published" boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS "upload_context" jsonb;
    UPDATE "media" SET "upload_status" = 'finalized' WHERE "upload_status" IS NULL;
    UPDATE "media" SET "ever_published" = false WHERE "ever_published" IS NULL;
    ALTER TABLE "media" ALTER COLUMN "upload_status" SET NOT NULL;
    ALTER TABLE "media" ALTER COLUMN "ever_published" SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "media_upload_id_idx" ON "media" USING btree ("upload_id");
    CREATE INDEX IF NOT EXISTS "media_idempotency_key_idx" ON "media" USING btree ("idempotency_key");
    CREATE UNIQUE INDEX IF NOT EXISTS "media_work_idempotency_key_idx"
      ON "media" USING btree ("work_id", "idempotency_key")
      WHERE "idempotency_key" IS NOT NULL;
  `)

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "media_cleanups" (
      "id" serial PRIMARY KEY NOT NULL,
      "work_id" integer NOT NULL,
      "media_id" varchar NOT NULL,
      "storage_key" varchar NOT NULL,
      "status" "enum_media_cleanups_status" DEFAULT 'pending' NOT NULL,
      "attempts" numeric DEFAULT 0 NOT NULL,
      "last_error" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "media_cleanups" ADD CONSTRAINT "media_cleanups_work_id_fk"
      FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE SET NULL ON UPDATE no action;
    CREATE INDEX IF NOT EXISTS "media_cleanups_work_idx" ON "media_cleanups" USING btree ("work_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "media_cleanups_storage_key_idx" ON "media_cleanups" USING btree ("storage_key");
    CREATE INDEX IF NOT EXISTS "media_cleanups_updated_at_idx" ON "media_cleanups" USING btree ("updated_at");
    CREATE INDEX IF NOT EXISTS "media_cleanups_created_at_idx" ON "media_cleanups" USING btree ("created_at");
  `)

  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "media_cleanups_id" integer;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_media_cleanups_id_idx"
      ON "payload_locked_documents_rels" USING btree ("media_cleanups_id");
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_cleanups_fk"
      FOREIGN KEY ("media_cleanups_id") REFERENCES "public"."media_cleanups"("id") ON DELETE cascade ON UPDATE no action;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_media_cleanups_fk"`)
  await db.execute(sql`DROP INDEX IF EXISTS "payload_locked_documents_rels_media_cleanups_id_idx"`)
  await db.execute(sql`ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "media_cleanups_id"`)
  await db.execute(sql`DROP TABLE IF EXISTS "media_cleanups" CASCADE`)
  await db.execute(sql`DROP INDEX IF EXISTS "media_work_idempotency_key_idx"`)
  await db.execute(sql`ALTER TABLE "media" DROP COLUMN IF EXISTS "upload_status", DROP COLUMN IF EXISTS "upload_id", DROP COLUMN IF EXISTS "idempotency_key", DROP COLUMN IF EXISTS "content_fingerprint", DROP COLUMN IF EXISTS "replace_media_id", DROP COLUMN IF EXISTS "selection_index", DROP COLUMN IF EXISTS "ever_published", DROP COLUMN IF EXISTS "upload_context"`)
  await db.execute(sql`DROP TABLE IF EXISTS "_works_v" CASCADE`)
  await db.execute(sql`ALTER TABLE "works" DROP COLUMN IF EXISTS "revision", DROP COLUMN IF EXISTS "media_manifest", DROP COLUMN IF EXISTS "published_at", DROP COLUMN IF EXISTS "_status"`)
  await db.execute(sql`DROP TYPE IF EXISTS "enum_media_cleanups_status"`)
  await db.execute(sql`DROP TYPE IF EXISTS "enum_media_upload_status"`)
  await db.execute(sql`DROP TYPE IF EXISTS "enum__works_v_version_status"`)
  await db.execute(sql`DROP TYPE IF EXISTS "enum_works_status"`)
}
