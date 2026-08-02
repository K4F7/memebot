<script setup lang="ts">
import { message, send } from '@koishijs/client'
import { computed, ref, watch } from 'vue'

import { LatestRequest } from './state'
import type { DownloadResult, Work, WorkPreviewEntry, WorkPreviewResult } from './types'

const props = defineProps<{
  modelValue: boolean
  work?: Work
  downloadPackage: (work: Work) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const tree = ref<WorkPreviewEntry[]>([])
const treeLoading = ref(false)
const treeError = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const selected = ref<WorkPreviewEntry>()
const preview = ref<WorkPreviewResult>()
const treeRequests = new LatestRequest()
const previewRequests = new LatestRequest()

const previewUrl = computed(() => preview.value?.data && preview.value.contentType
  ? `data:${preview.value.contentType};base64,${preview.value.data}`
  : '')

watch(() => props.work?.id, () => reset())

function reset() {
  treeRequests.start()
  previewRequests.start()
  tree.value = []
  treeLoading.value = false
  treeError.value = ''
  previewLoading.value = false
  previewError.value = ''
  selected.value = undefined
  preview.value = undefined
}

async function loadTree() {
  reset()
  if (!props.work) return
  const request = treeRequests.start()
  treeLoading.value = true
  try {
    const result = await send('memebot/archive/work/tree', props.work.id) as WorkPreviewEntry[]
    if (treeRequests.isCurrent(request)) tree.value = result
  } catch (cause) {
    if (treeRequests.isCurrent(request)) treeError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (treeRequests.isCurrent(request)) treeLoading.value = false
  }
}

async function loadPreview(entry: WorkPreviewEntry) {
  if (!props.work) return
  selected.value = entry
  preview.value = undefined
  previewError.value = ''
  if (!entry.previewable) return
  const request = previewRequests.start()
  previewLoading.value = true
  try {
    const result = await send('memebot/archive/work/preview', props.work.id, entry.path) as WorkPreviewResult
    if (previewRequests.isCurrent(request)) preview.value = result
  } catch (cause) {
    if (previewRequests.isCurrent(request)) previewError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (previewRequests.isCurrent(request)) previewLoading.value = false
  }
}

function saveDownload(result: DownloadResult) {
  const anchor = document.createElement('a')
  anchor.href = `data:${result.contentType ?? 'application/octet-stream'};base64,${result.data}`
  anchor.download = result.filename
  anchor.click()
}

async function downloadDerived(entry: WorkPreviewEntry) {
  if (!props.work) return
  try {
    saveDownload(await send('memebot/archive/work/file', props.work.id, entry.path) as DownloadResult)
  } catch (cause) {
    message.error(`派生文件下载失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

async function downloadOriginal() {
  if (!props.work) return
  try {
    await props.downloadPackage(props.work)
  } catch {
    // The parent reports the integrated Koishi message.
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    fullscreen
    :title="work ? `${work.id} ${work.title} · 安全派生预览` : '安全派生预览'"
    @open="loadTree"
    @closed="reset"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="preview-toolbar">
      <p>预览内容仅在这里按需加载；ZIP Work Package 始终是唯一权威附件。</p>
      <el-button :disabled="!work" @click="downloadOriginal">下载原始 ZIP</el-button>
    </div>

    <el-alert
      v-if="treeError"
      :title="`派生预览不可用：${treeError}`"
      description="原始 Work Package 仍可下载，不会由派生内容替代。"
      type="error"
      show-icon
      :closable="false"
    />

    <div v-loading="treeLoading" class="preview-layout">
      <section class="preview-tree" aria-label="Work Package 文件树">
        <el-empty v-if="!treeLoading && !tree.length && !treeError" description="没有可浏览的派生文件" />
        <button
          v-for="entry in tree"
          :key="entry.path"
          type="button"
          class="tree-entry"
          :class="{ selected: selected?.path === entry.path }"
          @click="loadPreview(entry)"
        >
          <span>{{ entry.path }}</span>
          <small>{{ entry.kind }} · {{ entry.size }} bytes</small>
        </button>
      </section>

      <section v-loading="previewLoading" class="preview-content" aria-live="polite">
        <el-empty v-if="!selected" description="选择文件后按需预览" />

        <template v-else>
          <header class="preview-file-heading">
            <strong>{{ selected.path }}</strong>
            <el-button @click="downloadDerived(selected)">下载此文件</el-button>
          </header>

          <el-alert
            v-if="previewError"
            :title="`预览失败：${previewError}`"
            description="你仍可下载原始 ZIP Work Package。"
            type="error"
            show-icon
            :closable="false"
          />
          <el-alert
            v-else-if="!selected.previewable"
            title="此文件类型不支持安全预览"
            description="可下载此派生文件，或下载原始 ZIP Work Package。"
            type="info"
            show-icon
            :closable="false"
          />
          <pre v-else-if="preview?.kind === 'text'" class="text-preview">{{ preview.text }}</pre>
          <iframe
            v-else-if="preview?.kind === 'web'"
            class="frame-preview"
            :srcdoc="preview.text"
            sandbox="allow-downloads"
            title="受限 Web 预览"
          />
          <img v-else-if="preview?.kind === 'image'" class="media-preview" :src="previewUrl" alt="派生图片预览" />
          <audio v-else-if="preview?.kind === 'audio'" class="audio-preview" :src="previewUrl" controls />
          <video v-else-if="preview?.kind === 'video'" class="media-preview" :src="previewUrl" controls />
          <iframe
            v-else-if="preview?.kind === 'pdf'"
            class="frame-preview"
            :src="previewUrl"
            sandbox="allow-downloads"
            title="派生 PDF 预览"
          />
        </template>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.preview-toolbar,
.preview-file-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.preview-toolbar p {
  color: var(--fg2);
}

.preview-layout {
  display: grid;
  grid-template-columns: minmax(240px, 28%) 1fr;
  gap: 20px;
  min-height: 70vh;
  margin-top: 16px;
}

.preview-tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  border-right: 1px solid var(--k-color-divider);
  padding-right: 16px;
}

.tree-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  color: inherit;
  text-align: left;
  background: var(--k-card-bg);
  border: 1px solid var(--k-color-divider);
  border-radius: 6px;
  cursor: pointer;
}

.tree-entry.selected {
  border-color: var(--k-color-primary);
}

.tree-entry small {
  color: var(--fg2);
}

.preview-content {
  min-width: 0;
}

.text-preview {
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.frame-preview {
  width: 100%;
  height: 70vh;
  border: 1px solid var(--k-color-divider);
}

.media-preview {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  margin: 16px auto;
}

.audio-preview {
  width: 100%;
  margin-top: 16px;
}

@media (max-width: 720px) {
  .preview-layout {
    grid-template-columns: 1fr;
  }

  .preview-tree {
    max-height: 32vh;
    border-right: 0;
    border-bottom: 1px solid var(--k-color-divider);
    padding-right: 0;
    padding-bottom: 16px;
  }
}
</style>
