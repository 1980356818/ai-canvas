<script setup lang="ts">
import { ref, computed } from 'vue'
import AppSidebar from './AppSidebar.vue'
import AppTopbar from './AppTopbar.vue'
import DashboardView from '@/views/DashboardView.vue'
import UsersView from '@/views/UsersView.vue'
import CodesView from '@/views/CodesView.vue'
import TiersView from '@/views/TiersView.vue'
import ReleasesView from '@/views/ReleasesView.vue'
import TemplatesView from '@/views/TemplatesView.vue'
import CategoriesView from '@/views/CategoriesView.vue'
import ConfigView from '@/views/ConfigView.vue'
import LogsView from '@/views/LogsView.vue'

const emit = defineEmits<{ (e: 'change-pwd'): void }>()

const currentPage = ref('dashboard')

const pageTitles: Record<string, string> = {
  dashboard: '仪表盘',
  users: '用户管理',
  codes: '兑换码管理',
  tiers: '会员等级',
  releases: '版本管理',
  templates: '模板管理',
  categories: '分类管理',
  config: '系统配置',
  logs: '操作日志',
}

const pageTitle = computed(() => pageTitles[currentPage.value] || '')
</script>

<template>
  <div class="layout">
    <AppSidebar :current="currentPage" @navigate="currentPage = $event" />
    <div class="main-area">
      <AppTopbar :title="pageTitle" @change-pwd="emit('change-pwd')" />
      <div class="content">
        <DashboardView v-if="currentPage === 'dashboard'" />
        <UsersView v-else-if="currentPage === 'users'" />
        <CodesView v-else-if="currentPage === 'codes'" />
        <TiersView v-else-if="currentPage === 'tiers'" />
        <ReleasesView v-else-if="currentPage === 'releases'" />
        <TemplatesView v-else-if="currentPage === 'templates'" />
        <CategoriesView v-else-if="currentPage === 'categories'" />
        <ConfigView v-else-if="currentPage === 'config'" />
        <LogsView v-else-if="currentPage === 'logs'" />
      </div>
    </div>
  </div>
</template>
