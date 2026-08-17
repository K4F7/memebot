import { Context, Schema } from 'koishi'

export const name = 'memebot-archive'
export const inject = [] as const

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

const UNAVAILABLE = 'Archive 服务暂时不可用，请稍后重试。'

export function apply(ctx: Context, _config?: Partial<Config>) {
  const root = ctx.command('archive [id:text]', '搜索或获取 Work 归档')
  root.action(async (_meta, id) => {
    if (!id) return '请使用 /archive search works [查询] 或 /archive W<n>。'
    if (!/^w[1-9]\d*$/i.test(id)) return '当前 Archive 仅支持 Work W<n>。'
    return UNAVAILABLE
  })

  root.subcommand('.search <kind:string> [query:text]', '搜索 Work').action(async (_meta, kind) => {
    if (kind.toLocaleLowerCase() !== 'works') return '当前 Archive 仅支持 Work 查询。'
    return UNAVAILABLE
  })

  root.subcommand('.works [query:text]', '查询 Work').action(async () => UNAVAILABLE)

  root.subcommand('.work-query [author:text] [query:text]', '按作者或文本查询 Work').action(async () => UNAVAILABLE)
}

export default { name, inject, Config, apply }
