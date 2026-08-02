import { describe, expect, it, vi } from 'vitest'

vi.mock('@koishijs/client', () => ({ send: vi.fn() }))

import register from '../client/index'

describe('Archive Console client', () => {
  it('registers a login-gated page for every authenticated Console account', () => {
    const page = vi.fn()

    register({ page } as any)

    expect(page).toHaveBeenCalledWith(expect.objectContaining({
      id: 'memebot-archive',
      path: '/memebot/archive',
      name: 'Archive 归档',
      authority: 1,
      component: expect.any(Object),
    }))
  })
})
