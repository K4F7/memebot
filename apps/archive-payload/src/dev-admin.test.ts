import { describe, expect, it, vi } from 'vitest'

import {
  getDevelopmentAdminSeedConfig,
  seedDevelopmentAdmin,
  type DevelopmentAdminSeedPayload,
} from './dev-admin'

const enabledEnvironment = {
  NODE_ENV: 'development',
  PAYLOAD_DEV_ADMIN_EMAIL: 'dev@example.com',
  PAYLOAD_DEV_ADMIN_PASSWORD: 'local-development-password',
  PAYLOAD_DEV_ADMIN_SEED: '1',
}

describe('development admin seed configuration', () => {
  it('is disabled unless development seeding is explicitly enabled', () => {
    expect(getDevelopmentAdminSeedConfig({ NODE_ENV: 'development' })).toBeUndefined()
    expect(getDevelopmentAdminSeedConfig({
      ...enabledEnvironment,
      NODE_ENV: 'production',
    })).toBeUndefined()
    expect(getDevelopmentAdminSeedConfig({
      ...enabledEnvironment,
      PAYLOAD_BUILD: '1',
    })).toBeUndefined()
  })

  it('requires both credentials and a development-safe password length', () => {
    expect(() => getDevelopmentAdminSeedConfig({
      ...enabledEnvironment,
      PAYLOAD_DEV_ADMIN_PASSWORD: undefined,
    })).toThrow('PAYLOAD_DEV_ADMIN_EMAIL and PAYLOAD_DEV_ADMIN_PASSWORD')

    expect(() => getDevelopmentAdminSeedConfig({
      ...enabledEnvironment,
      PAYLOAD_DEV_ADMIN_PASSWORD: 'too-short',
    })).toThrow('at least 12 characters')
  })
})

describe('seedDevelopmentAdmin', () => {
  it('creates the configured account once and never overwrites it', async () => {
    let created = false
    const payload: DevelopmentAdminSeedPayload = {
      find: vi.fn(async () => ({ docs: created ? [{ id: 1 }] : [] })),
      create: vi.fn(async () => {
        created = true
        return { id: 1 }
      }),
    }

    await expect(seedDevelopmentAdmin(payload, enabledEnvironment)).resolves.toEqual({
      email: 'dev@example.com',
      status: 'created',
    })
    await expect(seedDevelopmentAdmin(payload, enabledEnvironment)).resolves.toEqual({
      email: 'dev@example.com',
      status: 'exists',
    })

    expect(payload.create).toHaveBeenCalledTimes(1)
    expect(payload.create).toHaveBeenCalledWith({
      collection: 'users',
      data: {
        email: 'dev@example.com',
        password: 'local-development-password',
      },
      overrideAccess: true,
    })
  })

  it('does not touch the database when disabled', async () => {
    const payload: DevelopmentAdminSeedPayload = {
      find: vi.fn(),
      create: vi.fn(),
    }

    await expect(seedDevelopmentAdmin(payload, { NODE_ENV: 'development' })).resolves.toEqual({
      status: 'skipped',
    })
    expect(payload.find).not.toHaveBeenCalled()
    expect(payload.create).not.toHaveBeenCalled()
  })
})
