import { describe, expect, it, vi } from 'vitest'

vi.mock('koishi', () => {
  const chain = () => {
    const value: Record<string, unknown> = {}
    for (const method of ['default', 'description', 'min', 'max', 'role']) value[method] = () => value
    return value
  }
  return { Schema: { object: chain, number: chain, string: chain } }
})

import { apply, inject } from '../src/index'

interface CommandNode {
  action(handler: (...args: any[]) => Promise<unknown>): CommandNode
  subcommand(name: string, description?: string): CommandNode
}

function commandHarness() {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
  const names: string[] = []
  const command = (name: string): CommandNode => {
    names.push(name)
    const node: CommandNode = {
      action(handler) {
        handlers.set(name, handler)
        return node
      },
      subcommand(child) {
        return command(`${name}${child}`)
      },
    }
    return node
  }
  return { ctx: { command }, handlers, names }
}

const UNAVAILABLE = 'Archive 服务暂时不可用，请稍后重试。'

describe('Archive read-only plugin boundary', () => {
  it('declares no runtime service injection', () => {
    expect(inject).toEqual([])
  })

  it('does not require database, Console, or Access and registers only read commands', () => {
    const harness = commandHarness()
    const get = vi.fn(() => { throw new Error('legacy service lookup') })
    apply({ ...harness.ctx, get, model: { extend: vi.fn() } } as any, {} as any)

    expect(get).not.toHaveBeenCalled()
    expect(harness.names).toEqual([
      'archive [id:text]',
      'archive [id:text].search <kind:string> [query:text]',
      'archive [id:text].works [query:text]',
      'archive [id:text].work-query [author:text] [query:text]',
    ])
    expect(harness.names.some(name => /publish|edit|rm|remove|restore|retry|issue|paper|console/i.test(name))).toBe(false)
  })

  it('returns the temporary-unavailable member message when no content backend is configured', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any, {} as any)
    const root = harness.handlers.get('archive [id:text]')!
    const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!
    const works = harness.handlers.get('archive [id:text].works [query:text]')!
    const workQuery = harness.handlers.get('archive [id:text].work-query [author:text] [query:text]')!

    await expect(root({}, 'W1')).resolves.toBe(UNAVAILABLE)
    await expect(search({}, 'works')).resolves.toBe(UNAVAILABLE)
    await expect(search({}, 'works', 'example')).resolves.toBe(UNAVAILABLE)
    await expect(works({}, 'example')).resolves.toBe(UNAVAILABLE)
    await expect(workQuery({}, 'Alice', 'example')).resolves.toBe(UNAVAILABLE)
  })

  it('keeps unsupported kind and id validation distinct from backend unavailability', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any, {} as any)
    const root = harness.handlers.get('archive [id:text]')!
    const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!

    await expect(root({})).resolves.toBe('请使用 /archive search works [查询] 或 /archive W<n>。')
    await expect(root({}, 'paper-1')).resolves.toBe('当前 Archive 仅支持 Work W<n>。')
    await expect(search({}, 'paper')).resolves.toBe('当前 Archive 仅支持 Work 查询。')
  })
})
