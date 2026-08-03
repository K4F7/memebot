<script setup lang="ts">
import { send } from '@koishijs/client'
import { onBeforeUnmount, ref, watch } from 'vue'

import { LatestIssueRequest } from './state'
import type { NewspaperIssue, PdfResult } from './types'

const props = defineProps<{
  modelValue: boolean
  paper?: NewspaperIssue
  download: (paper: NewspaperIssue) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  closed: []
}>()

const loading = ref(false)
const previewError = ref('')
const previewUrl = ref('')
const requests = new LatestIssueRequest()

watch(() => props.paper?.id, () => {
  reset()
  if (props.modelValue) void loadPreview()
})
onBeforeUnmount(revokePreviewUrl)

function revokePreviewUrl() {
  if (!previewUrl.value) return
  URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

function createPreviewUrl(preview: PdfResult) {
  const binary = atob(preview.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes], { type: preview.contentType ?? 'application/pdf' }))
}

function reset() {
  requests.start()
  loading.value = false
  previewError.value = ''
  revokePreviewUrl()
}

async function loadPreview() {
  reset()
  if (!props.paper) return
  const request = requests.start()
  loading.value = true
  try {
    const preview = await send('memebot/archive/paper/preview', props.paper.id) as PdfResult
    if (requests.isCurrent(request)) previewUrl.value = createPreviewUrl(preview)
  } catch (cause) {
    if (requests.isCurrent(request)) previewError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (requests.isCurrent(request)) loading.value = false
  }
}

async function downloadPaper() {
  if (!props.paper) return
  try {
    await props.download(props.paper)
  } catch {
    // The parent reports the integrated Koishi message.
  }
}

function handleClosed() {
  reset()
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    fullscreen
    :title="paper ? `${paper.id} ${paper.title} · PDF 预览` : 'PDF 预览'"
    @open="loadPreview"
    @closed="handleClosed"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="preview-toolbar">
      <p>PDF 内容只在打开此对话框后加载；下载始终获取同一权威附件。</p>
      <el-button :disabled="!paper" @click="downloadPaper">下载权威 PDF</el-button>
    </div>
    <div v-loading="loading" class="pdf-preview" aria-live="polite">
      <el-alert
        v-if="previewError"
        :title="`PDF 预览失败：${previewError}`"
        description="你仍可尝试下载权威 PDF；预览不会替代原附件。"
        type="error"
        show-icon
        :closable="false"
      />
      <iframe
        v-else-if="previewUrl"
        :src="previewUrl"
        title="Newspaper Issue 权威 PDF 预览"
      />
      <el-empty v-else-if="!loading" description="没有可预览的 PDF" />
    </div>
  </el-dialog>
</template>

<style scoped>
.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.preview-toolbar p {
  color: var(--fg2);
}

.pdf-preview {
  min-height: 72vh;
  margin-top: 16px;
}

.pdf-preview iframe {
  width: 100%;
  height: 78vh;
  border: 1px solid var(--k-color-divider);
}

@media (max-width: 767px) {
  .preview-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .pdf-preview iframe {
    height: 72vh;
  }
}
</style>
