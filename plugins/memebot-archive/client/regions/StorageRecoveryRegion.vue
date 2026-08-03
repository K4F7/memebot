<script setup lang="ts">
import { message, messageBox, send } from '@koishijs/client'
import { computed, onMounted, ref } from 'vue'

import { defaultRecoveryDecisions, healthPresentation, presentConsoleError, recoveryKey, toRestoreSelections, unresolvedConflicts } from '../storage/state'
import type { ArchiveStatus, BackupJob, BackupStatus, RestoreAuditEntry, RestoreDecisions, RestorePreview, RestorePreviewEntry, RestoreResult } from '../storage/types'

const status = ref<ArchiveStatus>()
const backup = ref<BackupStatus>({ counts: { pending: 0, failed: 0, complete: 0 }, jobs: [] })
const preview = ref<RestorePreview>()
const decisions = ref<RestoreDecisions>({})
const history = ref<RestoreAuditEntry[]>([])
const dashboardLoading = ref(false)
const dashboardError = ref('')
const healthChecking = ref(false)
const retryingRecord = ref('')
const recoveryLoading = ref(false)
const applying = ref(false)
const recoveryError = ref('')
let dashboardRequest = 0
let recoveryRequest = 0

const activeBackupJobs = computed(() => backup.value.jobs.filter(job => job.state !== 'complete'))
const conflictKeys = computed(() => preview.value ? unresolvedConflicts(preview.value.entries, decisions.value) : [])

onMounted(loadDashboard)

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
    if (historyResult.status === 'fulfilled') history.value = historyResult.value
    else failures.push(`恢复历史：${presentConsoleError(historyResult.reason)}`)
    dashboardError.value = failures.join('；')
  } finally {
    if (request === dashboardRequest) dashboardLoading.value = false
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
    history.value = await send('memebot/archive/restore/history') as RestoreAuditEntry[]
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
      history.value = await send('memebot/archive/restore/history') as RestoreAuditEntry[]
    } catch {
      // Keep the last successful audit context when the follow-up refresh also fails.
    }
  } finally {
    applying.value = false
  }
}

function formatDate(value?: string) {
  if (!value) return '尚未检查'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function backupStateLabel(state: BackupJob['state']) {
  return { pending: '等待重试', failed: '失败', complete: '已完成' }[state]
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
  <section aria-labelledby="storage-heading">
    <div class="storage-heading">
      <div>
        <h2 id="storage-heading" tabindex="-1">存储、备份与 R2 恢复</h2>
        <p>检查部署健康、重试失败备份，并在任何数据库修改前审查 R2 恢复差异。</p>
      </div>
      <el-button :loading="dashboardLoading" @click="loadDashboard">刷新全部</el-button>
    </div>

    <p class="sr-status" aria-live="polite">{{ dashboardLoading ? '正在刷新存储与恢复数据' : '存储与恢复数据已就绪' }}</p>
    <el-alert v-if="dashboardError" :title="`存储与恢复数据加载失败：${dashboardError}`" description="现有状态与选择会保留；可以再次刷新。" type="error" show-icon :closable="false" />

    <k-card v-loading="dashboardLoading" class="storage-section" title="部署存储健康">
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
        <p>上次检查：{{ formatDate(status.lastCheck) }}</p>
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

    <div class="summary-grid" aria-label="Archive 备份队列摘要">
      <k-card title="等待备份"><strong>{{ backup.counts.pending }}</strong></k-card>
      <k-card title="备份失败"><strong>{{ backup.counts.failed }}</strong></k-card>
      <k-card title="备份完成"><strong>{{ backup.counts.complete }}</strong></k-card>
    </div>

    <k-card v-loading="dashboardLoading" class="storage-section" title="Archive Backups">
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

    <k-card class="storage-section" title="R2 恢复预览与冲突处理">
      <div class="recovery-heading">
        <p>预览只读取 R2 清单；确认“应用恢复”前不会修改数据库或本地附件。</p>
        <el-button type="primary" :loading="recoveryLoading" @click="previewRecovery">从 R2 生成预览</el-button>
      </div>
      <el-alert v-if="recoveryError" :title="`R2 恢复操作失败：${recoveryError}`" description="上一次成功预览和冲突选择仍保留，可修复存储后重试。" type="error" show-icon :closable="false" />
      <div v-loading="recoveryLoading">
        <el-empty v-if="!preview" description="尚未生成 R2 恢复预览" />
        <template v-else>
          <div class="summary-grid recovery-summary" aria-label="R2 恢复差异摘要">
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

    <k-card v-loading="dashboardLoading" class="storage-section" title="恢复历史">
      <el-empty v-if="!history.length" description="尚无恢复预览或应用历史" />
      <template v-else>
        <div class="desktop-storage">
          <el-table :data="history" row-key="id" aria-label="R2 恢复审计历史">
            <el-table-column label="时间" min-width="180"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column>
            <el-table-column prop="actor" label="操作者" width="130" />
            <el-table-column label="动作" width="100"><template #default="scope">{{ scope.row.action === 'preview' ? '预览' : '应用恢复' }}</template></el-table-column>
            <el-table-column label="结果" width="100"><template #default="scope">{{ scope.row.result === 'complete' ? '完成' : '失败' }}</template></el-table-column>
            <el-table-column label="审计详情" min-width="320"><template #default="scope">{{ auditDetails(scope.row) }}</template></el-table-column>
          </el-table>
        </div>
        <div class="mobile-storage" aria-label="R2 恢复审计历史卡片">
          <article v-for="entry in history" :key="entry.id" class="storage-card">
            <strong>{{ entry.action === 'preview' ? '恢复预览' : '应用恢复' }} · {{ entry.result === 'complete' ? '完成' : '失败' }}</strong>
            <span>{{ formatDate(entry.createdAt) }} · {{ entry.actor }}</span>
            <p>{{ auditDetails(entry) }}</p>
          </article>
        </div>
      </template>
    </k-card>
  </section>
</template>

<style scoped>
.storage-heading,
.health-heading,
.recovery-heading,
.apply-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.storage-heading p,
.recovery-heading p {
  margin: 0;
  color: var(--fg2);
}

.health-heading > div {
  display: flex;
  align-items: center;
  gap: 12px;
}

.storage-section {
  margin-top: 20px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 20px;
}

.summary-grid strong {
  font-size: 1.8rem;
}

.recovery-summary {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 16px;
}

.mobile-storage {
  display: none;
}

.storage-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  overflow-wrap: anywhere;
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
}

.storage-card p {
  margin: 0;
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
  .desktop-storage {
    display: none;
  }

  .mobile-storage {
    display: grid;
    gap: 10px;
  }

  .storage-heading,
  .health-heading,
  .recovery-heading,
  .apply-actions,
  .health-heading > div {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-grid,
  .recovery-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
