import { Context, Schema, Session } from 'koishi'

export const name = 'memebot-access'
export const inject = ['database']

const INITIALIZATION_ID = 'global'

export interface AccessAdministrator {
  qq: string
}

export interface AccessManagementGroup {
  qq: string
}

export interface AccessInitialization {
  id: string
}

declare module 'koishi' {
  interface Tables {
    memebotAccessAdministrator: AccessAdministrator
    memebotAccessManagementGroup: AccessManagementGroup
    memebotAccessInitialization: AccessInitialization
  }

  interface Context {
    access: AccessService
  }
}

export interface Config {
  administrators: Array<{ qq: string }>
  managementGroups: Array<{ qq: string }>
}

export interface AccessSession extends Pick<Session, 'userId' | 'guildId' | 'channelId'> {
  user?: { authority?: number }
}

export type AccessDenialReason = 'identity' | 'location'

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: AccessDenialReason; message: string }

export const accessDenialMessages: Record<AccessDenialReason, string> = {
  identity: '你不是管理员。',
  location: '此群不是管理群，请私聊操作或先添加该群。',
}

const qqSeeds = () => Schema.array(Schema.object({
  qq: Schema.string().description('QQ 号'),
}))

export const Config: Schema<Config> = Schema.object({
  administrators: qqSeeds().default([]).description('首次初始化导入的显式管理员 QQ'),
  managementGroups: qqSeeds().default([]).description('首次初始化导入的管理群 QQ'),
})

function normalizeQq(value: string) {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) throw new Error('QQ 号必须是纯数字。')
  return normalized
}

function normalizeSeeds(records: Array<{ qq: string }>) {
  return [...new Set(records.map(record => normalizeQq(record.qq)))]
}

export function defineAccessModels(ctx: Context) {
  ctx.model.extend('memebotAccessAdministrator', { qq: 'string' }, { primary: 'qq' })
  ctx.model.extend('memebotAccessManagementGroup', { qq: 'string' }, { primary: 'qq' })
  ctx.model.extend('memebotAccessInitialization', { id: 'string' }, { primary: 'id' })
}

export class AccessService {
  constructor(private readonly ctx: Context) {}

  async initialize(config: Config) {
    const administrators = normalizeSeeds(config.administrators)
    const managementGroups = normalizeSeeds(config.managementGroups)

    await this.ctx.database.withTransaction(async database => {
      const initialized = await database.get('memebotAccessInitialization', { id: INITIALIZATION_ID })
      if (initialized.length) return

      for (const qq of administrators) {
        await database.create('memebotAccessAdministrator', { qq })
      }
      for (const qq of managementGroups) {
        await database.create('memebotAccessManagementGroup', { qq })
      }
      await database.create('memebotAccessInitialization', { id: INITIALIZATION_ID })
    })
  }

  async listExplicitAdministrators() {
    const records = await this.ctx.database.get('memebotAccessAdministrator', {})
    return records.map(record => record.qq).sort()
  }

  async listManagementGroups() {
    const records = await this.ctx.database.get('memebotAccessManagementGroup', {})
    return records.map(record => record.qq).sort()
  }

  async isAdministrator(session: AccessSession) {
    if ((session.user?.authority ?? 0) >= 4) return true
    if (!session.userId) return false
    const records = await this.ctx.database.get('memebotAccessAdministrator', { qq: session.userId })
    return records.length > 0
  }

  async authorizeRead(session: AccessSession): Promise<AccessDecision> {
    if (await this.isAdministrator(session)) return { allowed: true }
    return { allowed: false, reason: 'identity', message: accessDenialMessages.identity }
  }

  async authorizeWrite(session: AccessSession): Promise<AccessDecision> {
    const identity = await this.authorizeRead(session)
    if (!identity.allowed) return identity
    if (!session.guildId) return { allowed: true }

    const groups = await this.ctx.database.get('memebotAccessManagementGroup', { qq: session.guildId })
    if (groups.length) return { allowed: true }
    return { allowed: false, reason: 'location', message: accessDenialMessages.location }
  }

  async isExplicitAdministratorTarget(qq: string) {
    const records = await this.ctx.database.get('memebotAccessAdministrator', { qq: normalizeQq(qq) })
    return records.length > 0
  }

  async addExplicitAdministrator(qq: string) {
    const normalized = normalizeQq(qq)
    if (await this.isExplicitAdministratorTarget(normalized)) return false
    await this.ctx.database.create('memebotAccessAdministrator', { qq: normalized })
    return true
  }

  async addManagementGroup(qq: string) {
    const normalized = normalizeQq(qq)
    const records = await this.ctx.database.get('memebotAccessManagementGroup', { qq: normalized })
    if (records.length) return false
    await this.ctx.database.create('memebotAccessManagementGroup', { qq: normalized })
    return true
  }

  async removeExplicitAdministrator(qq: string) {
    const normalized = normalizeQq(qq)
    if (!await this.isExplicitAdministratorTarget(normalized)) return false
    await this.ctx.database.remove('memebotAccessAdministrator', { qq: normalized })
    return true
  }

  async removeManagementGroup(qq: string) {
    const normalized = normalizeQq(qq)
    const records = await this.ctx.database.get('memebotAccessManagementGroup', { qq: normalized })
    if (!records.length) return false
    await this.ctx.database.remove('memebotAccessManagementGroup', { qq: normalized })
    return true
  }
}

function commandSession(session: Session): AccessSession {
  return {
    userId: session.userId,
    guildId: session.guildId,
    channelId: session.channelId,
    user: { authority: (session.user as any)?.authority },
  }
}

function formatAccessList(administrators: string[], managementGroups: string[]) {
  return [
    `显式管理员：${administrators.length ? administrators.join('、') : '（空）'}`,
    `管理群：${managementGroups.length ? managementGroups.join('、') : '（空）'}`,
  ].join('\n')
}

function registerAccessCommands(ctx: Context, service: AccessService) {
  ctx.command('access.list', '查看 Access 显式管理员和管理群').action(async ({ session }) => {
    if (!session) return accessDenialMessages.identity
    const decision = await service.authorizeRead(commandSession(session))
    if (!decision.allowed) return decision.message
    return formatAccessList(
      await service.listExplicitAdministrators(),
      await service.listManagementGroups(),
    )
  })

  const registerProtectedWriteCommand = (
    command: string,
    description: string,
    handler: (qq: string, session: Session) => Promise<string>,
  ) => ctx.command(command, description).action(async ({ session }, qq) => {
    if (!session) return accessDenialMessages.identity
    const decision = await service.authorizeWrite(commandSession(session))
    if (!decision.allowed) return decision.message
    try {
      return await handler(String(qq ?? ''), session)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })

  registerProtectedWriteCommand('access.admin.add <qq:string>', '添加显式管理员', async (qq) => {
    const added = await service.addExplicitAdministrator(qq)
    const normalized = normalizeQq(qq)
    return added ? `显式管理员 ${normalized} 已添加。` : `显式管理员 ${normalized} 已存在，无需重复添加。`
  })
  registerProtectedWriteCommand('access.group.add <qq:string>', '添加管理群', async (qq) => {
    const added = await service.addManagementGroup(qq)
    const normalized = normalizeQq(qq)
    return added ? `管理群 ${normalized} 已添加。` : `管理群 ${normalized} 已存在，无需重复添加。`
  })
  registerProtectedWriteCommand('access.admin.rm <qq:string>', '移除显式管理员', async (qq, session) => {
    const normalized = normalizeQq(qq)
    if (normalized === session.userId) throw new Error('不能通过 QQ 命令移除当前操作账号。')
    const removed = await service.removeExplicitAdministrator(normalized)
    return removed ? `显式管理员 ${normalized} 已移除。` : `显式管理员 ${normalized} 不存在，无需移除。`
  })
  registerProtectedWriteCommand('access.group.rm <qq:string>', '移除管理群', async (qq) => {
    const removed = await service.removeManagementGroup(qq)
    const normalized = normalizeQq(qq)
    return removed ? `管理群 ${normalized} 已移除。` : `管理群 ${normalized} 不存在，无需移除。`
  })
}

export function apply(ctx: Context, config: Config) {
  const settings: Config = {
    administrators: [],
    managementGroups: [],
    ...(config as Partial<Config>),
  }
  defineAccessModels(ctx)
  const service = new AccessService(ctx)
  ctx.provide('access', service)
  registerAccessCommands(ctx, service)
  ctx.on('ready', () => service.initialize(settings))
}

export default { name, inject, Config, apply }
