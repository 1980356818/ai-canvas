<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'
import { configDesc } from '@/utils/format'

const configList = ref<{ key: string; value: string }[]>([])
const loading = ref(false)

async function loadConfig() {
  loading.value = true
  try {
    const m = await adminApi.getConfig()
    configList.value = Object.entries(m).map(([key, value]) => ({ key, value }))
  } catch {} finally {
    loading.value = false
  }
}

async function saveConfig(row: { key: string; value: string }) {
  try {
    await adminApi.saveConfig(row.key, row.value)
    ElMessage.success('已保存')
  } catch {}
}

onMounted(loadConfig)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">系统配置</span>
    </div>

    <el-table :data="configList" stripe v-loading="loading">
      <el-table-column prop="key" label="配置键" min-width="240" />
      <el-table-column label="配置值" min-width="200">
        <template #default="{ row }">
          <el-input v-model="row.value" size="small" />
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="220">
        <template #default="{ row }">
          <span style="color: #909399; font-size: 13px">{{ configDesc(row.key) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" align="center">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="saveConfig(row)">保存</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
