import { Context, Schema, type Session } from 'koishi'
import type { AccessSession } from 'koishi-plugin-memebot-access'

export const name = 'memebot-faq'
export const inject = ['database', 'access']

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
  pageSize: number
}

export const Config: Schema<Config> = Schema.object({
  pageSize: Schema.number().default(10).min(1).max(50).description('每页公开 FAQ 数量'),
})

export interface FaqInput { question: string; answer: string; visible?: boolean }
export interface FaqPatch { question?: string; answer?: string; visible?: boolean }

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
  const lines = page.items.map(entry => '#' + entry.id + ' ' + entry.question)
  return 'FAQ（第 ' + page.currentPage + '/' + page.totalPages + ' 页）\n' + lines.join('\n') + '\n可使用 /faq #编号 查看答案。'
}

export function formatFaq(entry: Pick<FaqEntry, 'id' | 'question' | 'answer'>): string {
  return 'FAQ #' + entry.id + '\n问题：' + entry.question + '\n答案：' + entry.answer
}

export function parseFaqId(value: string | number): number {
  const match = /^#?(\d+)$/.exec(String(value).trim())
  if (!match || Number(match[1]) < 1) throw new Error('FAQ 编号必须写作 #自然数。')
  return Number(match[1])
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
    if (current.visible) throw new Error('请先隐藏 FAQ，再永久删除。')
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

function commandSession(session?: Session): AccessSession {
  return { userId: session?.userId, guildId: session?.guildId, channelId: session?.channelId, user: { authority: (session?.user as any)?.authority } }
}

export function apply(ctx: Context, config: Config) {
  if (!ctx.access) throw new Error('memebot-faq requires memebot-access')
  const settings: Config = { pageSize: 10, ...(config as Partial<Config>) }
  ctx.model.extend('faq', {
    id: 'unsigned', question: 'string', answer: 'text', visible: 'boolean', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, { autoInc: true })
  const service = new FaqService(ctx)
  ;(ctx as any).faq = service

  const publicList = async (page = 1) => formatFaqList(await service.listPublic(Number(page) || 1, settings.pageSize))
  const root = ctx.command('faq [query:text]', '分页查看 FAQ，或使用 #编号查看完整答案').action(async ({ session }, query) => {
    const value = String(query ?? '').trim()
    if (!value) return publicList(1)
    const detail = /^#(\d+)$/.exec(value)
    if (detail) {
      const entry = await service.get(Number(detail[1]))
      if (!entry) return 'FAQ 编号不存在。'
      if (!entry.visible) {
        const decision = await ctx.access.authorizeRead(commandSession(session))
        if (!decision.allowed) return 'FAQ 编号不存在。'
      }
      return formatFaq(entry)
    }
    if (/^\d+$/.test(value)) return publicList(Number(value))
    return '请输入页码或 #编号。'
  })

  const protectedCommand = (
    command: string,
    description: string,
    authorization: 'read' | 'write',
    handler: (meta: any, ...args: any[]) => Promise<string>,
  ) => ctx.command(command, description).action(async (meta, ...args) => {
    const decision = authorization === 'read'
      ? await ctx.access.authorizeRead(commandSession(meta.session))
      : await ctx.access.authorizeWrite(commandSession(meta.session))
    if (!decision.allowed) return decision.message
    try { return await handler(meta, ...args) } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  const prompt = async (session: Session, label: string) => {
    await session.send(label)
    const value = (await session.prompt(300000))?.trim()
    if (!value) throw new Error('操作已超时或输入为空。')
    return value
  }
  const confirm = async (session: Session, preview: string) => {
    await session.send(preview + '\n请发送“确认”继续，其他输入取消。')
    return (await session.prompt(300000))?.trim() === '确认'
  }
  protectedCommand('faq.add', '引导新增 FAQ', 'write', async ({ session }) => {
    const question = await prompt(session, '请输入问题。')
    const answer = await prompt(session, '请输入答案。')
    const preview = formatFaq({ id: 0, question, answer }).replace('#0', '预览')
    if (!await confirm(session, preview)) return '已取消新增。'
    return 'FAQ 新增成功。\n' + formatFaq(await service.create({ question, answer }))
  })
  protectedCommand('faq.edit <reference:string>', '引导编辑指定 #编号 FAQ', 'write', async ({ session }, reference) => {
    const id = parseFaqId(reference)
    const current = await service.get(id)
    if (!current) throw new Error('FAQ 不存在')
    const choice = await prompt(session, formatFaq(current) + '\n请选择要修改的内容：问题、答案或两者。')
    if (!['问题', '答案', '两者'].includes(choice)) throw new Error('请选择“问题”“答案”或“两者”。')
    const patch: FaqPatch = {}
    if (choice === '问题' || choice === '两者') patch.question = await prompt(session, '请输入新问题。')
    if (choice === '答案' || choice === '两者') patch.answer = await prompt(session, '请输入新答案。')
    const preview = { ...current, ...patch }
    if (!await confirm(session, formatFaq(preview))) return '已取消编辑。'
    return 'FAQ 编辑成功。\n' + formatFaq(await service.update(id, patch))
  })
  const visibility = (kind: 'hide' | 'show') => protectedCommand(`faq.${kind} <reference:string>`, kind === 'hide' ? '预览并隐藏 #编号 FAQ' : '预览并重新公开 #编号 FAQ', 'write', async ({ session }, reference) => {
    const id = parseFaqId(reference)
    const current = await service.get(id)
    if (!current) throw new Error('FAQ 不存在')
    if (!await confirm(session, formatFaq(current))) return '操作已取消。'
    const visible = kind === 'show'
    await service.setVisibility(id, visible)
    return visible ? `已公开 FAQ #${id}。` : `已隐藏 FAQ #${id}。`
  })
  visibility('hide'); visibility('show')
  protectedCommand('faq.rm <reference:string>', '预览并永久删除已隐藏的 #编号 FAQ', 'write', async ({ session }, reference) => {
    const id = parseFaqId(reference)
    const current = await service.get(id)
    if (!current) throw new Error('FAQ 不存在')
    if (current.visible) throw new Error('请先隐藏 FAQ，再永久删除。')
    if (!await confirm(session, formatFaq(current))) return '已取消永久删除。'
    await service.remove(id)
    return `已永久删除 FAQ #${id}。`
  })
  protectedCommand('faq.manage', '查看全部 FAQ 及公开状态', 'read', async () => {
    const entries = await service.listAll()
    return entries.length ? entries.map(entry => entry.id + '. [' + (entry.visible ? '公开' : '隐藏') + '] ' + entry.question).join('\n') : '暂无 FAQ。'
  })
}

export default { name, inject, Config, apply }
