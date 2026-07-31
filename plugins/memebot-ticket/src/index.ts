import { Context, Schema } from 'koishi'

export const name = 'memebot-ticket'
export interface Config {}
export const Config: Schema<Config> = Schema.object({})
export function apply(_ctx: Context, _config: Config) {}
