import { describe, expect, it, vi } from 'vitest'

const { send } = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@koishijs/client', () => ({ send }))

import register from '../client/index'

describe('Access Console client', () => {
  it('registers a login-gated management page', () => {
    const page = vi.fn()

    register({ page } as any)

    expect(page).toHaveBeenCalledWith(expect.objectContaining({
      id: 'memebot-access',
      path: '/memebot/access',
      name: 'Access 授权',
      authority: 1,
      component: expect.any(Object),
    }))
  })
})
