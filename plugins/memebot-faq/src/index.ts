import { Context, Schema, Session } from 'koishi'

export const name = 'memebot-faq'

export interface FaqEntry {
  id: number
  question: string
  answer: string
  visible: boolean
  createdAt: Date
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables { faq: FaqEntry }
}

export interface Config {
  adminUserIds: string[]
  adminGroupIds: string[]
  minAuthority: number
  pageSize: number
}

export const Config: Schema<Config> = Schema.object({
  adminUserIds: Schema.array(String).default([]).description('管理员用户 ID 白名单'),
  adminGroupIds: Schema.array(String).default([]).description('管理员群组 ID 白名单'),
  minAuthority: Schema.number().default(4).description('最低 Koishi authority'),
  pageSize: Schema.number().default(10).min(1).max(50).description('每页公开 FAQ 数量'),
})

export interface FaqInput { question: string; answer: string; visible?: boolean }
export interface FaqPatch { question?: string; answer?: string; visible?: boolean }
export interface FaqSession extends Pick<Session, 'userId' | 'guildId' | 'channelId'> { user?: { authority?: number } }

export function isAdministrator(session: FaqSession, config: Pick<Config, 'adminUserIds' | 'adminGroupIds' | 'minAuthority'>): boolean {
  if ((session.user?.authority ?? 0) < config.minAuthority) return false
  const groupId = session.guildId ?? session.channelId
  return (!!session.userId && config.adminUserIds.includes(session.userId))
    || (!!groupId && config.adminGroupIds.includes(groupId))
}

function requiredText(value: string | undefined, label: string) {
  const text = value?.trim() ?? ''
  if (!text) throw new Error(label + '不能为空')
  return text
}

export function validateFaq(input: FaqInput): Omit<FaqInput, 'visible'> & { visible: boolean } {
  return { question: requiredText(input.question, '问题'), answer: requiredText(input.answer, '答案'), visible: input.visible ?? true }
}

export function paginate<T>(items: readonly T[], page: number, pageSize = 10) {
  const size = Math.max(1, Math.floor(pageSize))
  const totalPages = Math.max(1, Math.ceil(items.length / size))
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const start = (currentPage - 1) * size
  return { items: items.slice(start, start + size), currentPage, totalPages, total: items.length, pageSize: size }
}

export function selectNumber<T>(items: readonly T[], number: number): T | undefined {
  return Number.isInteger(number) && number >= 1 ? items[number - 1] : undefined
}

export function formatFaqList(page: ReturnType<typeof paginate<FaqEntry>>): string {
  if (!page.total) return '暂无公开 FAQ。'
  const lines = page.items.map((entry, index) => ((page.currentPage - 1) * page.pageSize + index + 1) + '. ' + entry.question)
  return 'FAQ（第 ' + page.currentPage + '/' + page.totalPages + ' 页）\n' + lines.join('\n') + '\n可使用 faq.get <编号> 查看答案。'
}

export function formatFaq(entry: Pick<FaqEntry, 'id' | 'question' | 'answer'>): string {
  return 'FAQ #' + entry.id + '\n问题：' + entry.question + '\n答案：' + entry.answer
}

export class FaqService {
  constructor(private readonly ctx: Context) {}

  async create(input: FaqInput): Promise<FaqEntry> {
    const data = validateFaq(input)
    return await this.ctx.model.create('faq', { ...data, createdAt: new Date(), updatedAt: new Date() }) as unknown as FaqEntry
  }
  async update(id: number, patch: FaqPatch): Promise<FaqEntry> {
    const current = await this.get(id)
    if (!current) throw new Error('FAQ 不存在')
    const data = validateFaq({ question: patch.question ?? current.question, answer: patch.answer ?? current.answer, visible: patch.visible ?? current.visible })
    const updatedAt = new Date()
    await this.ctx.model.set('faq', { id }, { ...data, updatedAt })
    return { ...current, ...data, updatedAt }
  }
  async setVisibility(id: number, visible: boolean) { return this.update(id, { visible }) }
  async remove(id: number) {
    const current = await this.get(id)
    if (!current) throw new Error('FAQ 不存在')
    await this.ctx.model.remove('faq', { id })
    return current
  }
  async get(id: number): Promise<FaqEntry | undefined> {
    const rows = await this.ctx.model.get('faq', { id }) as unknown as FaqEntry[]
    return rows[0]
  }
  async listAll(): Promise<FaqEntry[]> {
    const rows = await this.ctx.model.get('faq', {}) as unknown as FaqEntry[]
    return rows.sort((a, b) => a.id - b.id)
  }
  async listPublic(page: number, pageSize: number) {
    return paginate((await this.listAll()).filter(entry => entry.visible), page, pageSize)
  }
}

function commandSession(session: Session): FaqSession {
  return { userId: session.userId, guildId: session.guildId, channelId: session.channelId, user: { authority: (session.user as any)?.authority } }
}

export function apply(ctx: Context, config: Config) {
  const settings: Config = { adminUserIds: [], adminGroupIds: [], minAuthority: 4, pageSize: 10, ...(config as Partial<Config>) }
  ctx.model.extend('faq', {
    id: 'unsigned', question: 'string', answer: 'text', visible: 'boolean', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { autoInc: true })
  const service = new FaqService(ctx)
  ;(ctx as any).faq = service

  const publicList = async (page = 1) => formatFaqList(await service.listPublic(Number(page) || 1, settings.pageSize))
  const root = ctx.command('faq [page:posint]', '查看 FAQ').action(async (_meta, page) => publicList(page))
  root.subcommand('.list [page:posint]', '分页查看公开 FAQ').action(async (_meta, page) => publicList(page))
  root.subcommand('.get <number:posint>', '查看指定 FAQ 的答案').action(async (_meta, number) => {
    const page = await service.listPublic(1, Number.MAX_SAFE_INTEGER)
    const entry = selectNumber(page.items, Number(number))
    return entry ? formatFaq(entry) : 'FAQ 编号不存在。'
  })

  const denied = '只有管理员白名单中的四级及以上用户可以管理 FAQ。'
  const admin = (command: string, handler: (meta: any, ...args: any[]) => Promise<string>) => ctx.command(command).action(async (meta, ...args) => {
    if (!meta.session || !isAdministrator(commandSession(meta.session), settings)) return denied
    try { return await handler(meta, ...args) } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  admin('faq.admin.add <question:text> <answer:text>', async (_meta, question, answer) => formatFaq(await service.create({ question, answer })))
  const edit = ctx.command('faq.admin.edit <id:posint>', '编辑 FAQ').option('question', '-q <question:text>').option('answer', '-a <answer:text>')
  edit.action(async (meta, id) => {
    if (!meta.session || !isAdministrator(commandSession(meta.session), settings)) return denied
    const options = meta.options ?? {}
    try { return formatFaq(await service.update(Number(id), { question: options.question, answer: options.answer })) } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  admin('faq.admin.hide <id:posint>', async (_meta, id) => '已隐藏 FAQ #' + id + '。\n' + formatFaq(await service.setVisibility(Number(id), false)))
  admin('faq.admin.show <id:posint>', async (_meta, id) => '已公开 FAQ #' + id + '。\n' + formatFaq(await service.setVisibility(Number(id), true)))
  admin('faq.admin.delete <id:posint>', async (_meta, id) => { await service.remove(Number(id)); return '已删除 FAQ #' + id + '。' })
  admin('faq.admin.list', async () => {
    const entries = await service.listAll()
    return entries.length ? entries.map(entry => entry.id + '. [' + (entry.visible ? '公开' : '隐藏') + '] ' + entry.question).join('\n') : '暂无 FAQ。'
  })
}

export default { name, Config, apply }
