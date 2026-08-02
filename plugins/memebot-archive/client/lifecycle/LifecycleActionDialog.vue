<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { LifecycleAction, LifecycleTarget } from './types'

const props = defineProps<{
  modelValue: boolean
  action?: LifecycleAction
  target?: LifecycleTarget
  submit: (action: LifecycleAction, target: LifecycleTarget, typedIdentifier: string) => Promise<void>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  closed: []
}>()

const typedIdentifier = ref('')
const submitting = ref(false)
const actionError = ref('')

const exactIdentifierRequired = computed(() => props.action === 'purge' || props.action === 'anonymize')
const title = computed(() => {
  const names: Record<LifecycleAction, string> = {
    remove: '移除 Archive Item',
    restore: '恢复 Archive Item',
    purge: '永久清理 Archive Item',
    anonymize: '匿名化历史身份',
    restoreAttachment: '恢复已退役附件',
  }
  return props.action ? names[props.action] : '确认生命周期操作'
})
const confirmationReady = computed(() => !!props.target
  && (!exactIdentifierRequired.value || typedIdentifier.value === props.target.id))

watch(() => props.modelValue, (visible) => {
  if (visible) {
    typedIdentifier.value = ''
    actionError.value = ''
  }
})

async function confirmAction() {
  if (!props.action || !props.target || !confirmationReady.value) return
  submitting.value = true
  actionError.value = ''
  try {
    await props.submit(props.action, props.target, typedIdentifier.value)
    emit('update:modelValue', false)
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    submitting.value = false
  }
}

function beforeClose(done: () => void) {
  if (!submitting.value) done()
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(560px, 92vw)"
    :before-close="beforeClose"
    :close-on-click-modal="!submitting"
    :close-on-press-escape="!submitting"
    @closed="emit('closed')"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template v-if="target && action">
      <p>
        目标：<strong>{{ target.id }}</strong> · {{ target.label }}
      </p>
      <el-alert
        v-if="action === 'remove'"
        title="移除后普通搜索和附件立即不可用；30 天内仍可恢复。"
        type="warning"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else-if="action === 'restore'"
        title="将恢复相同 Archive Identifier，并保留 Publication Appearances。"
        type="info"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else-if="action === 'restoreAttachment'"
        title="当前附件会先退役，再恢复所选历史版本。"
        type="info"
        show-icon
        :closable="false"
      />
      <el-alert
        v-else
        :title="action === 'purge' ? '本地附件将永久删除；远端删除失败会保留为可重试工作。' : '身份字段将永久匿名化，历史操作记录仍保留。'"
        type="error"
        show-icon
        :closable="false"
      />

      <el-form v-if="exactIdentifierRequired" label-position="top" class="typed-confirmation">
        <el-form-item :label="`输入 ${target.id} 以确认`" required>
          <el-input
            v-model="typedIdentifier"
            :placeholder="target.id"
            autocomplete="off"
            @keyup.enter="confirmAction"
          />
        </el-form-item>
      </el-form>
      <el-alert v-if="actionError" :title="actionError" type="error" show-icon :closable="false" />
    </template>

    <template #footer>
      <el-button :disabled="submitting" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button
        :type="action === 'purge' || action === 'anonymize' ? 'danger' : 'primary'"
        :loading="submitting"
        :disabled="!confirmationReady"
        @click="confirmAction"
      >
        确认{{ title }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.typed-confirmation {
  margin-top: 18px;
}
</style>
