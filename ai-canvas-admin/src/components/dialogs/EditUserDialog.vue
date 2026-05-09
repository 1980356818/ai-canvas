<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'updated'): void
}>()

const username = ref('')
const email = ref('')

watch(
  () => props.user,
  (val) => {
    if (val) {
      username.value = val.username || ''
      email.value = val.email || ''
    }
  },
)

async function doUpdate() {
  if (!props.user) return
  if (!username.value.trim()) {
    ElMessage.warning('用户名不能为空')
    return
  }
  try {
    await adminApi.editUser({
      userId: props.user.id,
      username: username.value.trim(),
      email: email.value.trim(),
    })
    ElMessage.success('用户信息已更新')
    emit('update:modelValue', false)
    emit('updated')
  } catch {}
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="编辑用户信息"
    width="440"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="70px">
      <el-form-item label="用户名">
        <el-input v-model="username" placeholder="请输入用户名" />
      </el-form-item>
      <el-form-item label="邮箱">
        <el-input v-model="email" placeholder="请输入邮箱（可选）" clearable />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="doUpdate">保存</el-button>
    </template>
  </el-dialog>
</template>
