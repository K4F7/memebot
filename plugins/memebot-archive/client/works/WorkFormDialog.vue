<script setup lang="ts">
import { messageBox } from '@koishijs/client'
import { computed, ref, watch } from 'vue'

import type { Work, WorkFormValue } from './types'

const props = defineProps<{
  modelValue: boolean
  mode: 'create' | 'edit'
  work?: Work
  submit: (value: WorkFormValue) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const title = ref('')
const author = ref('')
const description = ref('')
const file = ref<File>()
const submitting = ref(false)
const formError = ref('')
const uploadKey = ref(0)
const initial = ref({ title: '', author: '', description: '' })

const dialogTitle = computed(() => props.mode === 'create' ? '创建 Work' : `编辑 ${props.work?.id ?? 'Work'}`)
const dirty = computed(() => title.value !== initial.value.title
  || author.value !== initial.value.author
  || description.value !== initial.value.description
  || !!file.value)

function reset() {
  const values = {
    title: props.mode === 'edit' ? props.work?.title ?? '' : '',
    author: props.mode === 'edit' ? props.work?.author ?? '' : '',
    description: props.mode === 'edit' ? props.work?.description ?? '' : '',
  }
  title.value = values.title
  author.value = values.author
  description.value = values.description
  initial.value = values
  file.value = undefined
  formError.value = ''
  uploadKey.value += 1
}

watch(() => [props.modelValue, props.mode, props.work?.id] as const, ([visible]) => {
  if (visible) reset()
}, { immediate: true })

async function allowClose() {
  if (!dirty.value || submitting.value) return !submitting.value
  try {
    await messageBox.confirm('未保存的 Work 表单内容将丢失。', '放弃更改？', {
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
  if (!title.value.trim() || !author.value.trim()) {
    formError.value = '标题和作者不能为空。'
    return
  }
  if (props.mode === 'create' && !file.value) {
    formError.value = '创建 Work 必须选择一个 ZIP Work Package。'
    return
  }
  submitting.value = true
  formError.value = ''
  try {
    await props.submit({
      title: title.value.trim(),
      author: author.value.trim(),
      description: description.value.trim(),
      file: file.value,
    })
    initial.value = { title: title.value, author: author.value, description: description.value }
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
    width="min(640px, 92vw)"
    :before-close="beforeClose"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="标题" required>
        <el-input v-model="title" maxlength="160" show-word-limit />
      </el-form-item>
      <el-form-item label="作者" required>
        <el-input v-model="author" maxlength="120" show-word-limit />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="description" type="textarea" :rows="5" maxlength="2000" show-word-limit />
      </el-form-item>
      <el-form-item :label="mode === 'create' ? 'ZIP Work Package' : '替换 ZIP Work Package（可选）'">
        <el-upload
          :key="uploadKey"
          accept=".zip,application/zip"
          :auto-upload="false"
          :limit="1"
          :on-change="selectFile"
          :on-remove="removeFile"
        >
          <el-button>选择 ZIP</el-button>
          <template #tip>
            <div class="upload-tip">ZIP 是唯一权威附件；派生预览不会替代原包。</div>
          </template>
        </el-upload>
      </el-form-item>
      <el-alert v-if="formError" :title="formError" type="error" show-icon :closable="false" />
    </el-form>

    <template #footer>
      <el-button :disabled="submitting" @click="requestClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="save">
        {{ mode === 'create' ? '创建并上传' : '保存更改' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.upload-tip {
  color: var(--fg2);
  line-height: 1.5;
}
</style>
