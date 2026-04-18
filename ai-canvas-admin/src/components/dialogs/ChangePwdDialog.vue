<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuth } from '@/composables/useAuth'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; force: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'changed'): void
}>()

const { logout } = useAuth()
const form = reactive({ oldPassword: '', newPassword: '' })
const loading = ref(false)

async function handleSubmit() {
  if (!form.newPassword || form.newPassword.length < 6) {
    ElMessage.warning('新密码至少6位')
    return
  }
  loading.value = true
  try {
    await adminApi.changePassword(form)
    ElMessage.success('密码修改成功，请重新登录')
    emit('update:modelValue', false)
    emit('changed')
    logout()
  } catch {} finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="修改密码"
    width="400"
    :close-on-click-modal="false"
    :show-close="!force"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      v-if="force"
      title="首次登录，请修改默认密码"
      type="warning"
      :closable="false"
      style="margin-bottom: 16px"
    />
    <el-form :model="form">
      <el-form-item label="旧密码">
        <el-input v-model="form.oldPassword" type="password" show-password />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="form.newPassword" type="password" show-password />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button v-if="!force" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="handleSubmit">确认修改</el-button>
    </template>
  </el-dialog>
</template>
