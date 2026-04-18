<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { adminApi } from '@/api'
import { formatTime, actionLabel, actionTagType } from '@/utils/format'

const logs = ref<{ records: any[]; total: number }>({ records: [], total: 0 })
const page = ref(1)
const loading = ref(false)

async function loadLogs() {
  loading.value = true
  try {
    logs.value = await adminApi.getOperationLogs(page.value, 20)
  } catch {} finally {
    loading.value = false
  }
}

onMounted(loadLogs)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">操作日志</span>
    </div>

    <el-table :data="logs.records" stripe v-loading="loading">
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="adminName" label="操作员" width="90" />
      <el-table-column label="操作" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="actionTagType(row.action)">
            {{ actionLabel(row.action) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="targetType" label="目标" width="80" />
      <el-table-column prop="targetId" label="目标ID" width="70" align="center" />
      <el-table-column prop="detail" label="详情" min-width="180" show-overflow-tooltip />
      <el-table-column prop="ip" label="IP" width="130" />
      <el-table-column label="时间" width="140">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="logs.total"
      layout="total, prev, pager, next"
      @current-change="loadLogs"
    />
  </div>
</template>
