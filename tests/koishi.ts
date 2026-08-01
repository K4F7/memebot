import memory from '@koishijs/plugin-database-memory'
import mock, { type MessageClient } from '@koishijs/plugin-mock'
import { Bot, Context, h, Universal, type Fragment } from 'koishi'

export interface MockClientOptions {
  userId: string
  channelId?: string
  authority?: number
}

export interface BroadcastOutput {
  targets: BroadcastTarget[]
  content: string
}

export type BroadcastTarget = `${string}:${string}`

export interface InboundMessage {
  userId: string
  channelId: string
  quote?: { messageId: string; content: string }
}

export interface KoishiTestHarness<Result = unknown> {
  app: Context
  pluginResult: Result
  broadcasts: BroadcastOutput[]
  messages: InboundMessage[]
  registerBroadcastTargets(targets: BroadcastTarget[]): Promise<void>
  client(options: MockClientOptions): Promise<MessageClient>
  stop(): Promise<void>
}

export interface TestPlugin<Config, Result> {
  name?: string
  Config?: unknown
  apply(ctx: Context, config: Config): Result
}

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends object ? DeepPartial<T[Key]> : T[Key]
}

class BroadcastCaptureBot extends Bot {
  constructor(ctx: Context, outputs: BroadcastOutput[]) {
    super(ctx as any, {}, 'qq')
    this.selfId = '514'
    this.status = Universal.Status.ONLINE
    this.sendMessage = async (channelId: string, content: Fragment) => {
      outputs.push({
        targets: [`${this.platform}:${channelId}`],
        content: String(content),
      })
      return [`capture:${channelId}`]
    }
  }
}

export function qqQuotedCommand(messageId: string, quotedContent: string, command: string) {
  return `${h('quote', { id: messageId }, quotedContent)}${command}`
}

export function createDeliveryCapture<T>(options: { failForward?: boolean } = {}) {
  const forwarded: T[] = []
  const ordinary: T[] = []

  return {
    forwarded,
    ordinary,
    sender: {
      async forward(_session: unknown, item: T) {
        forwarded.push(item)
        if (options.failForward) throw new Error('forward-message unavailable')
        return item
      },
      async ordinary(_session: unknown, item: T) {
        ordinary.push(item)
        return item
      },
    },
  }
}

export async function createKoishiTestHarness<Config, Result>(
  plugin: TestPlugin<Config, Result>,
  config: DeepPartial<Config>,
): Promise<KoishiTestHarness<Result>> {
  const app = new Context({ delay: { broadcast: 0 } })
  const broadcasts: BroadcastOutput[] = []
  const messages: InboundMessage[] = []
  const users = new Set<string>()
  const channels = new Set<string>()
  const broadcastTargets = new Set<BroadcastTarget>()
  let pluginResult!: Result

  app.on('middleware', (session) => {
    messages.push({
      userId: session.userId ?? '',
      channelId: session.channelId ?? '',
      quote: session.quote && {
        messageId: session.quote.messageId ?? '',
        content: session.quote.content ?? '',
      },
    })
  })

  app.plugin(memory as any)
  app.reflect.provide('console', { addListener() {} })
  const captureFork = app.plugin((ctx) => new BroadcastCaptureBot(ctx, broadcasts))
  const mockFork = app.plugin(mock as any, { selfId: '514' })
  // The harness always provides a database. Declare that dependency on the
  // test fork so plugins can exercise ctx.model/ctx.broadcast without warnings.
  app.plugin({
    ...plugin,
    inject: (plugin as any).inject ?? ['database'],
    apply(ctx: Context, pluginConfig: Config) {
      pluginResult = plugin.apply(ctx, pluginConfig)
    },
  } as any, config)

  await app.start()

  return {
    app,
    pluginResult,
    broadcasts,
    messages,
    async registerBroadcastTargets(targets) {
      for (const target of targets) {
        if (broadcastTargets.has(target)) continue
        const separator = target.indexOf(':')
        const platform = target.slice(0, separator)
        const id = target.slice(separator + 1)
        await app.database.createChannel(platform, id, { assignee: '514' })
        broadcastTargets.add(target)
      }
    },
    async client({ userId, channelId, authority = 1 }) {
      if (users.has(userId)) {
        await app.database.setUser('mock', userId, { authority })
      } else {
        await app.mock.initUser(userId, authority)
        users.add(userId)
      }
      if (channelId && !channels.has(channelId)) {
        await app.mock.initChannel(channelId)
        channels.add(channelId)
      }
      return app.mock.client(userId, channelId)
    },
    async stop() {
      await captureFork.dispose()
      await mockFork.dispose()
      await app.stop()
    },
  }
}
