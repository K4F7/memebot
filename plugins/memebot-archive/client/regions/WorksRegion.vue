<script setup lang="ts">
import { message, messageBox, router, send } from '@koishijs/client'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import type { NewspaperIssue } from '../issues/types'
import AppearanceFormDialog from '../works/AppearanceFormDialog.vue'
import WorkFormDialog from '../works/WorkFormDialog.vue'
import WorkPreviewDialog from '../works/WorkPreviewDialog.vue'
import { LatestRequest, normalizeWorksRoute, paginateWorks, toWorksQuery, type WorkPageSize } from '../works/state'
import type { AppearanceFormValue, ConsoleAttachment, DownloadResult, Work, WorkDetails, WorkFormValue, WorkPaper } from '../works/types'

const works = ref<Work[]>([])
const loading = ref(false)
const listError = ref('')
const details = ref<WorkDetails>()
const detailsLoading = ref(false)
const detailsError = ref('')
const searchInput = ref('')
const formVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const previewVisible = ref(false)
const appearanceVisible = ref(false)
const appearance = ref<WorkPaper>()
const appearanceWork = ref<Work>()
const appearancePaperIds = ref<string[]>([])
const papers = ref<NewspaperIssue[]>([])
const papersLoading = ref(false)
const appearanceAction = ref('')
const focusAnchor = ref<HTMLElement>()
const listRequests = new LatestRequest()
const detailRequests = new LatestRequest()
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let returnFocus: HTMLElement | null = null
let appearanceRequest = 0
let workSelection = 0

const routeState = computed(() => normalizeWorksRoute(router.currentRoute.value.query))
const selectedWork = computed(() => works.value.find(work => work.id === routeState.value.selected) ?? details.value?.work)
const visibleWorks = computed(() => paginateWorks(works.value, routeState.value.page, routeState.value.pageSize))
const maxPage = computed(() => Math.max(1, Math.ceil(works.value.length / routeState.value.pageSize)))
const selectablePapers = computed(() => appearance.value
  ? papers.value
  : papers.value.filter(paper => !appearancePaperIds.value.includes(paper.id)))

function replaceRoute(patch: Partial<ReturnType<typeof normalizeWorksRoute>>) {
  const next = { ...routeState.value, ...patch }
  if (JSON.stringify(toWorksQuery(next)) === JSON.stringify(toWorksQuery(routeState.value))) return
  void router.push({
    path: router.currentRoute.value.path,
    query: toWorksQuery(next),
  })
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

watch(() => routeState.value.search, loadWorks, { immediate: true })
watch(() => routeState.value.selected, () => {
  workSelection += 1
  void loadDetails()
}, { immediate: true })
watch([() => works.value.length, () => routeState.value.pageSize], () => {
  if (routeState.value.page > maxPage.value) replaceRoute({ page: maxPage.value })
})

onBeforeUnmount(() => clearTimeout(debounceTimer))

async function loadWorks() {
  const request = listRequests.start()
  loading.value = true
  listError.value = ''
  try {
    const result = await send('memebot/archive/works', routeState.value.search || undefined) as Work[]
    if (listRequests.isCurrent(request)) works.value = result
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
    const result = await send('memebot/archive/work/details', id) as WorkDetails
    if (detailRequests.isCurrent(request)) details.value = result
  } catch (cause) {
    if (detailRequests.isCurrent(request)) detailsError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (detailRequests.isCurrent(request)) detailsLoading.value = false
  }
}

function selectWork(work: Work) {
  replaceRoute({ selected: work.id })
}

function openCreate() {
  rememberFocus()
  formMode.value = 'create'
  formVisible.value = true
}

function openEdit() {
  if (!selectedWork.value) return
  rememberFocus()
  formMode.value = 'edit'
  formVisible.value = true
}

function openPreview() {
  if (!selectedWork.value) return
  rememberFocus()
  previewVisible.value = true
}

function rememberFocus() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
}

function restoreDialogFocus() {
  void nextTick(() => {
    const target = returnFocus?.isConnected ? returnFocus : focusAnchor.value
    target?.focus()
  })
}

async function loadPapers(request: number) {
  papersLoading.value = true
  try {
    const result = await send('memebot/archive/papers') as NewspaperIssue[]
    if (request !== appearanceRequest) return false
    papers.value = result
    return true
  } catch (cause) {
    if (request !== appearanceRequest) return false
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`Newspaper Issues 加载失败：${reason}`)
    throw cause
  } finally {
    if (request === appearanceRequest) papersLoading.value = false
  }
}

async function openAppearance(item?: WorkPaper) {
  const work = details.value?.work
  if (!work) return
  rememberFocus()
  const request = ++appearanceRequest
  const selection = workSelection
  appearanceWork.value = work
  appearancePaperIds.value = details.value?.papers.map(entry => entry.paper.id) ?? []
  appearance.value = item
  try {
    if (await loadPapers(request) && selection === workSelection) appearanceVisible.value = true
    else if (request === appearanceRequest) restoreAppearanceFocus()
  } catch {
    restoreAppearanceFocus()
  }
}

function restoreAppearanceFocus() {
  appearanceRequest += 1
  papersLoading.value = false
  appearance.value = undefined
  appearanceWork.value = undefined
  appearancePaperIds.value = []
  restoreDialogFocus()
}

async function saveAppearance(value: AppearanceFormValue) {
  const work = appearanceWork.value
  if (!work) throw new Error('请选择要管理刊载信息的 Work。')
  try {
    await send('memebot/archive/appearance/save', value.paperId, {
      workId: work.id,
      page: value.page || undefined,
      section: value.section || undefined,
      displayOrder: value.displayOrder,
    })
    message.success(`已保存 ${work.id} 与 ${value.paperId} 的 Publication Appearance。`)
    appearanceAction.value = 'Publication Appearance 已保存。'
    await Promise.all([loadWorks(), loadDetails()])
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`Publication Appearance 保存失败：${reason}`)
    throw cause
  }
}

async function removeAppearance(item: WorkPaper) {
  const work = details.value?.work
  if (!work) return
  rememberFocus()
  try {
    await messageBox.confirm(
      `将解除 ${work.id} 与 ${item.paper.id} 的 Publication Appearance；两个 Archive Identifier 都会保留。`,
      '解除刊载关联？',
      { confirmButtonText: '解除关联', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    restoreAppearanceFocus()
    return
  }
  try {
    await send('memebot/archive/appearance/remove', item.paper.id, work.id)
    message.success(`已解除 ${work.id} 与 ${item.paper.id} 的 Publication Appearance。`)
    appearanceAction.value = 'Publication Appearance 已解除。'
    await Promise.all([loadWorks(), loadDetails()])
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`Publication Appearance 解除失败：${reason}`)
    appearanceAction.value = `Publication Appearance 解除失败：${reason}`
  } finally {
    restoreAppearanceFocus()
  }
}

function fileAttachment(file: File) {
  return new Promise<ConsoleAttachment>((resolveAttachment, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolveAttachment({
      filename: file.name,
      contentType: file.type || 'application/zip',
      data: String(reader.result),
    })
    reader.onerror = () => reject(reader.error ?? new Error('无法读取 ZIP Work Package'))
    reader.readAsDataURL(file)
  })
}

async function saveWork(value: WorkFormValue) {
  try {
    if (formMode.value === 'create') {
      const created = await send('memebot/archive/work/create', {
        title: value.title,
        author: value.author,
        description: value.description,
        attachment: await fileAttachment(value.file!),
      }) as Work
      message.success(`已创建 ${created.id}。`)
      await loadWorks()
      replaceRoute({ selected: created.id })
      return
    }

    const work = selectedWork.value
    if (!work) throw new Error('请选择要编辑的 Work。')
    await send('memebot/archive/work/edit', work.id, {
      title: value.title,
      author: value.author,
      description: value.description,
    })
    if (value.file) await send('memebot/archive/work/upload', work.id, await fileAttachment(value.file))
    message.success(`已更新 ${work.id}${value.file ? ' 及其 ZIP Work Package' : ''}。`)
    await Promise.all([loadWorks(), loadDetails()])
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`${formMode.value === 'create' ? '创建' : '更新'} Work 失败：${reason}`)
    throw cause
  }
}

function saveDownload(result: DownloadResult) {
  const anchor = document.createElement('a')
  anchor.href = `data:${result.contentType ?? 'application/octet-stream'};base64,${result.data}`
  anchor.download = result.filename
  anchor.click()
}

async function downloadPackage(work: Work) {
  try {
    saveDownload(await send('memebot/archive/work/download', work.id) as DownloadResult)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    message.error(`原始 ZIP Work Package 下载失败：${reason}`)
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
  replaceRoute({ pageSize: value as WorkPageSize, page: 1 })
}
</script>

<template>
  <section aria-labelledby="works-heading">
    <div class="works-heading">
      <div>
        <h2 id="works-heading">收录作品</h2>
        <p>查找、维护并安全浏览 ZIP Work Package；原始 ZIP 始终是唯一权威附件。</p>
      </div>
      <el-button type="primary" @click="openCreate">创建 Work</el-button>
    </div>

    <div class="works-search" role="search">
      <el-input
        v-model="searchInput"
        clearable
        aria-label="搜索 Works"
        placeholder="按标题、作者或描述搜索"
      />
      <span aria-live="polite">{{ loading ? '正在搜索…' : `共 ${works.length} 项` }}</span>
    </div>

    <el-alert v-if="listError" :title="`Works 加载失败：${listError}`" type="error" show-icon :closable="false" />

    <div v-loading="loading" class="works-results">
      <div class="desktop-results">
        <el-table
          :data="visibleWorks"
          row-key="id"
          highlight-current-row
          :current-row-key="routeState.selected"
          empty-text="没有匹配的 Works"
          aria-label="Works 搜索结果"
          @row-click="selectWork"
        >
          <el-table-column prop="id" label="编号" width="90" />
          <el-table-column prop="title" label="标题" min-width="180" />
          <el-table-column prop="author" label="作者" min-width="140" />
          <el-table-column label="权威附件" min-width="160">
            <template #default="scope">{{ formatBytes(scope.row.attachment?.size) }}</template>
          </el-table-column>
          <el-table-column prop="backupState" label="备份" width="100" />
          <el-table-column label="操作" width="120">
            <template #default="scope">
              <el-button link type="primary" @click.stop="selectWork(scope.row)">查看详情</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <div class="mobile-results" aria-label="Works 搜索结果卡片">
        <button
          v-for="work in visibleWorks"
          :key="work.id"
          type="button"
          class="work-card"
          :class="{ selected: routeState.selected === work.id }"
          @click="selectWork(work)"
        >
          <strong>{{ work.id }} · {{ work.title }}</strong>
          <span>{{ work.author }}</span>
          <small>{{ formatBytes(work.attachment?.size) }} · 备份 {{ work.backupState ?? 'disabled' }}</small>
        </button>
      </div>
    </div>

    <el-pagination
      class="works-pagination"
      background
      layout="total, sizes, prev, pager, next"
      :total="works.length"
      :current-page="routeState.page"
      :page-size="routeState.pageSize"
      :page-sizes="[20, 50, 100]"
      @update:current-page="replaceRoute({ page: $event })"
      @update:page-size="changePageSize"
    />

    <k-card v-if="routeState.selected" class="work-details" title="Work 详情" v-loading="detailsLoading">
      <el-alert v-if="detailsError" :title="`详情加载失败：${detailsError}`" type="error" show-icon :closable="false" />
      <template v-else-if="details">
        <div class="details-heading">
          <div>
            <h3 ref="focusAnchor" tabindex="-1">{{ details.work.id }} · {{ details.work.title }}</h3>
            <p>{{ details.work.author }}</p>
          </div>
          <div class="details-actions">
            <el-button @click="openEdit">编辑或替换 ZIP</el-button>
            <el-button @click="downloadPackage(details.work)">下载原始 ZIP</el-button>
            <el-button type="primary" @click="openPreview">浏览安全预览</el-button>
          </div>
        </div>
        <p v-if="details.work.description">{{ details.work.description }}</p>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="权威附件">{{ details.work.attachment?.relativePath ?? '无' }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{ formatBytes(details.work.attachment?.size) }}</el-descriptions-item>
          <el-descriptions-item label="备份状态">{{ details.work.backupState ?? 'disabled' }}</el-descriptions-item>
          <el-descriptions-item label="校验和">{{ details.work.attachment?.checksum ?? '无' }}</el-descriptions-item>
        </el-descriptions>
        <div class="appearance-heading">
          <h4>刊载于</h4>
          <el-button type="primary" :loading="papersLoading" @click="openAppearance()">添加刊载关联</el-button>
        </div>
        <p class="sr-status" aria-live="polite">{{ appearanceAction }}</p>
        <el-empty v-if="!details.papers.length" description="尚无 Publication Appearance" />
        <ul v-else class="appearance-list">
          <li v-for="item in details.papers" :key="item.paper.id">
            <span>
              {{ item.paper.id }} · {{ item.paper.month }} · {{ item.paper.title }}
              <span v-if="item.page"> · 第 {{ item.page }} 页</span>
              <span v-if="item.section"> · {{ item.section }}</span>
              · 顺序 {{ item.displayOrder }}
            </span>
            <span class="appearance-actions">
              <el-button link type="primary" @click="openAppearance(item)">编辑</el-button>
              <el-button link type="danger" @click="removeAppearance(item)">解除关联</el-button>
            </span>
          </li>
        </ul>
      </template>
    </k-card>

    <WorkFormDialog
      v-model="formVisible"
      :mode="formMode"
      :work="formMode === 'edit' ? selectedWork : undefined"
      :submit="saveWork"
      @closed="restoreDialogFocus"
    />
    <WorkPreviewDialog
      v-model="previewVisible"
      :work="selectedWork"
      :download-package="downloadPackage"
      @closed="restoreDialogFocus"
    />
    <AppearanceFormDialog
      v-model="appearanceVisible"
      :work="appearanceWork"
      :papers="selectablePapers"
      :appearance="appearance"
      :submit="saveAppearance"
      @closed="restoreAppearanceFocus"
    />
  </section>
</template>

<style scoped>
.works-heading,
.details-heading,
.details-actions,
.appearance-heading,
.works-search {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.works-heading h2,
.details-heading h3 {
  margin-bottom: 4px;
}

.works-heading p,
.details-heading p {
  margin: 0;
  color: var(--fg2);
}

.works-search {
  margin: 20px 0 12px;
}

.works-search :deep(.el-input) {
  max-width: 520px;
}

.mobile-results {
  display: none;
}

.work-card {
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

.work-card.selected {
  border-color: var(--k-color-primary);
}

.work-card small {
  color: var(--fg2);
}

.works-pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

.work-details {
  margin-top: 24px;
}

.work-details :deep(.el-descriptions__content) {
  overflow-wrap: anywhere;
}

.details-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.appearance-list {
  padding: 0;
  line-height: 1.8;
  list-style: none;
}

.appearance-list li,
.appearance-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.appearance-heading {
  margin-top: 20px;
}

.appearance-heading h4 {
  margin: 0;
}

.sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 767px) {
  .desktop-results {
    display: none;
  }

  .mobile-results {
    display: grid;
    gap: 10px;
  }

  .works-heading,
  .details-heading,
  .works-search {
    align-items: stretch;
    flex-direction: column;
  }

  .works-search :deep(.el-input) {
    max-width: none;
  }

  .work-details :deep(.el-descriptions__table) {
    table-layout: fixed;
  }

  .appearance-list li {
    align-items: flex-start;
    flex-direction: column;
  }

  .works-pagination {
    justify-content: center;
  }
}
</style>
