<script setup lang="ts">
import { messageBox } from '@koishijs/client'
import { computed, ref, watch } from 'vue'

import type { NewspaperIssue } from '../issues/types'
import type { AppearanceFormValue, Work, WorkPaper } from './types'

const props = defineProps<{
  modelValue: boolean
  work?: Work
  papers: NewspaperIssue[]
  appearance?: WorkPaper
  submit: (value: AppearanceFormValue) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  closed: []
}>()

const paperId = ref('')
const page = ref('')
const section = ref('')
const displayOrder = ref(0)
const initial = ref({ paperId: '', page: '', section: '', displayOrder: 0 })
const submitting = ref(false)
const formError = ref('')

const editing = computed(() => !!props.appearance)
const dialogTitle = computed(() => editing.value
  ? `编辑 ${props.work?.id ?? 'Work'} 的刊载信息`
  : `关联 ${props.work?.id ?? 'Work'} 到 Newspaper Issue`)
const dirty = computed(() => paperId.value !== initial.value.paperId
  || page.value !== initial.value.page
  || section.value !== initial.value.section
  || displayOrder.value !== initial.value.displayOrder)

function reset() {
  const values = {
    paperId: props.appearance?.paper.id ?? '',
    page: props.appearance?.page ?? '',
    section: props.appearance?.section ?? '',
    displayOrder: props.appearance?.displayOrder ?? 0,
  }
  paperId.value = values.paperId
  page.value = values.page
  section.value = values.section
  displayOrder.value = values.displayOrder
  initial.value = values
  formError.value = ''
}

watch(() => [props.modelValue, props.appearance?.paper.id] as const, ([visible]) => {
  if (visible) reset()
}, { immediate: true })

async function allowClose() {
  if (!dirty.value || submitting.value) return !submitting.value
  try {
    await messageBox.confirm('未保存的 Publication Appearance 内容将丢失。', '放弃更改？', {
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

async function save() {
  if (!paperId.value) {
    formError.value = '请选择 Newspaper Issue。'
    return
  }
  if (!Number.isSafeInteger(displayOrder.value) || displayOrder.value < 0) {
    formError.value = '显示顺序必须是非负整数。'
    return
  }
  submitting.value = true
  formError.value = ''
  try {
    await props.submit({
      paperId: paperId.value,
      page: page.value.trim(),
      section: section.value.trim(),
      displayOrder: displayOrder.value,
    })
    initial.value = { paperId: paperId.value, page: page.value, section: section.value, displayOrder: displayOrder.value }
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
    width="min(600px, 92vw)"
    :before-close="beforeClose"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="emit('closed')"
  >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="Newspaper Issue" required>
        <el-select
          v-model="paperId"
          :disabled="editing || submitting"
          filterable
          placeholder="选择要刊载此 Work 的期数"
          no-data-text="没有可关联的 Newspaper Issue"
          aria-label="Newspaper Issue"
        >
          <el-option
            v-for="paper in papers"
            :key="paper.id"
            :label="`${paper.id} · ${paper.month} · ${paper.title}`"
            :value="paper.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="页码（可选）">
        <el-input v-model="page" :disabled="submitting" maxlength="40" placeholder="例如 12–13" />
      </el-form-item>
      <el-form-item label="栏目（可选）">
        <el-input v-model="section" :disabled="submitting" maxlength="120" placeholder="例如 专题" />
      </el-form-item>
      <el-form-item label="显示顺序" required>
        <el-input-number v-model="displayOrder" :disabled="submitting" :min="0" :step="1" step-strictly />
      </el-form-item>
      <div aria-live="assertive">
        <el-alert v-if="formError" :title="formError" type="error" show-icon :closable="false" />
      </div>
      <p class="sr-status" aria-live="polite">{{ submitting ? '正在保存 Publication Appearance…' : '' }}</p>
    </el-form>

    <template #footer>
      <el-button :disabled="submitting" @click="requestClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="save">保存关联</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:deep(.el-select) {
  width: 100%;
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
</style>
