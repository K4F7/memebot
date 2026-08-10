import { Context, Schema } from 'koishi'
import { PayloadArchiveReadAdapter, PayloadArchiveReadError, sendPayloadWork, type PayloadArchiveReadConfig } from './payload-read'

export { PayloadArchiveReadAdapter, PayloadArchiveReadError, sendPayloadWork } from './payload-read'
export type { ArchiveMediaDescriptor, ArchiveWorkDetail, ArchiveWorkSummary, PayloadArchiveReadConfig } from './payload-read'

export const name = 'memebot-archive'
export const inject = [] as const

export interface Config {
  payload: PayloadArchiveReadConfig
}

export const Config: Schema<Config> = Schema.object({
  payload: Schema.object({
    baseUrl: Schema.string().default('').description('Payload Archive 基础 URL'),
    serviceToken: Schema.string().role('secret').default('').description('Payload Archive machine credential'),
    timeoutMs: Schema.number().default(10_000).min(100).max(120_000),
  }).default({ baseUrl: '', serviceToken: '', timeoutMs: 10_000 }),
})

function payloadReadMessage(error: unknown): string {
  if (error instanceof PayloadArchiveReadError) {
    if (error.kind === 'unauthorized') return 'Archive 机器凭证无效。'
    if (error.kind === 'media') return error.message
  }
  return 'Archive 服务暂时不可用，请稍后重试。'
}

function normalizeConfig(config: Partial<Config> | undefined): PayloadArchiveReadConfig {
  const value = (config as { payload?: Partial<PayloadArchiveReadConfig> } | undefined)?.payload ?? {}
  return {
    baseUrl: value.baseUrl ?? '',
    serviceToken: value.serviceToken ?? '',
    timeoutMs: value.timeoutMs ?? 10_000,
  }
}

function formatWorks(items: Array<{ id: string; author: string; title: string }>): string {
  return items.length ? items.map(item => `${item.id} ${item.author} - ${item.title}`).join('\n') : '没有找到 Work。'
}

async function searchWorks(
  getReader: () => PayloadArchiveReadAdapter,
  kind: string,
  query?: string,
  author?: string,
): Promise<string> {
  if (kind.toLocaleLowerCase() !== 'works') return '当前 Payload Archive 仅支持 Work 查询。'
  try {
    return formatWorks(await getReader().searchWorks({ text: query, author }))
  } catch (error) {
    return payloadReadMessage(error)
  }
}

export function apply(ctx: Context, config?: Partial<Config>) {
  let reader: PayloadArchiveReadAdapter | undefined
  let setupError: unknown
  try {
    reader = new PayloadArchiveReadAdapter(normalizeConfig(config))
  } catch (error) {
    setupError = error
  }
  const getReader = () => {
    if (!reader) throw setupError ?? new PayloadArchiveReadError('unavailable', 'Payload Archive 未配置。')
    return reader
  }

  const root = ctx.command('archive [id:text]', '搜索或获取 Work 归档')
  root.action(async ({ session }, id) => {
    if (!id) return '请使用 /archive search works [查询] 或 /archive W<n>。'
    if (!/^w[1-9]\d*$/i.test(id)) return '当前 Payload Archive 仅支持 Work W<n>。'
    try {
      if (!session) {
        const work = await getReader().getWork(id)
        return work ? `${work.id} ${work.author} - ${work.title}` : 'Work 不存在。'
      }
      return await sendPayloadWork(session, getReader(), id)
    } catch (error) {
      return payloadReadMessage(error)
    }
  })

  root.subcommand('.search <kind:string> [query:text]', '搜索 Work').action(async (_meta, kind, query) => {
    return searchWorks(getReader, kind, query)
  })

  root.subcommand('.works [query:text]', '查询 Work').action(async (_meta, query) => {
    return searchWorks(getReader, 'works', query)
  })

  root.subcommand('.work-query [author:text] [query:text]', '按作者或文本查询 Work').action(async (_meta, author, query) => {
    return searchWorks(getReader, 'works', query, author)
  })

  return reader
}

export default { name, inject, Config, apply }
