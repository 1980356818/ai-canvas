<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'unbound'): void
}>()

async function doUnbind() {
  if (!props.user) return
  try {
    await adminApi.forceUnbind(props.user.id)
    ElMessage.success('解绑成功，用户下次登录将自动绑定新设备')
    emit('update:modelValue', false)
    emit('unbound')
  } catch {}
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="解绑设备"
    width="400"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p>确定要解绑用户 <b>{{ user?.username }}</b> 的设备吗？</p>
    <p style="color: #909399; font-size: 13px; margin-top: 8px">
      解绑后，用户下次登录时将自动绑定到新设备。
    </p>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="warning" @click="doUnbind">确定解绑</el-button>
    </template>
  </el-dialog>
</template>
