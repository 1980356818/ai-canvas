<script setup lang="ts">
import { DataAnalysis, User, Ticket, Setting, Document, Download, Medal } from '@element-plus/icons-vue'

defineProps<{ current: string }>()
const emit = defineEmits<{ (e: 'navigate', page: string): void }>()

const menus = [
  { key: 'dashboard', label: '仪表盘', icon: DataAnalysis },
  { key: 'users', label: '用户管理', icon: User },
  { key: 'codes', label: '兑换码管理', icon: Ticket },
  { key: 'tiers', label: '会员等级', icon: Medal },
  { key: 'releases', label: '版本管理', icon: Download },
  { key: 'config', label: '系统配置', icon: Setting },
  { key: 'logs', label: '操作日志', icon: Document },
]
</script>

<template>
  <div class="sidebar">
    <div class="sidebar-title">AI猫</div>
    <ul class="sidebar-menu">
      <li
        v-for="m in menus"
        :key="m.key"
        :class="{ active: current === m.key }"
        @click="emit('navigate', m.key)"
      >
        <el-icon><component :is="m.icon" /></el-icon>
        {{ m.label }}
      </li>
    </ul>
  </div>
</template>
