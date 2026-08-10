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

const config = {
  payload: { baseUrl: 'https://archive.test', serviceToken: 'machine-token', timeoutMs: 500 },
}

describe('Archive read-only plugin boundary', () => {
  it('declares no runtime service injection', () => {
    expect(inject).toEqual([])
  })

  it('does not require database, Console, or Access and registers only read commands', () => {
    const harness = commandHarness()
    const get = vi.fn(() => { throw new Error('legacy service lookup') })
    const result = apply({ ...harness.ctx, get, model: { extend: vi.fn() } } as any, config as any)

    expect(result).toBeDefined()
    expect(get).not.toHaveBeenCalled()
    expect(harness.names).toEqual([
      'archive [id:text]',
      'archive [id:text].search <kind:string> [query:text]',
      'archive [id:text].works [query:text]',
      'archive [id:text].work-query [author:text] [query:text]',
    ])
    expect(harness.names.some(name => /publish|edit|rm|remove|restore|retry|issue|paper|console/i.test(name))).toBe(false)
  })

  it('keeps malformed or missing Payload configuration as a temporary-unavailable read result', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any, {} as any)
    const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!

    await expect(search({}, 'works')).resolves.toBe('Archive 服务暂时不可用，请稍后重试。')
  })

  it('maps the canonical Payload search response through the public command', async () => {
    const requests: Request[] = []
    vi.stubGlobal('fetch', (async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return new Response(JSON.stringify({ data: [{ id: 'W1', title: 'Example', author: 'Alice' }], total: 1 }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)
    try {
      const harness = commandHarness()
      apply(harness.ctx as any, config as any)
      const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!

      await expect(search({}, 'works', 'example')).resolves.toBe('W1 Alice - Example')
      expect(requests[0].headers.get('authorization')).toBe('Bearer machine-token')
      expect(requests[0].url).toBe('https://archive.test/api/archive/v1/works?query=example')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
