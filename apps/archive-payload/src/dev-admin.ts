export type DevelopmentAdminSeedConfig = {
  email: string
  password: string
}

export type DevelopmentAdminSeedResult =
  | { status: 'skipped' }
  | { email: string; status: 'created' | 'exists' }

type SeedEnvironment = Record<string, string | undefined>

export type DevelopmentAdminSeedPayload = {
  create: (options: {
    collection: 'users'
    data: { email: string; password: string }
    overrideAccess: true
  }) => Promise<unknown>
  find: (options: {
    collection: 'users'
    limit: number
    pagination: false
    overrideAccess: true
    where: { email: { equals: string } }
  }) => Promise<{ docs?: Array<{ id?: number | string }> }>
}

/**
 * Return development seed credentials only when the explicit opt-in is safe.
 *
 * The build and migration guards are intentionally separate from NODE_ENV so a
 * locally configured secret cannot seed an account during a production build
 * or a schema migration.
 */
export function getDevelopmentAdminSeedConfig(
  env: SeedEnvironment = process.env,
): DevelopmentAdminSeedConfig | undefined {
  if (
    env.NODE_ENV !== 'development' ||
    env.PAYLOAD_BUILD === '1' ||
    env.PAYLOAD_MIGRATION === '1' ||
    env.PAYLOAD_DEV_ADMIN_SEED !== '1'
  ) {
    return undefined
  }

  const email = env.PAYLOAD_DEV_ADMIN_EMAIL?.trim().toLowerCase()
  const password = env.PAYLOAD_DEV_ADMIN_PASSWORD

  if (!email || !password) {
    throw new Error(
      'PAYLOAD_DEV_ADMIN_SEED=1 requires PAYLOAD_DEV_ADMIN_EMAIL and PAYLOAD_DEV_ADMIN_PASSWORD.',
    )
  }

  if (password.length < 12) {
    throw new Error('PAYLOAD_DEV_ADMIN_PASSWORD must be at least 12 characters long.')
  }

  return { email, password }
}

/**
 * Idempotently create one development-only Payload Admin account.
 *
 * Existing accounts are never overwritten, especially not their passwords.
 */
export async function seedDevelopmentAdmin(
  payload: DevelopmentAdminSeedPayload,
  env: SeedEnvironment = process.env,
): Promise<DevelopmentAdminSeedResult> {
  const config = getDevelopmentAdminSeedConfig(env)
  if (!config) return { status: 'skipped' }

  const existing = await payload.find({
    collection: 'users',
    limit: 1,
    pagination: false,
    overrideAccess: true,
    where: { email: { equals: config.email } },
  })

  if (existing.docs?.length) return { email: config.email, status: 'exists' }

  await payload.create({
    collection: 'users',
    data: { email: config.email, password: config.password },
    overrideAccess: true,
  })

  return { email: config.email, status: 'created' }
}
