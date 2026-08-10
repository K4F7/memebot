import { describe, expect, it } from 'vitest'

import { databaseConnectionString } from './database-config'

describe('database connection selection', () => {
  it('uses the direct URL for manual migrations', () => {
    expect(databaseConnectionString({
      PAYLOAD_MIGRATION: '1',
      DATABASE_URL: 'postgresql://pooled.example/db',
      DATABASE_MIGRATION_URL: 'postgresql://direct.example/db',
    })).toBe('postgresql://direct.example/db')
  })

  it('uses the pooled URL for request-serving runtime', () => {
    expect(databaseConnectionString({
      DATABASE_URL: 'postgresql://pooled.example/db',
      DATABASE_MIGRATION_URL: 'postgresql://direct.example/db',
    })).toBe('postgresql://pooled.example/db')
  })
})
