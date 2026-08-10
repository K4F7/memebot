const required = process.env.PAYLOAD_MIGRATION === '1'
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

const missing = required.filter((name) => !process.env[name])
if (missing.length) {
  throw new Error(`Missing production environment variables: ${missing.join(', ')}`)
}
