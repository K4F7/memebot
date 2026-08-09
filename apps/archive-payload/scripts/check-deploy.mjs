import { readFile } from 'node:fs/promises'

if (!process.env.PAYLOAD_SECRET) {
  throw new Error('PAYLOAD_SECRET must be set before deploying the Payload application.')
}

const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
if (wrangler.includes('REPLACE_WITH_D1_DATABASE_ID')) {
  throw new Error('Replace d1_databases[0].database_id in wrangler.jsonc before deploying.')
}
