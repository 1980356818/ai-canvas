<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'
import { formatTime, isExpired } from '@/utils/format'
import AdjustMemberDialog from '@/components/dialogs/AdjustMemberDialog.vue'
import ForceUnbindDialog from '@/components/dialogs/ForceUnbindDialog.vue'
import ResetUserPwdDialog from '@/components/dialogs/ResetUserPwdDialog.vue'

const users = ref<{ records: any[]; total: number }>({ records: [], total: 0 })
const page = ref(1)
const keyword = ref('')
const loading = ref(false)

const adjustVisible = ref(false)
const adjustUser = ref<any>(null)

const unbindVisible = ref(false)
const unbindUser = ref<any>(null)

const resetPwdVisible = ref(false)
const resetPwdUser = ref<any>(null)

async function loadUsers() {
  loading.value = true
  try {
    users.value = await adminApi.getUsers(page.value, 20, keyword.value || undefined)
  } catch {} finally {
    loading.value = false
  }
}

function openAdjust(row: any) {
  adjustUser.value = row
  adjustVisible.value = true
}

function openUnbind(row: any) {
  unbindUser.value = row
  unbindVisible.value = true
}

function openResetPwd(row: any) {
  resetPwdUser.value = row
  resetPwdVisible.value = true
}

async function toggleStatus(row: any) {
  try {
    await adminApi.setUserStatus(row.id, row.status === 1 ? 0 : 1)
    ElMessage.success('操作成功')
    loadUsers()
  } catch {}
}

onMounted(loadUsers)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">用户列表</span>
      <el-input
        v-model="keyword"
        placeholder="搜索用户名/邮箱"
        style="width: 240px"
        clearable
        @clear="loadUsers"
        @keyup.enter="loadUsers"
      >
        <template #append>
          <el-button @click="loadUsers">搜索</el-button>
        </template>
      </el-input>
    </div>

    <el-table :data="users.records" stripe v-loading="loading">
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="username" label="用户名" min-width="100" show-overflow-tooltip />
      <el-table-column prop="email" label="邮箱" min-width="140" show-overflow-tooltip />
      <el-table-column label="密码" min-width="120">
        <template #default="{ row }">
          <span v-if="row.plainPassword" style="font-family: monospace; font-size: 13px">
            {{ row.plainPassword }}
          </span>
          <span v-else style="color: #909399; font-size: 12px">无记录</span>
        </template>
      </el-table-column>
      <el-table-column label="会员到期" width="140">
        <template #default="{ row }">
          <span :style="{ color: isExpired(row.memberExpireAt) ? '#f56c6c' : '#67c23a' }">
            {{ formatTime(row.memberExpireAt) || '未激活' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="72" align="center">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'danger'" size="small">
            {{ row.status === 1 ? '正常' : '禁用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="注册时间" width="140">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="300" align="center">
        <template #default="{ row }">
          <el-button size="small" @click="openAdjust(row)">调整会员</el-button>
          <el-button size="small" type="primary" @click="openResetPwd(row)">改密码</el-button>
          <el-button
            size="small"
            :type="row.status === 1 ? 'danger' : 'success'"
            @click="toggleStatus(row)"
          >
            {{ row.status === 1 ? '禁用' : '启用' }}
          </el-button>
          <el-button size="small" type="warning" @click="openUnbind(row)">解绑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="users.total"
      layout="total, prev, pager, next"
      @current-change="loadUsers"
    />
  </div>

  <AdjustMemberDialog v-model="adjustVisible" :user="adjustUser" @adjusted="loadUsers" />
  <ForceUnbindDialog v-model="unbindVisible" :user="unbindUser" />
  <ResetUserPwdDialog v-model="resetPwdVisible" :user="resetPwdUser" @reset="loadUsers" />
</template>
