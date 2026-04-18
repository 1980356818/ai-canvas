<script setup lang="ts">
import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()

const form = reactive({ newMachineCode: '', deviceInfo: '' })

async function doUnbind() {
  if (!form.newMachineCode) {
    ElMessage.warning('请填写新机器码')
    return
  }
  if (!props.user) return
  try {
    await adminApi.forceUnbind(props.user.id, form.newMachineCode, form.deviceInfo)
    ElMessage.success('解绑成功')
    emit('update:modelValue', false)
    form.newMachineCode = ''
    form.deviceInfo = ''
  } catch {}
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="强制解绑设备"
    width="440"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p style="margin-bottom: 12px">
      用户：<b>{{ user?.username }}</b>
    </p>
    <el-form-item label="新机器码">
      <el-input v-model="form.newMachineCode" placeholder="留空则仅解绑" />
    </el-form-item>
    <el-form-item label="设备信息">
      <el-input v-model="form.deviceInfo" placeholder="可选" />
    </el-form-item>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="doUnbind">确定解绑</el-button>
    </template>
  </el-dialog>
</template>
