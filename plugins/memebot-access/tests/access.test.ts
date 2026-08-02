import { Context } from 'koishi'
import memory from '@koishijs/plugin-database-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'

import accessPlugin, { AccessService, defineAccessModels } from '../src/index'

const contexts: Context[] = []

async function createDatabaseContext() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.plugin(memory)
  defineAccessModels(ctx)
  await ctx.start()
  return ctx
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.stop()))
})

describe('Access persistence', () => {
  it('provides the initialized access service when the plugin starts', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.plugin(memory)
    ctx.plugin(accessPlugin, {
      administrators: [{ qq: '10001' }],
      managementGroups: [{ qq: '20001' }],
    })

    await ctx.start()

    expect(ctx.access).toBeInstanceOf(AccessService)
    expect(await ctx.access.listExplicitAdministrators()).toEqual(['10001'])
    expect(await ctx.access.listManagementGroups()).toEqual(['20001'])
  })

  it('normalizes seeds once and preserves deliberately empty sets on restart', async () => {
    const ctx = await createDatabaseContext()
    const first = new AccessService(ctx)

    await first.initialize({
      administrators: [{ qq: ' 10001 ' }, { qq: '10001' }],
      managementGroups: [{ qq: ' 20001 ' }],
    })

    expect(await first.listExplicitAdministrators()).toEqual(['10001'])
    expect(await first.listManagementGroups()).toEqual(['20001'])

    await first.removeExplicitAdministrator('10001')
    await first.removeManagementGroup('20001')

    const restarted = new AccessService(ctx)
    await restarted.initialize({
      administrators: [{ qq: '30001' }],
      managementGroups: [{ qq: '40001' }],
    })

    expect(await restarted.listExplicitAdministrators()).toEqual([])
    expect(await restarted.listManagementGroups()).toEqual([])
  })

  it('rolls back imported seeds when recording initialization fails', async () => {
    const ctx = await createDatabaseContext()
    const access = new AccessService(ctx)
    const databasePrototype = Object.getPrototypeOf(ctx.database)
    const originalCreate = databasePrototype.create
    const create = vi.spyOn(databasePrototype, 'create').mockImplementation(function (table: string, data: unknown) {
      if (table === 'memebotAccessInitialization') throw new Error('marker write failed')
      return originalCreate.call(this, table, data)
    })

    await expect(access.initialize({
      administrators: [{ qq: '10001' }],
      managementGroups: [{ qq: '20001' }],
    })).rejects.toThrow('marker write failed')
    expect(await access.listExplicitAdministrators()).toEqual([])
    expect(await access.listManagementGroups()).toEqual([])

    create.mockRestore()
    await access.initialize({
      administrators: [{ qq: '10001' }],
      managementGroups: [{ qq: '20001' }],
    })
    expect(await access.listExplicitAdministrators()).toEqual(['10001'])
    expect(await access.listManagementGroups()).toEqual(['20001'])
  })
})

describe('Access decisions', () => {
  it('allows explicit and authority 4 administrators to read in any chat', async () => {
    const ctx = await createDatabaseContext()
    const access = new AccessService(ctx)
    await access.initialize({
      administrators: [{ qq: '10001' }],
      managementGroups: [],
    })

    await expect(access.isAdministrator({
      userId: '10001', guildId: 'unlisted', user: { authority: 1 },
    })).resolves.toBe(true)
    await expect(access.authorizeRead({
      userId: 'other', guildId: 'unlisted', user: { authority: 4 },
    })).resolves.toEqual({ allowed: true })
    await expect(access.authorizeRead({
      userId: 'ordinary', guildId: 'unlisted', user: { authority: 3 },
    })).resolves.toEqual({
      allowed: false,
      reason: 'identity',
      message: '你不是管理员。',
    })
  })

  it('requires identity for private writes and identity plus location for group writes', async () => {
    const ctx = await createDatabaseContext()
    const access = new AccessService(ctx)
    await access.initialize({
      administrators: [{ qq: '10001' }],
      managementGroups: [{ qq: '20001' }],
    })

    await expect(access.authorizeWrite({
      userId: '10001', user: { authority: 1 },
    })).resolves.toEqual({ allowed: true })
    await expect(access.authorizeWrite({
      userId: '10001', guildId: '20001', user: { authority: 1 },
    })).resolves.toEqual({ allowed: true })
    await expect(access.authorizeWrite({
      userId: 'ordinary', guildId: '20001', user: { authority: 1 },
    })).resolves.toEqual({
      allowed: false,
      reason: 'identity',
      message: '你不是管理员。',
    })
    await expect(access.authorizeWrite({
      userId: '10001', guildId: 'unlisted', user: { authority: 1 },
    })).resolves.toEqual({
      allowed: false,
      reason: 'location',
      message: '此群不是管理群，请私聊操作或先添加该群。',
    })

    await access.removeManagementGroup('20001')
    await expect(access.authorizeWrite({
      userId: 'authority-four', guildId: '20001', user: { authority: 4 },
    })).resolves.toMatchObject({ allowed: false, reason: 'location' })
  })

  it('uses only persisted administrators as explicit targets and applies changes immediately', async () => {
    const ctx = await createDatabaseContext()
    const access = new AccessService(ctx)
    await access.initialize({ administrators: [], managementGroups: [] })

    const authorityFour = {
      userId: '40001', guildId: '20001', user: { authority: 4 },
    }
    await expect(access.isAdministrator(authorityFour)).resolves.toBe(true)
    await expect(access.isExplicitAdministratorTarget('40001')).resolves.toBe(false)

    await access.addExplicitAdministrator(' 40001 ')
    await access.addManagementGroup(' 20001 ')
    await expect(access.isExplicitAdministratorTarget('40001')).resolves.toBe(true)
    await expect(access.authorizeWrite(authorityFour)).resolves.toEqual({ allowed: true })

    await access.removeExplicitAdministrator('40001')
    await access.removeManagementGroup('20001')
    await expect(access.isExplicitAdministratorTarget('40001')).resolves.toBe(false)
    await expect(access.authorizeWrite(authorityFour)).resolves.toMatchObject({
      allowed: false, reason: 'location',
    })
  })
})
