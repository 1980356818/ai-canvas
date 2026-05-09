<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi } from '@/api'
import { formatTime, statusType, statusLabel } from '@/utils/format'
import GenCodeDialog from '@/components/dialogs/GenCodeDialog.vue'
import GenResultDialog from '@/components/dialogs/GenResultDialog.vue'
import EditCodeDialog from '@/components/dialogs/EditCodeDialog.vue'

const codes = ref<{ records: any[]; total: number }>({ records: [], total: 0 })
const page = ref(1)
const statusFilter = ref('')
const loading = ref(false)

const genVisible = ref(false)
const genResultVisible = ref(false)
const genResult = ref<{ count: number; batchNo: string; codes: string[] }>({
  count: 0,
  batchNo: '',
  codes: [],
})

const editVisible = ref(false)
const editCode = ref<any>(null)

function openEdit(row: any) {
  editCode.value = row
  editVisible.value = true
}

async function loadCodes() {
  loading.value = true
  try {
    codes.value = await adminApi.getRedeemCodes(page.value, 20, statusFilter.value || undefined)
  } catch {} finally {
    loading.value = false
  }
}

async function disableCode(row: any) {
  try {
    await ElMessageBox.confirm('确定要禁用此兑换码？', '确认')
    await adminApi.disableCode(row.id)
    ElMessage.success('已禁用')
    loadCodes()
  } catch {}
}

function onGenerated(result: { count: number; batchNo: string; codes: string[] }) {
  genResult.value = result
  genVisible.value = false
  genResultVisible.value = true
  loadCodes()
}

onMounted(loadCodes)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">兑换码管理</span>
      <div style="display: flex; gap: 8px; align-items: center">
        <el-select
          v-model="statusFilter"
          placeholder="全部状态"
          clearable
          style="width: 130px"
          @change="loadCodes"
        >
          <el-option label="未使用" value="unused" />
          <el-option label="已使用" value="used" />
          <el-option label="已禁用" value="disabled" />
          <el-option label="已过期" value="expired" />
        </el-select>
        <el-button type="primary" @click="genVisible = true">批量生成</el-button>
      </div>
    </div>

    <el-table :data="codes.records" stripe v-loading="loading">
      <el-table-column prop="code" label="兑换码" min-width="200" show-overflow-tooltip />
      <el-table-column prop="days" label="天数" width="60" align="center" />
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="有效期至" width="140">
        <template #default="{ row }">{{ formatTime(row.expireAt) }}</template>
      </el-table-column>
      <el-table-column label="使用者" min-width="140">
        <template #default="{ row }">
          <span v-if="row.usedBy">
            <el-tag size="small" type="info">ID:{{ row.usedBy }}</el-tag>
            {{ row.usedByName || '-' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="使用时间" width="140">
        <template #default="{ row }">{{ formatTime(row.usedAt) }}</template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="100" show-overflow-tooltip />
      <el-table-column label="操作" width="140" align="center">
        <template #default="{ row }">
          <template v-if="row.status === 'unused'">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" @click="disableCode(row)">禁用</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="codes.total"
      layout="total, prev, pager, next"
      @current-change="loadCodes"
    />
  </div>

  <GenCodeDialog v-model="genVisible" @generated="onGenerated" />
  <GenResultDialog v-model="genResultVisible" :result="genResult" />
  <EditCodeDialog v-model="editVisible" :code="editCode" @updated="loadCodes" />
</template>
