import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import archive, { apply, inject } from '../src/index'
import { createKoishiTestHarness, type KoishiTestHarness } from '../../../tests/koishi'

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
const NOT_FOUND = 'Work 不存在。'
const TOKEN = 'archive-read-token'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<>\n%%EOF\n')

interface MediaFixture {
  mediaId: string
  filename: string
  mediaType: string
  caption: string | null
  bytes: Buffer
}

interface WorkFixture {
  archiveId: string
  title: string
  summary: string
  author: string
  published?: boolean
  media: MediaFixture[]
}

interface MockOptions {
  token?: string
  pluginToken?: string
  works?: WorkFixture[]
  statusFor?: (req: IncomingMessage) => number | undefined
}

const publishedWorks: WorkFixture[] = [
  {
    archiveId: 'W1',
    title: '例会纪要',
    summary: '第一次例会记录',
    author: 'Alice',
    media: [
      { mediaId: 'cover-1', filename: 'cover.png', mediaType: 'image/png', caption: '封面', bytes: PNG },
      { mediaId: 'essay-1', filename: 'essay.pdf', mediaType: 'application/pdf', caption: '附件', bytes: PDF },
    ],
  },
  {
    archiveId: 'W2',
    title: '另一份作品',
    summary: 'Blue fox summary',
    author: 'Bob',
    media: [
      { mediaId: 'other-1', filename: 'other.png', mediaType: 'image/png', caption: null, bytes: PNG },
    ],
  },
  {
    archiveId: 'W3',
    title: '未发布草稿',
    summary: '不应出现',
    author: 'Alice',
    published: false,
    media: [
      { mediaId: 'draft-1', filename: 'draft.png', mediaType: 'image/png', caption: null, bytes: PNG },
    ],
  },
  {
    archiveId: 'W4',
    title: '空媒体清单',
    summary: '已发布但无媒体',
    author: 'Alice',
    media: [],
  },
]

function readable(work: WorkFixture) {
  return work.published !== false && work.media.length > 0
}

function presentedToken(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header || ''
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match?.[1]?.trim()
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"') || 'file'
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function createContractServer(options: MockOptions = {}) {
  const expected = options.token ?? TOKEN
  const works = options.works ?? publishedWorks
  const requested: string[] = []

  const server = createServer((req, res) => {
    requested.push(`${req.method} ${req.url}`)
    const forced = options.statusFor?.(req)
    if (forced) {
      res.writeHead(forced)
      res.end()
      return
    }
    if (presentedToken(req.headers.authorization) !== expected) {
      sendJson(res, 401, { error: { status: 401, name: 'Unauthorized' } })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method !== 'GET') {
      res.writeHead(404)
      res.end()
      return
    }

    if (url.pathname === '/api/archive/v1/works') {
      const query = (url.searchParams.get('query') || '').trim()
      const author = (url.searchParams.get('author') || '').trim()
      const matches = works.filter((work) => {
        if (!readable(work)) return false
        if (query) {
          const haystack = `${work.title}\n${work.summary}`.toLocaleLowerCase()
          if (!haystack.includes(query.toLocaleLowerCase())) return false
        }
        if (author && work.author.toLocaleLowerCase() !== author.toLocaleLowerCase()) return false
        return true
      })
      sendJson(res, 200, {
        data: matches.map(({ archiveId, title, summary, author: workAuthor }) => ({
          archiveId, title, summary, author: workAuthor,
        })),
        total: matches.length,
      })
      return
    }

    const workMatch = /^\/api\/archive\/v1\/works\/([^/]+)$/.exec(url.pathname)
    if (workMatch) {
      const archiveId = decodeURIComponent(workMatch[1])
      const work = works.find(item => item.archiveId === archiveId)
      if (!work || !readable(work)) {
        sendJson(res, 404, { error: { status: 404, name: 'NotFound' } })
        return
      }
      sendJson(res, 200, {
        data: {
          archiveId: work.archiveId,
          title: work.title,
          summary: work.summary,
          author: work.author,
          media: work.media.map(({ mediaId, filename, mediaType, caption, bytes }) => ({
            mediaId, filename, mediaType, size: bytes.length, caption,
          })),
        },
      })
      return
    }

    const mediaMatch = /^\/api\/archive\/v1\/media\/([^/]+)$/.exec(url.pathname)
    if (mediaMatch) {
      const mediaId = decodeURIComponent(mediaMatch[1])
      const work = works.find(item => readable(item) && item.media.some(media => media.mediaId === mediaId))
      const media = work?.media.find(item => item.mediaId === mediaId)
      if (!media) {
        sendJson(res, 404, { error: { status: 404, name: 'NotFound' } })
        return
      }
      res.writeHead(200, {
        'content-type': media.mediaType,
        'content-disposition': contentDisposition(media.filename),
        'content-length': String(media.bytes.length),
      })
      res.end(media.bytes)
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, requested }
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock contract server has no address')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

const harnesses: KoishiTestHarness[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.stop()))
  await Promise.all(servers.splice(0).map(closeServer))
  vi.restoreAllMocks()
})

async function startBound(options: MockOptions = {}, originSuffix = '') {
  const { server, requested } = createContractServer(options)
  servers.push(server)
  const origin = await listen(server)
  const harness = await createKoishiTestHarness(archive, {
    origin: `${origin}${originSuffix}`,
    token: options.pluginToken ?? options.token ?? TOKEN,
  })
  harnesses.push(harness)
  const member = await harness.client({ userId: '10002', channelId: '20001' })
  return { member, requested, origin }
}

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
      'archive [id:text].work-query [author:string] [query:text]',
    ])
    expect(harness.names.some(name => /publish|edit|rm|remove|restore|retry|issue|paper|console/i.test(name))).toBe(false)
  })

  it('returns the temporary-unavailable member message when no content backend is configured', async () => {
    const harness = commandHarness()
    apply(harness.ctx as any, {} as any)
    const root = harness.handlers.get('archive [id:text]')!
    const search = harness.handlers.get('archive [id:text].search <kind:string> [query:text]')!
    const works = harness.handlers.get('archive [id:text].works [query:text]')!
    const workQuery = harness.handlers.get('archive [id:text].work-query [author:string] [query:text]')!

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

describe('Archive Read Contract QQ commands', () => {
  it('fail-closes the four read commands when origin or token is missing', async () => {
    const cases: Array<Record<string, string>> = [{}, { origin: 'http://127.0.0.1:9' }, { token: TOKEN }, { origin: '  ', token: '  ' }]
    for (const config of cases) {
      const harness = await createKoishiTestHarness(archive, config)
      harnesses.push(harness)
      const member = await harness.client({ userId: '10002', channelId: '20001' })
      await expect(member.receive('archive.search works')).resolves.toEqual([UNAVAILABLE])
      await expect(member.receive('archive.works example')).resolves.toEqual([UNAVAILABLE])
      await expect(member.receive('archive.work-query Alice example')).resolves.toEqual([UNAVAILABLE])
      await expect(member.receive('archive W1')).resolves.toEqual([UNAVAILABLE])
    }
  })

  it('searches published Works with query and reports archiveId, title, author, and exact total', async () => {
    const { member, requested } = await startBound()
    await expect(member.receive('archive.search works 例会')).resolves.toEqual([
      '共 1 条 Work。\nW1 例会纪要（Alice）',
    ])
    await expect(member.receive('archive.works fox')).resolves.toEqual([
      '共 1 条 Work。\nW2 另一份作品（Bob）',
    ])
    expect(requested.every(entry => entry.startsWith('GET /api/archive/v1/'))).toBe(true)
    expect(requested.some(entry => entry.includes('/api/archive/v1/works?query='))).toBe(true)
  })

  it('searches by author and query and returns a short total-0 message for empty hits', async () => {
    const { member } = await startBound()
    await expect(member.receive('archive.work-query Alice 例会')).resolves.toEqual([
      '共 1 条 Work。\nW1 例会纪要（Alice）',
    ])
    await expect(member.receive('archive.work-query alice')).resolves.toEqual([
      '共 1 条 Work。\nW1 例会纪要（Alice）',
    ])
    const empty = await member.receive('archive.search works zzzz-no-such-work')
    expect(empty).toEqual(['共 0 条 Work。'])
    expect(empty.join('\n')).not.toContain(NOT_FOUND)
  })

  it('delivers Work detail, ordered images, PDF files, and captions', async () => {
    const { member, requested } = await startBound({}, '/')
    const messages = await member.receive('archive W1')
    expect(messages[0]).toBe('例会纪要\n作者：Alice\n第一次例会记录')
    expect(messages[1]).toContain('<img')
    expect(messages[1]).toContain('data:image/png;base64,')
    expect(messages[1]).toContain(PNG.toString('base64'))
    expect(messages[1]).toContain('封面')
    expect(messages[2]).toContain('<file')
    expect(messages[2]).toContain('data:application/pdf;base64,')
    expect(messages[2]).toContain(PDF.toString('base64'))
    expect(messages[2]).toContain('essay.pdf')
    expect(messages[2]).toContain('附件')
    expect(messages).toHaveLength(3)
    expect(requested).toEqual([
      'GET /api/archive/v1/works/W1',
      'GET /api/archive/v1/media/cover-1',
      'GET /api/archive/v1/media/essay-1',
    ])
  })

  it('returns Work 不存在 for missing, unpublished, or empty-media Works', async () => {
    const { member } = await startBound()
    await expect(member.receive('archive W99')).resolves.toEqual([NOT_FOUND])
    await expect(member.receive('archive W3')).resolves.toEqual([NOT_FOUND])
    await expect(member.receive('archive W4')).resolves.toEqual([NOT_FOUND])
  })

  it('treats 401, 403, 5xx, and network failures as unavailable, not not-found', async () => {
    const unauthorized = await startBound({ pluginToken: 'not-the-archive-read-token' })
    await expect(unauthorized.member.receive('archive.search works 例会')).resolves.toEqual([UNAVAILABLE])
    await expect(unauthorized.member.receive('archive W1')).resolves.toEqual([UNAVAILABLE])

    const forbidden = await startBound({ statusFor: () => 403 })
    await expect(forbidden.member.receive('archive.works 例会')).resolves.toEqual([UNAVAILABLE])
    await expect(forbidden.member.receive('archive W1')).resolves.toEqual([UNAVAILABLE])

    const serverError = await startBound({ statusFor: () => 500 })
    const search500 = await serverError.member.receive('archive.work-query Alice 例会')
    const detail500 = await serverError.member.receive('archive W1')
    expect(search500).toEqual([UNAVAILABLE])
    expect(detail500).toEqual([UNAVAILABLE])
    expect(search500.join('\n')).not.toContain(NOT_FOUND)
    expect(detail500.join('\n')).not.toContain(NOT_FOUND)

    const closed = createServer()
    servers.push(closed)
    const origin = await listen(closed)
    await closeServer(closed)
    servers.pop()
    const harness = await createKoishiTestHarness(archive, { origin, token: TOKEN })
    harnesses.push(harness)
    const member = await harness.client({ userId: '10002', channelId: '20001' })
    const network = await member.receive('archive W1')
    expect(network).toEqual([UNAVAILABLE])
    expect(network.join('\n')).not.toContain(NOT_FOUND)
  })

  it('continues after a single media failure and never logs the machine credential', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { member } = await startBound({
      statusFor: (req) => req.url?.includes('/media/essay-1') ? 500 : undefined,
    })
    const messages = await member.receive('archive W1')
    expect(messages[0]).toContain('例会纪要')
    expect(messages[1]).toContain('<img')
    expect(messages[1]).toContain('封面')
    expect(messages.some(message => message.includes('essay.pdf') && message.includes('暂时无法投递'))).toBe(true)
    expect(messages.some(message => message.includes('<file') && message.includes('essay.pdf'))).toBe(false)

    const leaked = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(value => String(value))
      .some(value => value.includes(TOKEN))
    expect(leaked).toBe(false)
    expect(messages.join('\n')).not.toContain(TOKEN)
  })
})
