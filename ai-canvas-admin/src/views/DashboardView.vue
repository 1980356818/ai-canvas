<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminApi } from '@/api'

const dash = ref({
  totalUsers: 0,
  activeMembers: 0,
  todayRegistered: 0,
  total: 0,
  unused: 0,
  used: 0,
})

onMounted(async () => {
  try {
    dash.value = await adminApi.getDashboard()
  } catch {}
})
</script>

<template>
  <div class="stat-cards">
    <div class="stat-card">
      <div class="label">总用户数</div>
      <div class="value">{{ dash.totalUsers }}</div>
    </div>
    <div class="stat-card">
      <div class="label">活跃会员</div>
      <div class="value">{{ dash.activeMembers }}</div>
    </div>
    <div class="stat-card">
      <div class="label">今日注册</div>
      <div class="value">{{ dash.todayRegistered }}</div>
    </div>
    <div class="stat-card">
      <div class="label">兑换码总数</div>
      <div class="value">{{ dash.total }}</div>
    </div>
    <div class="stat-card">
      <div class="label">未使用</div>
      <div class="value" style="color: #67c23a">{{ dash.unused }}</div>
    </div>
    <div class="stat-card">
      <div class="label">已使用</div>
      <div class="value" style="color: #909399">{{ dash.used }}</div>
    </div>
  </div>
</template>
