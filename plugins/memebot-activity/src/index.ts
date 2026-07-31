import { Context, Schema } from 'koishi'

export const name = 'memebot-activity'

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
  adminUserIds: string[]
  adminGroupIds: string[]
  broadcastUserIds: string[]
  broadcastGroupIds: string[]
  broadcastPlatform: string
}

export const Config: Schema<Config> = Schema.object({
  adminUserIds: Schema.array(String).default([]).description('允许管理活动的 QQ 用户号'),
  adminGroupIds: Schema.array(String).default([]).description('允许管理活动的 QQ 群号'),
  broadcastUserIds: Schema.array(String).default([]).description('活动广播接收用户号'),
  broadcastGroupIds: Schema.array(String).default([]).description('活动广播接收群号'),
  broadcastPlatform: Schema.string().default('qq').description('广播目标平台标识'),
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

export function buildBroadcastTargets(config: Pick<Config, 'broadcastUserIds' | 'broadcastGroupIds' | 'broadcastPlatform'>): string[] {
  const platform = config.broadcastPlatform.trim() || 'qq'
  return [...config.broadcastUserIds, ...config.broadcastGroupIds]
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => `${platform}:${id}`)
    .filter((target, index, targets) => targets.indexOf(target) === index)
}

export function isAdministrator(session: { userId?: string; guildId?: string; channelId?: string; user?: any }, config: Pick<Config, 'adminUserIds' | 'adminGroupIds'>): boolean {
  if ((session.user?.authority ?? 0) < 4) return false
  const userId = session.userId ?? ''
  const groupId = session.guildId ?? ''
  return config.adminUserIds.includes(userId) || config.adminGroupIds.includes(groupId)
}

export class ActivityService {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async create(input: ActivityInput, broadcast = false): Promise<Activity> {
    const data = validateActivity(input)
    const activity = await this.ctx.model.create('activity', {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as Activity
    if (broadcast) await this.broadcast(activity)
    return activity
  }

  async update(id: number, patch: ActivityPatch, broadcast = false): Promise<Activity> {
    const current = await this.get(id)
    if (!current) throw new Error('活动不存在')
    const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ActivityPatch
    const merged = validateActivity({ ...current, ...definedPatch })
    const updatedAt = new Date()
    await this.ctx.model.set('activity', { id }, { ...merged, updatedAt })
    const activity = { ...current, ...merged, updatedAt } as Activity
    if (broadcast) await this.broadcast(activity)
    return activity
  }

  async cancel(id: number): Promise<Activity> {
    const current = await this.get(id)
    if (!current) throw new Error('活动不存在')
    await this.ctx.model.set('activity', { id }, { status: 'cancelled', updatedAt: new Date() })
    return { ...current, status: 'cancelled', updatedAt: new Date() }
  }

  async get(id: number): Promise<Activity | undefined> {
    const rows = await this.ctx.model.get('activity', { id }) as unknown as Activity[]
    return rows[0]
  }

  async list(now = new Date()): Promise<Activity[]> {
    const rows = await this.ctx.model.get('activity', {}) as unknown as Activity[]
    return listVisibleActivities(rows, now)
  }

  private async broadcast(activity: Activity): Promise<void> {
    const targets = buildBroadcastTargets(this.config)
    if (!targets.length) return
    await this.ctx.broadcast(targets, formatActivity(activity))
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

function parseStatus(value: string | undefined): ActivityStatus | undefined {
  if (value === undefined) return undefined
  if (!activityStatuses.includes(value as ActivityStatus)) throw new Error(`活动状态无效：${value}`)
  return value as ActivityStatus
}

export function apply(ctx: Context, config: Config) {
  const normalizedConfig: Config = {
    adminUserIds: config.adminUserIds || [],
    adminGroupIds: config.adminGroupIds || [],
    broadcastUserIds: config.broadcastUserIds || [],
    broadcastGroupIds: config.broadcastGroupIds || [],
    broadcastPlatform: config.broadcastPlatform || 'qq',
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
  ctx.command('activity.list', '查看即将开始和进行中的活动').action(async () => {
    const activities = await service.list()
    return activities.length ? activities.map(formatActivity).join('\n\n') : '暂无即将开始或进行中的活动。'
  })

  const create = ctx.command('activity.create <title:text> <start:string> <end:string> <description:text>', '创建活动')
    .option('status', '-s <status:string> 活动状态')
    .option('location', '-l <location:string> 活动地点')
    .option('link', '-u <link:string> 参考链接')
    .option('broadcast', '-b 广播给已配置目标')
  create.action(async ({ session, options = {} as Record<string, any> }, title, start, end, description) => {
    if (!session || !isAdministrator(session, normalizedConfig)) return '只有在管理员白名单中的四级及以上用户可以管理活动。'
    try {
      const activity = await service.create({ title, startAt: start, endAt: end, description, status: parseStatus(options.status), location: options.location, link: options.link }, Boolean(options.broadcast))
      return `活动创建成功：\n${formatActivity(activity)}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })

  const update = ctx.command('activity.update <id:posint>', '更新活动')
    .option('title', '-t <title:string> 新标题')
    .option('start', '-s <start:string> 开始时间')
    .option('end', '-e <end:string> 结束时间')
    .option('status', '-S <status:string> 活动状态')
    .option('location', '-l <location:string> 活动地点')
    .option('description', '-d <description:text> 活动描述')
    .option('link', '-u <link:string> 参考链接')
    .option('broadcast', '-b 广播给已配置目标')
  update.action(async ({ session, options = {} as Record<string, any> }, id) => {
    if (!session || !isAdministrator(session, normalizedConfig)) return '只有在管理员白名单中的四级及以上用户可以管理活动。'
    try {
      const activity = await service.update(id, { title: options.title, startAt: options.start, endAt: options.end, status: parseStatus(options.status), location: options.location, description: options.description, link: options.link }, Boolean(options.broadcast))
      return `活动更新成功：\n${formatActivity(activity)}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })

  const cancel = ctx.command('activity.cancel <id:posint>', '取消活动')
  cancel.action(async ({ session }, id) => {
    if (!session || !isAdministrator(session, normalizedConfig)) return '只有在管理员白名单中的四级及以上用户可以管理活动。'
    try {
      const activity = await service.cancel(id)
      return `活动已取消：${activity.title}`
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
}

export default { name, Config, apply }
