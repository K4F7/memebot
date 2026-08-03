<script setup lang="ts">
import { message, send } from '@koishijs/client'
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

const removed = ref<RemovedArchiveItem[]>([])
const retired = ref<RetiredAttachment[]>([])
const history = ref<LifecycleAuditEntry[]>([])
const cleanup = ref<CleanupStatus>({ counts: { pending: 0, failed: 0, complete: 0 }, jobs: [] })
const loading = ref(false)
const loadError = ref('')
const removeIdentifier = ref('')
const dialogVisible = ref(false)
const dialogAction = ref<LifecycleAction>()
const dialogTarget = ref<LifecycleTarget>()
const focusAnchor = ref<HTMLElement>()
let requestSequence = 0
let returnFocus: HTMLElement | null = null

const activeCleanupJobs = computed(() => cleanup.value.jobs.filter(job => job.state !== 'complete'))

onMounted(loadLifecycle)

async function loadLifecycle() {
  const request = ++requestSequence
  loading.value = true
  loadError.value = ''
  try {
    const [removedResult, retiredResult, historyResult, cleanupResult] = await Promise.all([
      send('memebot/archive/removed') as Promise<RemovedArchiveItem[]>,
      send('memebot/archive/attachments/retired') as Promise<RetiredAttachment[]>,
      send('memebot/archive/lifecycle/history') as Promise<LifecycleAuditEntry[]>,
      send('memebot/archive/cleanup/status') as Promise<CleanupStatus>,
    ])
    if (request !== requestSequence) return
    removed.value = removedResult
    retired.value = retiredResult
    history.value = historyResult
    cleanup.value = cleanupResult
  } catch (cause) {
    if (request === requestSequence) loadError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === requestSequence) loading.value = false
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

function actionLabel(action: LifecycleAuditEntry['action']) {
  return { remove: '移除', restore: '恢复', purge: '永久清理', anonymize: '匿名化' }[action]
}
</script>

<template>
  <section v-loading="loading" aria-labelledby="lifecycle-heading">
    <div class="lifecycle-heading">
      <div>
        <h2 id="lifecycle-heading" ref="focusAnchor" tabindex="-1">生命周期审计</h2>
        <p>管理移除、恢复、到期清理、匿名化与可重试的远端删除工作。</p>
      </div>
      <el-button :loading="loading" @click="loadLifecycle">刷新</el-button>
    </div>

    <el-alert v-if="loadError" :title="`生命周期数据加载失败：${loadError}`" type="error" show-icon :closable="false" />
    <el-alert
      v-if="cleanup.counts.failed"
      :title="`${cleanup.counts.failed} 项远端删除失败，但本地清理已成功完成`"
      description="失败任务会保留在下方，可独立重试。"
      type="warning"
      show-icon
      :closable="false"
    />

    <div class="summary-grid" aria-label="生命周期摘要">
      <k-card title="已移除"><strong>{{ removed.filter(item => item.lifecycle === 'removed').length }}</strong></k-card>
      <k-card title="已退役附件"><strong>{{ retired.length }}</strong></k-card>
      <k-card title="远端删除待处理"><strong>{{ cleanup.counts.pending }}</strong></k-card>
      <k-card title="远端删除失败"><strong>{{ cleanup.counts.failed }}</strong></k-card>
    </div>

    <k-card class="lifecycle-section" title="移除 Archive Item">
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

    <k-card class="lifecycle-section" title="已移除的 Archive Items">
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

    <k-card class="lifecycle-section" title="已退役附件">
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

    <k-card class="lifecycle-section" title="远端删除工作">
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

    <k-card class="lifecycle-section" title="生命周期历史">
      <div class="desktop-lifecycle">
        <el-table :data="history" row-key="id" empty-text="尚无生命周期历史" aria-label="生命周期历史">
          <el-table-column label="时间" min-width="180"><template #default="scope">{{ formatDate(scope.row.createdAt) }}</template></el-table-column>
          <el-table-column prop="recordId" label="Archive Item" width="120" />
          <el-table-column label="动作" width="110"><template #default="scope">{{ actionLabel(scope.row.action) }}</template></el-table-column>
          <el-table-column prop="actor" label="操作者" min-width="140" />
          <el-table-column prop="details" label="详情" min-width="220" />
        </el-table>
      </div>
      <div class="mobile-lifecycle" aria-label="生命周期历史卡片">
        <article v-for="entry in history" :key="entry.id" class="lifecycle-card">
          <strong>{{ entry.recordId }} · {{ actionLabel(entry.action) }}</strong>
          <span>{{ formatDate(entry.createdAt) }} · {{ entry.actor }}</span>
          <small>{{ entry.details || '—' }}</small>
        </article>
        <el-empty v-if="!history.length" description="尚无生命周期历史" />
      </div>
    </k-card>

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
.lifecycle-heading,
.remove-controls,
.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.lifecycle-heading p,
.lifecycle-section p {
  color: var(--fg2);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.summary-grid strong {
  font-size: 1.8rem;
}

.lifecycle-section {
  margin-top: 18px;
}

.remove-controls :deep(.el-input) {
  max-width: 420px;
}

.mobile-lifecycle {
  display: none;
}

.lifecycle-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
}

.lifecycle-card small {
  color: var(--fg2);
  overflow-wrap: anywhere;
}

.card-actions {
  flex-wrap: wrap;
  justify-content: flex-start;
}

@media (max-width: 767px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .desktop-lifecycle {
    display: none;
  }

  .mobile-lifecycle {
    display: grid;
    gap: 10px;
  }

  .lifecycle-heading,
  .remove-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .remove-controls :deep(.el-input) {
    max-width: none;
  }
}
</style>
