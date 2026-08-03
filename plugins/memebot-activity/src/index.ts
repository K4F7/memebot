import { Context, Schema, type Session } from 'koishi'
import type { AccessSession } from 'koishi-plugin-memebot-access'

export const name = 'memebot-activity'
export const inject = ['database', 'access']

export type ActivityStatus = 'upcoming' | 'active' | 'ended' | 'cancelled'

export interface Activity {
  id: number
  title: string
  startAt: Date
  endAt: Date
  status: ActivityStatus
  location: string
  description: string
  link: string
  createdAt: Date
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    activity: Activity
  }
}

export interface Config {
  notificationUsers: Array<{ qq: string }>
  notificationGroups: Array<{ qq: string }>
}

const qqTable = () => Schema.array(Schema.object({ qq: Schema.string().description('QQ 号') }))

export const Config: Schema<Config> = Schema.object({
  notificationUsers: qqTable().default([]).description('活动通知接收 QQ 用户'),
  notificationGroups: qqTable().default([]).description('活动通知接收 QQ 群'),
})

export interface ActivityInput {
  title: string
  startAt: Date | string
  endAt: Date | string
  status?: ActivityStatus
  location?: string
  description?: string
  link?: string
}

export interface ActivityPatch {
  title?: string
  startAt?: Date | string
  endAt?: Date | string
  status?: ActivityStatus
  location?: string
  description?: string
  link?: string
}

export type ActivityNotificationState = 'not-requested' | 'not-configured' | 'delivered' | 'failed'

export interface ActivityNotificationResult {
  state: ActivityNotificationState
  targets: string[]
}

export interface ActivityMutationResult {
  activity: Activity
  notification: ActivityNotificationResult
}

export const activityStatuses: readonly ActivityStatus[] = ['upcoming', 'active', 'ended', 'cancelled']

function parseDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${field} 不是有效时间`)
  return date
}

export function validateActivity(input: ActivityInput): Omit<ActivityInput, 'startAt' | 'endAt'> & { startAt: Date; endAt: Date } {
  const title = input.title?.trim()
  if (!title) throw new Error('活动标题不能为空')
  const startAt = parseDate(input.startAt, '开始时间')
  const endAt = parseDate(input.endAt, '结束时间')
  if (startAt >= endAt) throw new Error('结束时间必须晚于开始时间')
  const status = input.status ?? 'upcoming'
  if (!activityStatuses.includes(status)) throw new Error(`活动状态无效：${status}`)
  const link = input.link?.trim() ?? ''
  if (link && !/^https?:\/\//i.test(link)) throw new Error('参考链接必须以 http:// 或 https:// 开头')
  return {
    title,
    startAt,
    endAt,
    status,
    location: input.location?.trim() ?? '',
    description: input.description?.trim() ?? '',
    link,
  }
}

export function effectiveStatus(activity: Pick<Activity, 'status' | 'startAt' | 'endAt'>, now = new Date()): ActivityStatus {
  if (activity.status === 'cancelled' || activity.status === 'ended') return activity.status
  const start = new Date(activity.startAt).getTime()
  const end = new Date(activity.endAt).getTime()
  const current = now.getTime()
  if (current < start) return 'upcoming'
  if (current < end) return 'active'
  return 'ended'
}

export function listVisibleActivities(activities: readonly Activity[], now = new Date()): Activity[] {
  return activities
    .map((activity) => ({ ...activity, status: effectiveStatus(activity, now) }))
    .filter((activity) => activity.status === 'upcoming' || activity.status === 'active')
    .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
}

export function buildBroadcastTargets(config: Pick<Config, 'notificationUsers' | 'notificationGroups'>): string[] {
  return [...config.notificationUsers, ...config.notificationGroups]
    .map((item) => item.qq.trim())
    .filter(Boolean)
    .map((id) => `qq:${id}`)
    .filter((target, index, targets) => targets.indexOf(target) === index)
}

export class ActivityService {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async create(input: ActivityInput, broadcast = false): Promise<ActivityMutationResult> {
    const data = validateActivity(input)
    const activity = await this.ctx.model.create('activity', {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as Activity
    return { activity, notification: await this.notify(activity, broadcast) }
  }

  async update(id: number, patch: ActivityPatch, broadcast = false): Promise<ActivityMutationResult> {
    const current = await this.get(id)
    if (!current) throw new Error('活动不存在')
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ActivityPatch
    const merged = validateActivity({ ...current, ...definedPatch })
    const updatedAt = new Date()
    await this.ctx.model.set('activity', { id }, { ...merged, updatedAt })
    const activity = { ...current, ...merged, updatedAt } as Activity
    return { activity, notification: await this.notify(activity, broadcast) }
  }

  async cancel(id: number, broadcast = false): Promise<ActivityMutationResult> {
    const current = await this.get(id)
    if (!current) throw new Error('活动不存在')
    const updatedAt = new Date()
    await this.ctx.model.set('activity', { id }, { status: 'cancelled', updatedAt })
    const activity = { ...current, status: 'cancelled' as const, updatedAt }
    return { activity, notification: await this.notify(activity, broadcast) }
  }

  async get(id: number): Promise<Activity | undefined> {
    const rows = await this.ctx.model.get('activity', { id }) as unknown as Activity[]
    return rows[0]
  }

  async list(now = new Date()): Promise<Activity[]> {
    const rows = await this.ctx.model.get('activity', {}) as unknown as Activity[]
    return listVisibleActivities(rows, now)
  }
  async history(now = new Date()): Promise<Activity[]> {
    const rows = await this.ctx.model.get('activity', {}) as unknown as Activity[]
    return rows.map(activity => ({ ...activity, status: effectiveStatus(activity, now) }))
      .filter(activity => activity.status === 'ended' || activity.status === 'cancelled')
      .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
  }

  private async notify(activity: Activity, requested: boolean): Promise<ActivityNotificationResult> {
    const targets = buildBroadcastTargets(this.config)
    if (!requested) return { state: 'not-requested', targets }
    if (!targets.length) return { state: 'not-configured', targets }
    try {
      const messages = await this.ctx.broadcast(targets, formatActivity(activity))
      return { state: Array.isArray(messages) && messages.length ? 'delivered' : 'failed', targets }
    } catch {
      return { state: 'failed', targets }
    }
  }
}

export function formatActivity(activity: Pick<Activity, 'id' | 'title' | 'startAt' | 'endAt' | 'status' | 'location' | 'description' | 'link'>): string {
  const lines = [
    `活动 #${activity.id}：${activity.title}`,
    `时间：${new Date(activity.startAt).toLocaleString()} - ${new Date(activity.endAt).toLocaleString()}`,
    `状态：${activity.status}`,
  ]
  if (activity.location) lines.push(`地点：${activity.location}`)
  if (activity.description) lines.push(activity.description)
  if (activity.link) lines.push(`链接：${activity.link}`)
  return lines.join('\n')
}

function formatMutationReply(action: string, result: ActivityMutationResult) {
  const outcome: Record<ActivityNotificationState, string> = {
    'not-requested': '已仅保存，未请求通知。',
    'not-configured': '记录已保存，但未配置通知目标。',
    delivered: '记录已保存，通知已送达。',
    failed: '记录已保存，但通知发送失败。',
  }
  return `${action}；${outcome[result.notification.state]}\n${formatActivity(result.activity)}`
}

function parseStatus(value: string | undefined): ActivityStatus | undefined {
  if (value === undefined) return undefined
  if (!activityStatuses.includes(value as ActivityStatus)) throw new Error(`活动状态无效：${value}`)
  return value as ActivityStatus
}

export function apply(ctx: Context, config: Config) {
  if (!ctx.access) throw new Error('memebot-activity requires memebot-access')
  const normalizedConfig: Config = {
    notificationUsers: config.notificationUsers || [],
    notificationGroups: config.notificationGroups || [],
  }
  ctx.model.extend('activity', {
    id: 'unsigned',
    title: 'string',
    startAt: 'timestamp',
    endAt: 'timestamp',
    status: 'string',
    location: 'string',
    description: 'text',
    link: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, { autoInc: true })

  const service = new ActivityService(ctx, normalizedConfig)
  const list = async () => {
    const activities = await service.list()
    return activities.length ? activities.map(formatActivity).join('\n\n') : '暂无即将开始或进行中的活动。'
  }
  ctx.command('activity [query:text]', '查看近期活动，或使用 #编号查看详情').action(async (_meta, query) => {
    const value = String(query ?? '').trim()
    if (!value) return list()
    const match = /^#(\d+)$/.exec(value)
    if (!match) return '请输入 #活动编号，管理员可使用 /activity history。'
    const activity = await service.get(Number(match[1]))
    return activity ? formatActivity({ ...activity, status: effectiveStatus(activity) }) : '活动不存在。'
  })

  const accessSession = (session?: Session): AccessSession => ({
    userId: session?.userId,
    guildId: session?.guildId,
    channelId: session?.channelId,
    user: { authority: (session?.user as any)?.authority },
  })
  const protectedCommand = (
    command: string,
    description: string,
    authorization: 'read' | 'write',
    handler: (meta: any, ...args: any[]) => Promise<string>,
  ) => ctx.command(command, description).action(async (meta, ...args) => {
    const decision = authorization === 'read'
      ? await ctx.access.authorizeRead(accessSession(meta.session))
      : await ctx.access.authorizeWrite(accessSession(meta.session))
    if (!decision.allowed) return decision.message
    try { return await handler(meta, ...args) } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  const prompt = async (session: any, label: string, optional = false) => {
    await session.send(label + (optional ? '（发送 - 跳过）' : ''))
    const value = (await session.prompt(300000))?.trim()
    if (!value) throw new Error('操作已超时或输入为空。')
    return optional && value === '-' ? '' : value
  }
  const choice = async (session: any, preview: Activity) => {
    await session.send(formatActivity(preview) + '\n请选择“仅保存”或“保存并通知”；其他输入取消。')
    const value = (await session.prompt(300000))?.trim()
    if (value === '仅保存') return false
    if (value === '保存并通知') return true
    throw new Error('操作已取消。')
  }

  protectedCommand('activity.history', '查看已结束或已取消的活动', 'read', async () => {
    const activities = await service.history()
    return activities.length ? activities.map(formatActivity).join('\n\n') : '暂无历史活动。'
  })
  protectedCommand('activity.add', '引导新增活动并选择是否通知', 'write', async ({ session }) => {
    const input: ActivityInput = {
      title: await prompt(session, '请输入活动标题。'),
      startAt: await prompt(session, '请输入开始时间。'),
      endAt: await prompt(session, '请输入结束时间。'),
      location: await prompt(session, '请输入地点。', true),
      link: await prompt(session, '请输入参考链接。', true),
      description: await prompt(session, '请输入活动描述。', true),
    }
    const preview = { ...validateActivity(input), id: 0, createdAt: new Date(), updatedAt: new Date() } as Activity
    const broadcast = await choice(session, preview)
    return formatMutationReply('活动创建成功', await service.create(input, broadcast))
  })
  protectedCommand('activity.edit <id:posint>', '引导选择并编辑活动字段', 'write', async ({ session }, id) => {
    const current = await service.get(Number(id))
    if (!current) throw new Error('活动不存在')
    const fields = (await prompt(session, formatActivity(current) + '\n请输入要修改的字段，用逗号分隔：标题、开始、结束、地点、链接、描述。')).split(/[,，]/).map((item: string) => item.trim())
    const patch: ActivityPatch = {}
    for (const field of fields) {
      if (field === '标题') patch.title = await prompt(session, '请输入新标题。')
      else if (field === '开始') patch.startAt = await prompt(session, '请输入新开始时间。')
      else if (field === '结束') patch.endAt = await prompt(session, '请输入新结束时间。')
      else if (field === '地点') patch.location = await prompt(session, '请输入新地点。', true)
      else if (field === '链接') patch.link = await prompt(session, '请输入新链接。', true)
      else if (field === '描述') patch.description = await prompt(session, '请输入新描述。', true)
      else throw new Error(`未知字段：${field}`)
    }
    const merged = { ...current, ...validateActivity({ ...current, ...patch }) } as Activity
    const broadcast = await choice(session, merged)
    return formatMutationReply('活动更新成功', await service.update(Number(id), patch, broadcast))
  })
  protectedCommand('activity.cancel <id:posint>', '预览并取消活动，选择是否通知', 'write', async ({ session }, id) => {
    const current = await service.get(Number(id))
    if (!current) throw new Error('活动不存在')
    const preview = { ...current, status: 'cancelled' as const }
    const broadcast = await choice(session, preview)
    return formatMutationReply('活动已取消', await service.cancel(Number(id), broadcast))
  })
  ;(ctx as any).activity = service
  return service
}

export default { name, inject, Config, apply }
