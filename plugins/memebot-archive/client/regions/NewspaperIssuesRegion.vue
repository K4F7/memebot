<script setup lang="ts">
import { message, router, send } from '@koishijs/client'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import IssueFormDialog from '../issues/IssueFormDialog.vue'
import IssuePreviewDialog from '../issues/IssuePreviewDialog.vue'
import { LatestIssueRequest, normalizeIssuesRoute, paginateIssues, toIssuesQuery, type IssuePageSize } from '../issues/state'
import type { ConsoleAttachment, IssueDetails, IssueFormValue, NewspaperIssue, PdfResult } from '../issues/types'

const issues = ref<NewspaperIssue[]>([])
const loading = ref(false)
const listError = ref('')
const details = ref<IssueDetails>()
const detailsLoading = ref(false)
const detailsError = ref('')
const searchInput = ref('')
const formVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const previewVisible = ref(false)
const focusAnchor = ref<HTMLElement>()
const listRequests = new LatestIssueRequest()
const detailRequests = new LatestIssueRequest()
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let returnFocus: HTMLElement | null = null

const routeState = computed(() => normalizeIssuesRoute(router.currentRoute.value.query))
const selectedPaper = computed(() => issues.value.find(issue => issue.id === routeState.value.selected) ?? details.value?.paper)
const visibleIssues = computed(() => paginateIssues(issues.value, routeState.value.page, routeState.value.pageSize))
const maxPage = computed(() => Math.max(1, Math.ceil(issues.value.length / routeState.value.pageSize)))

function replaceRoute(patch: Partial<ReturnType<typeof normalizeIssuesRoute>>) {
  const next = { ...routeState.value, ...patch }
  if (JSON.stringify(toIssuesQuery(next)) === JSON.stringify(toIssuesQuery(routeState.value))) return
  void router.push({ path: router.currentRoute.value.path, query: toIssuesQuery(next) })
}

watch(() => routeState.value.search, (value) => {
  if (searchInput.value !== value) searchInput.value = value
}, { immediate: true })

watch(searchInput, (value) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    const search = value.trim()
    if (search !== routeState.value.search) replaceRoute({ search, page: 1, selected: '' })
  }, 300)
})

watch(() => routeState.value.search, loadIssues, { immediate: true })
watch(() => routeState.value.selected, loadDetails, { immediate: true })
watch([() => issues.value.length, () => routeState.value.pageSize], () => {
  if (routeState.value.page > maxPage.value) replaceRoute({ page: maxPage.value })
})

onBeforeUnmount(() => clearTimeout(debounceTimer))

async function loadIssues() {
  const request = listRequests.start()
  loading.value = true
  listError.value = ''
  try {
    const result = await send('memebot/archive/papers', routeState.value.search || undefined) as NewspaperIssue[]
    if (listRequests.isCurrent(request)) issues.value = result
  } catch (cause) {
    if (listRequests.isCurrent(request)) listError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (listRequests.isCurrent(request)) loading.value = false
  }
}

async function loadDetails() {
  const request = detailRequests.start()
  const id = routeState.value.selected
  details.value = undefined
  detailsError.value = ''
  if (!id) {
    detailsLoading.value = false
    return
  }
  detailsLoading.value = true
  try {
    const result = await send('memebot/archive/paper/details', id) as IssueDetails
    if (detailRequests.isCurrent(request)) details.value = result
  } catch (cause) {
    if (detailRequests.isCurrent(request)) detailsError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (detailRequests.isCurrent(request)) detailsLoading.value = false
  }
}

function selectIssue(issue: NewspaperIssue) {
  replaceRoute({ selected: issue.id })
}

function rememberFocus() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function openCreate() {
  rememberFocus()
  formMode.value = 'create'
  formVisible.value = true
}

function openEdit() {
  if (!selectedPaper.value) return
  rememberFocus()
  formMode.value = 'edit'
  formVisible.value = true
}

function openPreview() {
  if (!selectedPaper.value?.attachment) return
  rememberFocus()
  previewVisible.value = true
}

function restoreDialogFocus() {
  void nextTick(() => {
    const target = returnFocus?.isConnected ? returnFocus : focusAnchor.value
    target?.focus()
  })
}

function fileAttachment(file: File) {
  return new Promise<ConsoleAttachment>((resolveAttachment, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolveAttachment({ filename: file.name, contentType: file.type || 'application/pdf', data: String(reader.result) })
    reader.onerror = () => reject(reader.error ?? new Error('无法读取 PDF'))
    reader.readAsDataURL(file)
  })
}

async function saveIssue(value: IssueFormValue) {
  try {
    const metadata = {
      month: value.month,
      issueNumber: value.issueNumber,
      title: value.title,
      description: value.description,
      sourceLink: value.sourceLink,
    }
    if (formMode.value === 'create') {
      const created = await send('memebot/archive/paper/create', {
        ...metadata,
        attachment: await fileAttachment(value.file!),
      }) as NewspaperIssue
      message.success(`已创建 Newspaper Issue ${created.id}。`)
      await loadIssues()
      replaceRoute({ selected: created.id })
      return
    }

    const paper = selectedPaper.value
    if (!paper) throw new Error('请选择要编辑的 Newspaper Issue。')
    await send('memebot/archive/paper/edit', paper.id, metadata)
    if (value.file) await send('memebot/archive/paper/upload', paper.id, await fileAttachment(value.file))
    message.success(`已更新 ${paper.id}${value.file ? ' 及其权威 PDF' : ''}。`)
    await Promise.all([loadIssues(), loadDetails()])
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`${formMode.value === 'create' ? '创建' : '更新'} Newspaper Issue 失败：${reason}`)
    throw cause
  }
}

function saveDownload(result: PdfResult) {
  const binary = atob(result.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType ?? 'application/pdf' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function downloadPaper(paper: NewspaperIssue) {
  try {
    saveDownload(await send('memebot/archive/paper/download', paper.id) as PdfResult)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`权威 PDF 下载失败：${reason}`)
    throw cause
  }
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '无附件'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function changePageSize(value: number) {
  replaceRoute({ pageSize: value as IssuePageSize, page: 1 })
}
</script>

<template>
  <section aria-labelledby="issues-heading">
    <div class="issues-heading">
      <div>
        <h2 id="issues-heading" ref="focusAnchor" tabindex="-1">报纸期数</h2>
        <p>查找、创建、维护并明确预览或下载每期报纸的权威 PDF。</p>
      </div>
      <el-button type="primary" @click="openCreate">创建 Newspaper Issue</el-button>
    </div>

    <div class="issues-search" role="search">
      <el-input v-model="searchInput" clearable aria-label="搜索 Newspaper Issues" placeholder="按月份、期号、标题或收录作品搜索" />
      <span aria-live="polite">{{ loading ? '正在搜索…' : `共 ${issues.length} 项` }}</span>
    </div>
    <el-alert v-if="listError" :title="`Newspaper Issues 加载失败：${listError}`" type="error" show-icon :closable="false" />

    <div v-loading="loading" class="issues-results">
      <el-empty v-if="!loading && !visibleIssues.length" description="没有匹配的 Newspaper Issues" />
      <template v-else>
        <div class="desktop-results">
          <el-table
            :data="visibleIssues"
            row-key="id"
            highlight-current-row
            :current-row-key="routeState.selected"
            aria-label="Newspaper Issues 搜索结果"
            @row-click="selectIssue"
          >
            <el-table-column prop="id" label="编号" width="90" />
            <el-table-column prop="month" label="月份" width="110" />
            <el-table-column prop="issueNumber" label="期号" width="110" />
            <el-table-column prop="title" label="标题" min-width="200" />
            <el-table-column label="权威 PDF" min-width="140"><template #default="scope">{{ formatBytes(scope.row.attachment?.size) }}</template></el-table-column>
            <el-table-column prop="backupState" label="备份" width="100" />
            <el-table-column label="操作" width="110"><template #default="scope"><el-button link type="primary" @click.stop="selectIssue(scope.row)">查看详情</el-button></template></el-table-column>
          </el-table>
        </div>
        <div class="mobile-results" aria-label="Newspaper Issues 搜索结果卡片">
          <button
            v-for="issue in visibleIssues"
            :key="issue.id"
            type="button"
            class="issue-card"
            :class="{ selected: routeState.selected === issue.id }"
            @click="selectIssue(issue)"
          >
            <strong>{{ issue.id }} · {{ issue.title }}</strong>
            <span>{{ issue.month }} · 第 {{ issue.issueNumber }} 期</span>
            <small>{{ formatBytes(issue.attachment?.size) }} · 备份 {{ issue.backupState ?? 'disabled' }}</small>
          </button>
        </div>
      </template>
    </div>

    <el-pagination
      class="issues-pagination"
      background
      layout="total, sizes, prev, pager, next"
      :total="issues.length"
      :current-page="routeState.page"
      :page-size="routeState.pageSize"
      :page-sizes="[20, 50, 100]"
      @update:current-page="replaceRoute({ page: $event })"
      @update:page-size="changePageSize"
    />

    <k-card v-if="routeState.selected" class="issue-details" title="Newspaper Issue 详情" v-loading="detailsLoading">
      <el-alert v-if="detailsError" :title="`详情加载失败：${detailsError}`" type="error" show-icon :closable="false" />
      <template v-else-if="details">
        <div class="details-heading">
          <div>
            <h3>{{ details.paper.id }} · {{ details.paper.title }}</h3>
            <p>{{ details.paper.month }} · 第 {{ details.paper.issueNumber }} 期</p>
          </div>
          <div class="details-actions">
            <el-button @click="openEdit">编辑或替换 PDF</el-button>
            <el-button :disabled="!details.paper.attachment" @click="downloadPaper(details.paper)">下载权威 PDF</el-button>
            <el-button type="primary" :disabled="!details.paper.attachment" @click="openPreview">明确预览 PDF</el-button>
          </div>
        </div>
        <p v-if="details.paper.description">{{ details.paper.description }}</p>
        <a v-if="details.paper.sourceLink" :href="details.paper.sourceLink" target="_blank" rel="noopener noreferrer">打开来源链接</a>
        <el-descriptions :column="1" border class="paper-metadata">
          <el-descriptions-item label="权威附件">{{ details.paper.attachment?.relativePath ?? '无' }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{ formatBytes(details.paper.attachment?.size) }}</el-descriptions-item>
          <el-descriptions-item label="备份状态">{{ details.paper.backupState ?? 'disabled' }}</el-descriptions-item>
          <el-descriptions-item label="校验和">{{ details.paper.attachment?.checksum ?? '无' }}</el-descriptions-item>
        </el-descriptions>
        <h4>收录作品</h4>
        <el-empty v-if="!details.works.length" description="尚未收录 Work" />
        <ul v-else class="appearance-list">
          <li v-for="item in details.works" :key="item.work.id">
            {{ item.work.id }} · {{ item.work.author }} — {{ item.work.title }}
            <span v-if="item.page"> · 第 {{ item.page }} 页</span>
            <span v-if="item.section"> · {{ item.section }}</span>
            <span v-if="item.unavailable"> · 已移除，不可用</span>
          </li>
        </ul>
      </template>
    </k-card>

    <IssueFormDialog
      v-model="formVisible"
      :mode="formMode"
      :paper="formMode === 'edit' ? selectedPaper : undefined"
      :submit="saveIssue"
      @closed="restoreDialogFocus"
    />
    <IssuePreviewDialog
      v-model="previewVisible"
      :paper="selectedPaper"
      :download="downloadPaper"
      @closed="restoreDialogFocus"
    />
  </section>
</template>

<style scoped>
.issues-heading,
.issues-search,
.details-heading,
.details-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.issues-heading p,
.details-heading p {
  margin: 0;
  color: var(--fg2);
}

.issues-search {
  margin: 20px 0 12px;
}

.issues-search :deep(.el-input) {
  max-width: 560px;
}

.mobile-results {
  display: none;
}

.issue-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 14px;
  color: inherit;
  text-align: left;
  background: var(--k-card-bg);
  border: 1px solid var(--k-color-divider);
  border-radius: 8px;
}

.issue-card.selected {
  border-color: var(--k-color-primary);
}

.issue-card small {
  color: var(--fg2);
}

.issues-pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-top: 16px;
}

.issue-details {
  margin-top: 24px;
}

.details-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.paper-metadata {
  margin-top: 16px;
}

.appearance-list {
  line-height: 1.8;
}

@media (max-width: 767px) {
  .desktop-results {
    display: none;
  }

  .mobile-results {
    display: grid;
    gap: 10px;
  }

  .issues-heading,
  .issues-search,
  .details-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .issues-search :deep(.el-input) {
    max-width: none;
  }

  .issues-pagination {
    justify-content: center;
  }
}
</style>
