<script setup lang="ts">
import { useAuth } from '@/composables/useAuth'

defineProps<{ title: string }>()
const emit = defineEmits<{
  (e: 'change-pwd'): void
}>()

const { adminUsername, logout } = useAuth()
</script>

<template>
  <div class="topbar">
    <span style="font-size: 15px; color: #606266">{{ title }}</span>
    <div class="topbar-right">
      <span style="font-size: 13px; color: #909399">{{ adminUsername }}</span>
      <el-button size="small" @click="emit('change-pwd')">改密码</el-button>
      <el-button size="small" type="danger" plain @click="logout">退出</el-button>
    </div>
  </div>
</template>
