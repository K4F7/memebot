<script setup lang="ts">
import { messageBox } from '@koishijs/client'
import { computed, ref, watch } from 'vue'

import type { IssueFormValue, NewspaperIssue } from './types'

const props = defineProps<{
  modelValue: boolean
  mode: 'create' | 'edit'
  paper?: NewspaperIssue
  submit: (value: IssueFormValue) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  closed: []
}>()

const month = ref('')
const issueNumber = ref('')
const title = ref('')
const description = ref('')
const sourceLink = ref('')
const file = ref<File>()
const submitting = ref(false)
const formError = ref('')
const uploadKey = ref(0)
const initial = ref({ month: '', issueNumber: '', title: '', description: '', sourceLink: '' })

const dialogTitle = computed(() => props.mode === 'create' ? '创建 Newspaper Issue' : `编辑 ${props.paper?.id ?? 'Newspaper Issue'}`)
const dirty = computed(() => month.value !== initial.value.month
  || issueNumber.value !== initial.value.issueNumber
  || title.value !== initial.value.title
  || description.value !== initial.value.description
  || sourceLink.value !== initial.value.sourceLink
  || !!file.value)

function reset() {
  const values = {
    month: props.mode === 'edit' ? props.paper?.month ?? '' : '',
    issueNumber: props.mode === 'edit' ? props.paper?.issueNumber ?? '' : '',
    title: props.mode === 'edit' ? props.paper?.title ?? '' : '',
    description: props.mode === 'edit' ? props.paper?.description ?? '' : '',
    sourceLink: props.mode === 'edit' ? props.paper?.sourceLink ?? '' : '',
  }
  month.value = values.month
  issueNumber.value = values.issueNumber
  title.value = values.title
  description.value = values.description
  sourceLink.value = values.sourceLink
  initial.value = values
  file.value = undefined
  formError.value = ''
  uploadKey.value += 1
}

watch(() => [props.modelValue, props.mode, props.paper?.id] as const, ([visible]) => {
  if (visible) reset()
}, { immediate: true })

async function allowClose() {
  if (submitting.value || !dirty.value) return true
  try {
    await messageBox.confirm('未保存的 Newspaper Issue 表单内容将丢失。', '放弃更改？', {
      confirmButtonText: '放弃更改',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

async function beforeClose(done: () => void) {
  if (await allowClose()) done()
}

async function requestClose() {
  if (await allowClose()) emit('update:modelValue', false)
}

function selectFile(upload: { raw?: File }) {
  file.value = upload.raw
  formError.value = ''
}

function removeFile() {
  file.value = undefined
}

async function save() {
  const normalized = {
    month: month.value,
    issueNumber: issueNumber.value.trim(),
    title: title.value.trim(),
    description: description.value.trim(),
    sourceLink: sourceLink.value.trim(),
  }
  if (!normalized.title || !normalized.issueNumber || !/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized.month)) {
    formError.value = '标题、期号不能为空，出刊月份必须使用 YYYY-MM。'
    return
  }
  if (normalized.sourceLink && !/^https?:\/\//i.test(normalized.sourceLink)) {
    formError.value = '来源链接必须以 http:// 或 https:// 开头。'
    return
  }
  if (props.mode === 'create' && !file.value) {
    formError.value = '创建 Newspaper Issue 必须选择一个 PDF。'
    return
  }
  submitting.value = true
  formError.value = ''
  try {
    await props.submit({ ...normalized, file: file.value })
    initial.value = normalized
    file.value = undefined
    emit('update:modelValue', false)
  } catch (cause) {
    formError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="min(680px, 94vw)"
    :before-close="beforeClose"
    @closed="emit('closed')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top" @submit.prevent="save">
      <div class="form-grid">
        <el-form-item label="出刊月份" required>
          <el-date-picker v-model="month" type="month" value-format="YYYY-MM" placeholder="选择月份" />
        </el-form-item>
        <el-form-item label="期号" required>
          <el-input v-model="issueNumber" maxlength="80" />
        </el-form-item>
      </div>
      <el-form-item label="标题" required>
        <el-input v-model="title" maxlength="160" show-word-limit />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="description" type="textarea" :rows="4" maxlength="2000" show-word-limit />
      </el-form-item>
      <el-form-item label="来源链接">
        <el-input v-model="sourceLink" type="url" placeholder="https://…" />
      </el-form-item>
      <el-form-item :label="mode === 'create' ? '权威 PDF 附件' : '替换权威 PDF（可选）'">
        <el-upload
          :key="uploadKey"
          accept=".pdf,application/pdf"
          :auto-upload="false"
          :limit="1"
          :on-change="selectFile"
          :on-remove="removeFile"
        >
          <el-button>选择 PDF</el-button>
          <template #tip><div class="upload-tip">PDF 是 Newspaper Issue 的权威附件；预览只会按需加载。</div></template>
        </el-upload>
      </el-form-item>
      <el-alert v-if="formError" :title="formError" type="error" show-icon :closable="false" />
    </el-form>

    <template #footer>
      <el-button @click="requestClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="save">
        {{ mode === 'create' ? '创建并上传' : '保存更改' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.form-grid :deep(.el-date-editor) {
  width: 100%;
}

.upload-tip {
  color: var(--fg2);
  line-height: 1.5;
}

@media (max-width: 600px) {
  .form-grid {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
