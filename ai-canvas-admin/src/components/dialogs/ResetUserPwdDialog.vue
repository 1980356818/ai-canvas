<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'reset'): void
}>()

const form = reactive({ newPassword: '' })
const loading = ref(false)

watch(() => props.modelValue, (v) => {
  if (v) form.newPassword = ''
})

async function handleSubmit() {
  if (!form.newPassword || form.newPassword.length < 6) {
    ElMessage.warning('新密码至少6位')
    return
  }
  loading.value = true
  try {
    await adminApi.resetUserPassword(props.user.id, form.newPassword)
    ElMessage.success('密码已重置')
    emit('update:modelValue', false)
    emit('reset')
  } catch {} finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="重置用户密码"
    width="420"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-descriptions :column="1" border size="small" style="margin-bottom: 16px">
      <el-descriptions-item label="用户名">{{ user?.username }}</el-descriptions-item>
      <el-descriptions-item label="邮箱">{{ user?.email || '-' }}</el-descriptions-item>
      <el-descriptions-item label="当前密码">
        <span style="color: #e6a23c; font-family: monospace">
          {{ user?.plainPassword || '(旧用户无记录)' }}
        </span>
      </el-descriptions-item>
    </el-descriptions>
    <el-form :model="form">
      <el-form-item label="新密码">
        <el-input
          v-model="form.newPassword"
          placeholder="请输入新密码（至少6位）"
          clearable
          show-password
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="handleSubmit">确认重置</el-button>
    </template>
  </el-dialog>
</template>
