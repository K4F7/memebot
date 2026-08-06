<script setup lang="ts">
import { message, messageBox, send } from '@koishijs/client'
import { computed, nextTick, onMounted, ref } from 'vue'

import LifecycleActionDialog from '../lifecycle/LifecycleActionDialog.vue'
import type {
  CleanupJob,
  CleanupStatus,
  LifecycleAction,
  LifecycleAuditEntry,
  LifecycleTarget,
  RemovedArchiveItem,
  RetiredAttachment,
} from '../lifecycle/types'
import { defaultRecoveryDecisions, healthPresentation, presentConsoleError, recoveryKey, toRestoreSelections, unresolvedConflicts } from '../storage/state'
import type {
  ArchiveStatus,
  BackupJob,
  BackupStatus,
  RestoreAuditEntry,
  RestoreDecisions,
  RestorePreview,
  RestorePreviewEntry,
  RestoreResult,
} from '../storage/types'

const status = ref<ArchiveStatus>()
const backup = ref<BackupStatus>({ counts: { pending: 0, failed: 0, complete: 0 }, jobs: [] })
const preview = ref<RestorePreview>()
const decisions = ref<RestoreDecisions>({})
const restoreHistory = ref<RestoreAuditEntry[]>([])
const dashboardLoading = ref(false)
const dashboardError = ref('')
const healthChecking = ref(false)
const retryingRecord = ref('')
const recoveryLoading = ref(false)
const applying = ref(false)
const recoveryError = ref('')
let dashboardRequest = 0
let recoveryRequest = 0

const removed = ref<RemovedArchiveItem[]>([])
const retired = ref<RetiredAttachment[]>([])
const lifecycleHistory = ref<LifecycleAuditEntry[]>([])
const cleanup = ref<CleanupStatus>({ counts: { pending: 0, failed: 0, complete: 0 }, jobs: [] })
const lifecycleLoading = ref(false)
const lifecycleError = ref('')
const removeIdentifier = ref('')
const dialogVisible = ref(false)
const dialogAction = ref<LifecycleAction>()
const dialogTarget = ref<LifecycleTarget>()
const focusAnchor = ref<HTMLElement>()
let lifecycleRequest = 0
let returnFocus: HTMLElement | null = null

const activeBackupJobs = computed(() => backup.value.jobs.filter(job => job.state !== 'complete'))
const activeCleanupJobs = computed(() => cleanup.value.jobs.filter(job => job.state !== 'complete'))
const conflictKeys = computed(() => preview.value ? unresolvedConflicts(preview.value.entries, decisions.value) : [])
const opsLoading = computed(() => dashboardLoading.value || lifecycleLoading.value)

onMounted(() => {
  void loadDashboard()
  void loadLifecycle()
})

async function refreshOps() {
  await Promise.allSettled([loadDashboard(), loadLifecycle()])
}

async function loadDashboard() {
  const request = ++dashboardRequest
  dashboardLoading.value = true
  dashboardError.value = ''
  try {
    const [statusResult, backupResult, historyResult] = await Promise.allSettled([
      send('memebot/archive/status') as Promise<ArchiveStatus>,
      send('memebot/archive/backup/status') as Promise<BackupStatus>,
      send('memebot/archive/restore/history') as Promise<RestoreAuditEntry[]>,
    ])
    if (request !== dashboardRequest) return
    const failures: string[] = []
    if (statusResult.status === 'fulfilled') status.value = statusResult.value
    else failures.push(`健康状态：${presentConsoleError(statusResult.reason)}`)
    if (backupResult.status === 'fulfilled') backup.value = backupResult.value
    else failures.push(`备份队列：${presentConsoleError(backupResult.reason)}`)
    if (historyResult.status === 'fulfilled') restoreHistory.value = historyResult.value
    else failures.push(`恢复历史：${presentConsoleError(historyResult.reason)}`)
    dashboardError.value = failures.join('；')
  } finally {
    if (request === dashboardRequest) dashboardLoading.value = false
  }
}

async function loadLifecycle() {
  const request = ++lifecycleRequest
  lifecycleLoading.value = true
  lifecycleError.value = ''
  try {
    const [removedResult, retiredResult, historyResult, cleanupResult] = await Promise.all([
      send('memebot/archive/removed') as Promise<RemovedArchiveItem[]>,
      send('memebot/archive/attachments/retired') as Promise<RetiredAttachment[]>,
      send('memebot/archive/lifecycle/history') as Promise<LifecycleAuditEntry[]>,
      send('memebot/archive/cleanup/status') as Promise<CleanupStatus>,
    ])
    if (request !== lifecycleRequest) return
    removed.value = removedResult
    retired.value = retiredResult
    lifecycleHistory.value = historyResult
    cleanup.value = cleanupResult
  } catch (cause) {
    if (request === lifecycleRequest) lifecycleError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === lifecycleRequest) lifecycleLoading.value = false
  }
}

async function recheckHealth() {
  healthChecking.value = true
  dashboardError.value = ''
  try {
    const health = await send('memebot/archive/recheck') as Omit<ArchiveStatus, 'queue'> | undefined
    if (health) status.value = { ...health, queue: backup.value.counts }
    message.success('存储健康检查已完成。')
  } catch (cause) {
    dashboardError.value = presentConsoleError(cause)
    message.error(`存储健康检查失败：${dashboardError.value}`)
  } finally {
    healthChecking.value = false
  }
}

async function retryBackup(job: BackupJob) {
  retryingRecord.value = job.recordId
  try {
    backup.value = await send('memebot/archive/backup/retry', job.recordId) as BackupStatus
    if (status.value) status.value = { ...status.value, queue: backup.value.counts }
    const remaining = backup.value.jobs.some(item => item.recordId === job.recordId && item.state === 'failed')
    if (remaining) message.error(`${job.recordId} 备份仍然失败；诊断信息已保留，可再次重试。`)
    else message.success(`${job.recordId} 备份重试已完成。`)
  } catch (cause) {
    message.error(`重试 ${job.recordId} 备份失败：${presentConsoleError(cause)}`)
  } finally {
    retryingRecord.value = ''
  }
}

async function previewRecovery() {
  const request = ++recoveryRequest
  recoveryLoading.value = true
  recoveryError.value = ''
  try {
    const result = await send('memebot/archive/restore/preview') as RestorePreview
    if (request !== recoveryRequest) return
    preview.value = result
    decisions.value = defaultRecoveryDecisions(result.entries)
    restoreHistory.value = await send('memebot/archive/restore/history') as RestoreAuditEntry[]
  } catch (cause) {
    if (request === recoveryRequest) recoveryError.value = presentConsoleError(cause)
  } finally {
    if (request === recoveryRequest) recoveryLoading.value = false
  }
}

async function applyRecovery() {
  if (!preview.value) return
  if (conflictKeys.value.length) {
    message.error(`请先为 ${conflictKeys.value.join('、')} 选择“保留本地”或“使用 R2”。`)
    return
  }
  const selections = toRestoreSelections(preview.value.entries, decisions.value)
  try {
    await messageBox.confirm(
      `将按当前选择处理 ${selections.length} 项。应用前的预览与选择会写入恢复历史。`,
      '应用 R2 恢复？',
      { confirmButtonText: '应用恢复', cancelButtonText: '返回检查', type: 'warning' },
    )
  } catch {
    return
  }
  applying.value = true
  recoveryError.value = ''
  try {
    const result = await send('memebot/archive/restore/apply', selections) as RestoreResult
    message.success(`恢复完成：处理 ${result.restored} 个附件；结果已写入恢复历史。`)
    await previewRecovery()
    await loadDashboard()
  } catch (cause) {
    recoveryError.value = presentConsoleError(cause)
    message.error(`R2 恢复失败：${recoveryError.value}`)
    try {
      restoreHistory.value = await send('memebot/archive/restore/history') as RestoreAuditEntry[]
    } catch {
      // Keep the last successful audit context when the follow-up refresh also fails.
    }
  } finally {
    applying.value = false
  }
}

function openAction(action: LifecycleAction, target: LifecycleTarget) {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialogAction.value = action
  dialogTarget.value = target
  dialogVisible.value = true
}

function openRemove() {
  const id = removeIdentifier.value.trim().toUpperCase()
  if (!/^[PW]\d+$/.test(id)) {
    message.error('请输入有效的 Archive Identifier，例如 P12 或 W8。')
    return
  }
  openAction('remove', { id, label: `Archive Item ${id}` })
}

function restoreDialogFocus() {
  void nextTick(() => {
    const target = returnFocus?.isConnected ? returnFocus : focusAnchor.value
    target?.focus()
  })
}

async function submitAction(action: LifecycleAction, target: LifecycleTarget, typedIdentifier: string) {
  try {
    if (action === 'remove') await send('memebot/archive/record/remove', target.id, 'Y')
    else if (action === 'restore') await send('memebot/archive/record/restore', target.id)
    else if (action === 'purge') await send('memebot/archive/record/purge', target.id, typedIdentifier)
    else if (action === 'anonymize') await send('memebot/archive/record/anonymize', target.id, typedIdentifier)
    else await send('memebot/archive/attachment/restore', target.id)

    await loadLifecycle()
    if (action === 'remove') {
      removeIdentifier.value = ''
      message.success(`已移除 ${target.id}，恢复期限和历史已更新。`)
    } else if (action === 'restore') message.success(`已恢复 ${target.id}；Archive Identifier 与 Publication Appearances 保持不变。`)
    else if (action === 'restoreAttachment') message.success(`已恢复历史附件 ${target.label}。`)
    else if (action === 'purge') {
      const remote = cleanup.value.jobs.find(job => job.recordId === target.id && job.state !== 'complete')
      message.success(`已完成 ${target.id} 的本地永久清理。${remote ? '远端删除仍可在此页查看并重试。' : '远端删除已完成或未启用。'}`)
    } else message.success(`已匿名化 ${target.id} 的身份字段。`)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`${target.id} 操作失败：${reason}`)
    throw cause
  }
}

async function retryCleanup(job: CleanupJob) {
  try {
    cleanup.value = await send('memebot/archive/cleanup/retry', job.recordId) as CleanupStatus
    await loadLifecycle()
    const remaining = cleanup.value.jobs.some(item => item.recordId === job.recordId && item.state !== 'complete')
    if (remaining) message.error(`${job.recordId} 的远端删除仍未完成；错误已保留，可再次重试。`)
    else message.success(`${job.recordId} 的远端删除已完成。`)
  } catch (cause) {
    message.error(`重试 ${job.recordId} 远端删除失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function lastCheckLabel(value?: string) {
  return value ? formatDate(value) : '尚未检查'
}

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function backupStateLabel(state: BackupJob['state']) {
  return { pending: '等待重试', failed: '失败', complete: '已完成' }[state]
}

function actionLabel(action: LifecycleAuditEntry['action']) {
  return { remove: '移除', restore: '恢复', purge: '永久清理', anonymize: '匿名化' }[action]
}

function recoveryStatusLabel(entry: RestorePreviewEntry) {
  const status = entry.status === 'new' ? '新增'
    : entry.status === 'changed' ? '更新'
      : entry.status === 'conflicting' ? '冲突'
        : '无变化'
  return entry.missingAttachment ? `${status} · 缺少本地附件` : status
}

function recoveryStatusType(entry: RestorePreviewEntry) {
  if (entry.status === 'conflicting') return 'danger'
  if (entry.status === 'changed' || entry.missingAttachment) return 'warning'
  if (entry.status === 'new') return 'success'
  return 'info'
}

function recordLabel(entry: RestorePreviewEntry) {
  return entry.remote.title || entry.remote.author || entry.recordId
}

function auditDetails(entry: RestoreAuditEntry) {
  try {
    const parsed = JSON.parse(entry.details)
    if (Array.isArray(parsed)) return parsed.map(item => `${item.key}: ${item.decision} (${item.status})`).join('；') || '没有需要恢复的项目'
    if (parsed && typeof parsed === 'object') return Object.entries(parsed).map(([key, value]) => `${key}=${value}`).join('，')
  } catch {}
  return entry.details || '—'
}
</script>

<template>
  <section aria-labelledby="ops-heading">
    <div class="ops-heading">
      <div>
        <h2 id="ops-heading" tabindex="-1">运维</h2>
        <p>检查部署健康、重试备份、审查 R2 恢复差异，并管理移除、恢复与远端删除。</p>
      </div>
      <el-button :loading="opsLoading" @click="refreshOps">刷新</el-button>
    </div>

    <p class="sr-status" aria-live="polite">{{ opsLoading ? '正在刷新运维数据' : '运维数据已就绪' }}</p>
    <el-alert v-if="dashboardError" :title="`存储与恢复数据加载失败：${dashboardError}`" description="现有状态与选择会保留；可以再次刷新。" type="error" show-icon :closable="false" />
    <el-alert v-if="lifecycleError" :title="`生命周期数据加载失败：${lifecycleError}`" type="error" show-icon :closable="false" />

    <h3 id="recovery-section-heading" class="ops-section-heading">备份与恢复</h3>
    <section aria-labelledby="recovery-section-heading">
      <k-card v-loading="dashboardLoading" class="ops-section" title="部署存储健康">
        <el-empty v-if="!status && !dashboardLoading" description="尚未取得存储健康状态">
          <el-button @click="loadDashboard">重新加载</el-button>
        </el-empty>
        <template v-else-if="status">
          <div class="health-heading">
            <div>
              <el-tag :type="healthPresentation(status.state).type" effect="dark">{{ healthPresentation(status.state).label }}</el-tag>
              <strong>{{ healthPresentation(status.state).description }}</strong>
            </div>
            <el-button :loading="healthChecking" @click="recheckHealth">重新检查存储</el-button>
          </div>
          <p>上次检查：{{ lastCheckLabel(status.lastCheck) }}</p>
          <el-alert v-if="status.error" :title="status.error" type="error" show-icon :closable="false" />
          <el-descriptions :column="1" border>
            <el-descriptions-item label="本地存储">
              {{ status.stores.local.ok ? '可读写，诊断校验通过' : `不可用：${status.stores.local.error || '未知错误'}` }}
            </el-descriptions-item>
            <el-descriptions-item label="Cloudflare R2">
              <template v-if="!status.stores.r2.enabled">未启用；远端备份与恢复不可用</template>
              <template v-else>{{ status.stores.r2.ok ? '可读写，诊断校验通过' : `检查失败：${status.stores.r2.error || '未知错误'}` }}</template>
            </el-descriptions-item>
          </el-descriptions>
        </template>
      </k-card>

      <div class="summary-grid summary-grid--3" aria-label="Archive 备份队列摘要">
        <k-card title="等待备份"><strong>{{ backup.counts.pending }}</strong></k-card>
        <k-card title="备份失败"><strong>{{ backup.counts.failed }}</strong></k-card>
        <k-card title="备份完成"><strong>{{ backup.counts.complete }}</strong></k-card>
      </div>

      <k-card v-loading="dashboardLoading" class="ops-section" title="Archive Backups">
        <el-alert v-if="backup.counts.failed" :title="`${backup.counts.failed} 项 Archive Backup 失败`" description="失败任务会持久保留；无需重启 Koishi，可在下方单独重试。" type="warning" show-icon :closable="false" />
        <el-empty v-if="!activeBackupJobs.length" description="没有等待或失败的 Archive Backup" />
        <template v-else>
          <div class="desktop-storage">
            <el-table :data="activeBackupJobs" row-key="id" aria-label="等待或失败的 Archive Backup">
              <el-table-column prop="recordId" label="Archive ID" width="120" />
              <el-table-column label="类型" width="100"><template #default="scope">{{ scope.row.recordKind === 'paper' ? 'Paper' : 'Work' }}</template></el-table-column>
              <el-table-column label="状态" width="110"><template #default="scope">{{ backupStateLabel(scope.row.state) }}</template></el-table-column>
              <el-table-column prop="attempts" label="尝试" width="80" />
              <el-table-column label="上次尝试" min-width="170"><template #default="scope">{{ formatDate(scope.row.lastAttempt) }}</template></el-table-column>
              <el-table-column label="下次自动重试" min-width="170"><template #default="scope">{{ formatDate(scope.row.nextAttemptAt) }}</template></el-table-column>
              <el-table-column prop="error" label="诊断" min-width="220" />
              <el-table-column label="操作" width="110"><template #default="scope"><el-button link type="primary" :loading="retryingRecord === scope.row.recordId" @click="retryBackup(scope.row)">立即重试</el-button></template></el-table-column>
            </el-table>
          </div>
          <div class="mobile-storage" aria-label="等待或失败的 Archive Backup 卡片">
            <article v-for="job in activeBackupJobs" :key="job.id" class="storage-card">
              <strong>{{ job.recordId }} · {{ job.recordKind === 'paper' ? 'Paper' : 'Work' }}</strong>
              <span>状态：{{ backupStateLabel(job.state) }} · 已尝试 {{ job.attempts }} 次</span>
              <span>下次自动重试：{{ formatDate(job.nextAttemptAt) }}</span>
              <p>诊断：{{ job.error || '等待执行' }}</p>
              <el-button :loading="retryingRecord === job.recordId" @click="retryBackup(job)">立即重试</el-button>
            </article>
          </div>
        </template>
      </k-card>

      <k-card class="ops-section" title="R2 恢复预览与冲突处理">
        <div class="recovery-heading">
          <p>预览只读取 R2 清单；确认“应用恢复”前不会修改数据库或本地附件。</p>
          <el-button type="primary" :loading="recoveryLoading" @click="previewRecovery">从 R2 生成预览</el-button>
        </div>
        <el-alert v-if="recoveryError" :title="`R2 恢复操作失败：${recoveryError}`" description="上一次成功预览和冲突选择仍保留，可修复存储后重试。" type="error" show-icon :closable="false" />
        <div v-loading="recoveryLoading">
          <el-empty v-if="!preview" description="尚未生成 R2 恢复预览" />
          <template v-else>
            <div class="summary-grid summary-grid--4 recovery-summary" aria-label="R2 恢复差异摘要">
              <k-card title="新增"><strong>{{ preview.counts.new }}</strong></k-card>
              <k-card title="更新"><strong>{{ preview.counts.changed }}</strong></k-card>
              <k-card title="冲突"><strong>{{ preview.counts.conflicting }}</strong></k-card>
              <k-card title="缺少内容"><strong>{{ preview.counts.missing }}</strong></k-card>
            </div>
            <el-alert v-if="conflictKeys.length" :title="`${conflictKeys.length} 项冲突尚未选择处理方式`" description="每项冲突必须明确保留本地或使用 R2；选择可使用键盘操作。" type="warning" show-icon :closable="false" />
            <el-empty v-if="!preview.entries.length" description="R2 没有可恢复的 Archive 清单" />
            <template v-else>
              <div class="desktop-storage">
                <el-table :data="preview.entries" :row-key="recoveryKey" aria-label="R2 恢复差异与冲突选择">
                  <el-table-column prop="recordId" label="Archive ID" width="120" />
                  <el-table-column label="远端内容" min-width="200"><template #default="scope">{{ recordLabel(scope.row) }}</template></el-table-column>
                  <el-table-column label="差异" width="140"><template #default="scope"><el-tag :type="recoveryStatusType(scope.row)">{{ recoveryStatusLabel(scope.row) }}</el-tag></template></el-table-column>
                  <el-table-column label="处理方式" min-width="260"><template #default="scope"><el-radio-group v-model="decisions[recoveryKey(scope.row)]" :aria-label="`${scope.row.recordId} 恢复处理方式`"><el-radio value="local">保留本地</el-radio><el-radio value="r2">使用 R2</el-radio></el-radio-group></template></el-table-column>
                </el-table>
              </div>
              <div class="mobile-storage" aria-label="R2 恢复差异卡片">
                <article v-for="entry in preview.entries" :key="recoveryKey(entry)" class="storage-card">
                  <strong>{{ entry.recordId }} · {{ recordLabel(entry) }}</strong>
                  <el-tag :type="recoveryStatusType(entry)">{{ recoveryStatusLabel(entry) }}</el-tag>
                  <el-radio-group v-model="decisions[recoveryKey(entry)]" :aria-label="`${entry.recordId} 恢复处理方式`"><el-radio value="local">保留本地</el-radio><el-radio value="r2">使用 R2</el-radio></el-radio-group>
                </article>
              </div>
              <div class="apply-actions">
                <span>{{ conflictKeys.length ? '解决全部冲突后才能应用。' : '所有选择已明确；应用结果会写入恢复历史。' }}</span>
                <el-button type="danger" :loading="applying" :disabled="!!conflictKeys.length" @click="applyRecovery">检查并应用恢复</el-button>
              </div>
            </template>
          </template>
        </div>
      </k-card>

      <k-card v-loading="dashboardLoading" class="ops-section" title="恢复历史">
        <el-empty v-if="!restoreHistory.length" description="尚无恢复预览或应用历史" />
        <template v-else>
          <div class="desktop-storage">
            <el-table :data="restoreHistory" row-key="id" aria-label="R2 恢复审计历史">
              <el-table-column label="时间" min-width="180"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column>
              <el-table-column prop="actor" label="操作者" width="130" />
              <el-table-column label="动作" width="100"><template #default="scope">{{ scope.row.action === 'preview' ? '预览' : '应用恢复' }}</template></el-table-column>
              <el-table-column label="结果" width="100"><template #default="scope">{{ scope.row.result === 'complete' ? '完成' : '失败' }}</template></el-table-column>
              <el-table-column label="审计详情" min-width="320"><template #default="scope">{{ auditDetails(scope.row) }}</template></el-table-column>
            </el-table>
          </div>
          <div class="mobile-storage" aria-label="R2 恢复审计历史卡片">
            <article v-for="entry in restoreHistory" :key="entry.id" class="storage-card">
              <strong>{{ entry.action === 'preview' ? '恢复预览' : '应用恢复' }} · {{ entry.result === 'complete' ? '完成' : '失败' }}</strong>
              <span>{{ formatDate(entry.createdAt) }} · {{ entry.actor }}</span>
              <p>{{ auditDetails(entry) }}</p>
            </article>
          </div>
        </template>
      </k-card>
    </section>

    <h3 id="lifecycle-section-heading" ref="focusAnchor" tabindex="-1" class="ops-section-heading">生命周期审计</h3>
    <section v-loading="lifecycleLoading" aria-labelledby="lifecycle-section-heading">
      <el-alert
        v-if="cleanup.counts.failed"
        :title="`${cleanup.counts.failed} 项远端删除失败，但本地清理已成功完成`"
        description="失败任务会保留在下方，可独立重试。"
        type="warning"
        show-icon
        :closable="false"
      />

      <div class="summary-grid summary-grid--4" aria-label="生命周期摘要">
        <k-card title="已移除"><strong>{{ removed.filter(item => item.lifecycle === 'removed').length }}</strong></k-card>
        <k-card title="已退役附件"><strong>{{ retired.length }}</strong></k-card>
        <k-card title="远端删除待处理"><strong>{{ cleanup.counts.pending }}</strong></k-card>
        <k-card title="远端删除失败"><strong>{{ cleanup.counts.failed }}</strong></k-card>
      </div>

      <k-card class="ops-section" title="移除 Archive Item">
        <p>输入准确的 Paper 或 Work Archive Identifier，确认对话框会再次显示目标。</p>
        <div class="remove-controls">
          <el-input
            v-model="removeIdentifier"
            aria-label="要移除的 Archive Identifier"
            placeholder="例如 P12 或 W8"
            @keyup.enter="openRemove"
          />
          <el-button type="danger" @click="openRemove">检查并移除</el-button>
        </div>
      </k-card>

      <k-card class="ops-section" title="已移除的 Archive Items">
        <el-empty v-if="!removed.length" description="没有已移除或已清理的 Archive Item" />
        <template v-else>
        <div class="desktop-lifecycle">
          <el-table :data="removed" row-key="id" empty-text="没有已移除或已清理的 Archive Item" aria-label="已移除的 Archive Items">
            <el-table-column prop="id" label="Identifier" width="110" />
            <el-table-column label="类型" width="90"><template #default="scope">{{ scope.row.kind === 'paper' ? 'Paper' : 'Work' }}</template></el-table-column>
            <el-table-column prop="title" label="标题" min-width="180" />
            <el-table-column prop="lifecycle" label="状态" width="100" />
            <el-table-column label="移除时间" min-width="170"><template #default="scope">{{ formatDate(scope.row.removedAt) }}</template></el-table-column>
            <el-table-column label="恢复期限" min-width="170"><template #default="scope">{{ formatDate(scope.row.expiresAt) }}</template></el-table-column>
            <el-table-column label="操作" min-width="270">
              <template #default="scope">
                <el-button v-if="scope.row.lifecycle === 'removed'" link type="primary" @click="openAction('restore', { id: scope.row.id, label: scope.row.title })">恢复</el-button>
                <el-button v-if="scope.row.lifecycle === 'removed'" link type="danger" @click="openAction('purge', { id: scope.row.id, label: scope.row.title })">永久清理</el-button>
                <el-button link type="danger" @click="openAction('anonymize', { id: scope.row.id, label: scope.row.title })">匿名化</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <div class="mobile-lifecycle">
          <article v-for="item in removed" :key="item.id" class="lifecycle-card">
            <strong>{{ item.id }} · {{ item.title }}</strong>
            <span>{{ item.kind === 'paper' ? 'Paper' : 'Work' }} · {{ item.lifecycle }}</span>
            <small>移除：{{ formatDate(item.removedAt) }}</small>
            <small>恢复期限：{{ formatDate(item.expiresAt) }}</small>
            <div class="card-actions">
              <el-button v-if="item.lifecycle === 'removed'" @click="openAction('restore', { id: item.id, label: item.title })">恢复</el-button>
              <el-button v-if="item.lifecycle === 'removed'" type="danger" @click="openAction('purge', { id: item.id, label: item.title })">永久清理</el-button>
              <el-button type="danger" plain @click="openAction('anonymize', { id: item.id, label: item.title })">匿名化</el-button>
            </div>
          </article>
        </div>
        </template>
      </k-card>

      <k-card class="ops-section" title="已退役附件">
        <el-empty v-if="!retired.length" description="没有可恢复的已退役附件" />
        <template v-else>
        <div class="desktop-lifecycle">
          <el-table :data="retired" row-key="id" empty-text="没有可恢复的已退役附件" aria-label="已退役附件">
            <el-table-column prop="recordId" label="Archive Item" width="120" />
            <el-table-column prop="attachment.relativePath" label="历史附件" min-width="240" />
            <el-table-column label="大小" width="110"><template #default="scope">{{ formatBytes(scope.row.attachment.size) }}</template></el-table-column>
            <el-table-column label="恢复期限" min-width="180"><template #default="scope">{{ formatDate(scope.row.expiresAt) }}</template></el-table-column>
            <el-table-column label="操作" width="110"><template #default="scope"><el-button link type="primary" @click="openAction('restoreAttachment', { id: scope.row.id, label: `${scope.row.recordId} · ${scope.row.attachment.relativePath}` })">恢复版本</el-button></template></el-table-column>
          </el-table>
        </div>
        <div class="mobile-lifecycle">
          <article v-for="item in retired" :key="item.id" class="lifecycle-card">
            <strong>{{ item.recordId }} · {{ item.attachment.relativePath }}</strong>
            <small>{{ formatBytes(item.attachment.size) }} · 恢复期限 {{ formatDate(item.expiresAt) }}</small>
            <el-button @click="openAction('restoreAttachment', { id: item.id, label: `${item.recordId} · ${item.attachment.relativePath}` })">恢复版本</el-button>
          </article>
        </div>
        </template>
      </k-card>

      <k-card class="ops-section" title="远端删除工作">
        <el-empty v-if="!activeCleanupJobs.length" description="没有待处理或失败的远端删除工作" />
        <div v-else class="desktop-lifecycle">
          <el-table :data="activeCleanupJobs" row-key="id" aria-label="远端删除工作">
            <el-table-column prop="recordId" label="Archive Item" width="120" />
            <el-table-column prop="state" label="状态" width="100" />
            <el-table-column prop="attempts" label="尝试" width="80" />
            <el-table-column label="对象" min-width="240"><template #default="scope">{{ scope.row.objectKeys.join('、') }}</template></el-table-column>
            <el-table-column prop="error" label="最近错误" min-width="180" />
            <el-table-column label="下次尝试" min-width="180"><template #default="scope">{{ formatDate(scope.row.nextAttemptAt) }}</template></el-table-column>
            <el-table-column label="操作" width="100"><template #default="scope"><el-button link type="primary" @click="retryCleanup(scope.row)">立即重试</el-button></template></el-table-column>
          </el-table>
        </div>
        <div class="mobile-lifecycle">
          <article v-for="job in activeCleanupJobs" :key="job.id" class="lifecycle-card">
            <strong>{{ job.recordId }} · {{ job.state }}</strong>
            <span>{{ job.error || '等待远端删除' }}</span>
            <small>{{ job.objectKeys.join('、') }}</small>
            <el-button @click="retryCleanup(job)">立即重试</el-button>
          </article>
        </div>
      </k-card>

      <k-card class="ops-section" title="生命周期历史">
        <div class="desktop-lifecycle">
          <el-table :data="lifecycleHistory" row-key="id" empty-text="尚无生命周期历史" aria-label="生命周期历史">
            <el-table-column label="时间" min-width="180"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column>
            <el-table-column prop="recordId" label="Archive Item" width="120" />
            <el-table-column label="动作" width="110"><template #default="scope">{{ actionLabel(scope.row.action) }}</template></el-table-column>
            <el-table-column prop="actor" label="操作者" min-width="140" />
            <el-table-column prop="details" label="详情" min-width="220" />
          </el-table>
        </div>
        <div class="mobile-lifecycle" aria-label="生命周期历史卡片">
          <article v-for="entry in lifecycleHistory" :key="entry.id" class="lifecycle-card">
            <strong>{{ entry.recordId }} · {{ actionLabel(entry.action) }}</strong>
            <span>{{ formatDate(entry.createdAt) }} · {{ entry.actor }}</span>
            <small>{{ entry.details || '—' }}</small>
          </article>
          <el-empty v-if="!lifecycleHistory.length" description="尚无生命周期历史" />
        </div>
      </k-card>
    </section>

    <LifecycleActionDialog
      v-model="dialogVisible"
      :action="dialogAction"
      :target="dialogTarget"
      :submit="submitAction"
      @closed="restoreDialogFocus"
    />
  </section>
</template>

<style scoped>
.ops-heading,
.health-heading,
.recovery-heading,
.apply-actions,
.remove-controls,
.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.ops-heading p,
.recovery-heading p,
.ops-section p {
  margin: 0;
  color: var(--fg2);
}

.health-heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ops-section-heading {
  margin: 24px 0 0;
  font-size: 1.1rem;
}

.ops-section {
  margin-top: 18px;
}

.summary-grid {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.summary-grid strong {
  font-size: 1.8rem;
}

.summary-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.summary-grid--4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.recovery-summary {
  margin-bottom: 16px;
}

.remove-controls :deep(.el-input) {
  max-width: 420px;
}

.mobile-storage,
.mobile-lifecycle {
  display: none;
}

.storage-card,
.lifecycle-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  overflow-wrap: anywhere;
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
}

.storage-card p,
.lifecycle-card small {
  margin: 0;
  color: var(--fg2);
  overflow-wrap: anywhere;
}

.apply-actions {
  margin-top: 16px;
}

.sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 767px) {
  .desktop-storage,
  .desktop-lifecycle {
    display: none;
  }

  .mobile-storage,
  .mobile-lifecycle {
    display: grid;
    gap: 10px;
  }

  .ops-heading,
  .health-heading,
  .recovery-heading,
  .apply-actions,
  .remove-controls,
  .health-heading > div {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-grid--3,
  .summary-grid--4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .remove-controls :deep(.el-input) {
    max-width: none;
  }
}
</style>
