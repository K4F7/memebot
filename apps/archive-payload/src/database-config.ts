export function databaseConnectionString(env: Record<string, string | undefined>): string | undefined {
  return env.PAYLOAD_MIGRATION === '1' ? env.DATABASE_MIGRATION_URL : env.DATABASE_URL
}
