<script setup lang="ts">
import { router } from '@koishijs/client'
import { computed } from 'vue'

import LifecycleAuditRegion from '../regions/LifecycleAuditRegion.vue'
import NewspaperIssuesRegion from '../regions/NewspaperIssuesRegion.vue'
import StorageRecoveryRegion from '../regions/StorageRecoveryRegion.vue'
import WorksRegion from '../regions/WorksRegion.vue'
import { archiveTabs, normalizeArchiveTab, toArchiveTabQuery, type ArchiveTab } from '../tab-state'

const regions = {
  issues: NewspaperIssuesRegion,
  works: WorksRegion,
  storage: StorageRecoveryRegion,
  lifecycle: LifecycleAuditRegion,
} as const

const tab = computed<ArchiveTab>({
  get: () => normalizeArchiveTab(router.currentRoute.value.query.tab),
  set: (value) => {
    if (value === tab.value) return
    void router.push({
      path: router.currentRoute.value.path,
      query: toArchiveTabQuery(value),
    })
  },
})

const activeRegion = computed(() => regions[tab.value])
</script>

<template>
  <k-layout main="page-memebot-archive">
    <k-content>
      <header class="archive-heading">
        <h1>迷因档案</h1>
        <p>管理报纸期数、收录作品、存储恢复与生命周期审计。</p>
      </header>

      <el-tabs v-model="tab" class="archive-tabs">
        <el-tab-pane
          v-for="item in archiveTabs"
          :key="item.id"
          :label="item.label"
          :name="item.id"
        />
      </el-tabs>

      <component :is="activeRegion" />
    </k-content>
  </k-layout>
</template>

<style scoped>
.archive-heading {
  margin-bottom: 16px;
}

.archive-heading h1 {
  margin: 0 0 8px;
}

.archive-heading p {
  margin: 0;
  color: var(--fg2);
}

.archive-tabs {
  margin-bottom: 16px;
}
</style>
