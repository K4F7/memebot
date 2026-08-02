import { describe, expect, it, vi } from 'vitest'

const { iconRegister } = vi.hoisted(() => ({ iconRegister: vi.fn() }))

vi.mock('@koishijs/client', () => ({ icons: { register: iconRegister } }))
vi.mock('../client/icons/ArchiveIcon.vue', () => ({ default: {} }))
vi.mock('../client/pages/ArchivePage.vue', () => ({ default: {} }))

import register from '../client/index'

describe('Archive Console client', () => {
  it('registers the themed icon and login-gated 迷因档案 page', () => {
    const page = vi.fn()

    register({ page } as any)

    expect(iconRegister).toHaveBeenCalledWith('activity:archive', expect.any(Object))
    expect(page).toHaveBeenCalledWith(expect.objectContaining({
      id: 'memebot-archive',
      path: '/memebot/archive',
      name: '迷因档案',
      icon: 'activity:archive',
      authority: 1,
      component: expect.any(Object),
    }))
  })
})
