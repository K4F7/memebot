import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-d1-sqlite'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`work_media_media_idx\`;`)
  await db.run(sql`CREATE UNIQUE INDEX \`work_media_media_idx\` ON \`work_media\` (\`media_id\`);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.run(sql`DROP INDEX \`work_media_media_idx\`;`)
  await db.run(sql`CREATE INDEX \`work_media_media_idx\` ON \`work_media\` (\`media_id\`);`)
}
