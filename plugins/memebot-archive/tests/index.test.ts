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

const unavailable = 'Archive 服务暂时不可用，请稍后重试。'

describe('Archive read-only plugin boundary', () => {
  it('declares no runtime service injection', () => {
    expect(inject).toEqual([])
  })

  it('does not require database, Console, or Access and registers only read commands', () => {
    const harness = commandHarness()
    const get = vi.fn(() => { throw new Error('legacy service lookup') })
    apply({ ...harness.ctx, get, model: { extend: vi.fn() } } as any)

    expect(get).not.toHaveBeenCalled()
    expect(harness.names).toEqual([
      'archive [id:text]',
      'archive [id:text].search <kind:string> [query:text]',
      'archive [id:text].works [query:text]',
      'archive [id:text].work-query [author:text] [query:text]',
    ])
    expect(harness.names.some(name => /publish|edit|rm|remove|restore|retry|issue|paper|console/i.test(name))).toBe(false)
  })

  it('returns the temporary-unavailable member message for every read command', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any)
    const root = harness.handlers.get('archive [id:text]')!
    const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!
    const works = harness.handlers.get('archive [id:text].works [query:text]')!
    const workQuery = harness.handlers.get('archive [id:text].work-query [author:text] [query:text]')!

    await expect(root({}, 'W1')).resolves.toBe(unavailable)
    await expect(search({}, 'works', 'example')).resolves.toBe(unavailable)
    await expect(works({}, 'example')).resolves.toBe(unavailable)
    await expect(workQuery({}, 'Alice', 'example')).resolves.toBe(unavailable)
  })

  it('does not reuse Work-not-found for a missing content backend', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any)
    const root = harness.handlers.get('archive [id:text]')!

    await expect(root({}, 'W1')).resolves.toBe(unavailable)
    await expect(root({}, 'W1')).resolves.not.toBe('Work 不存在。')
  })

  it('ignores leftover Payload configuration and does not call a content backend', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'W1', title: 'Example', author: 'Alice' }], total: 1 }), {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetch)
    try {
      const harness = commandHarness()
      apply(harness.ctx as any, {
        payload: { baseUrl: 'https://archive.test', serviceToken: 'machine-token', timeoutMs: 500 },
      } as any)
      const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!

      await expect(search({}, 'works', 'example')).resolves.toBe(unavailable)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
