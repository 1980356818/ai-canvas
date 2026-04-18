<script setup lang="ts">
import { ElMessage } from 'element-plus'

const props = defineProps<{
  modelValue: boolean
  result: { count: number; batchNo: string; codes: string[] }
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

function copyAll() {
  navigator.clipboard.writeText(props.result.codes.join('\n'))
  ElMessage.success('已复制')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="生成完成"
    width="520"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      :title="`成功生成 ${result.count} 个兑换码，批次号: ${result.batchNo}`"
      type="success"
      :closable="false"
      style="margin-bottom: 12px"
    />
    <el-input
      type="textarea"
      :model-value="result.codes.join('\n')"
      :rows="10"
      readonly
    />
    <template #footer>
      <el-button @click="copyAll">复制全部</el-button>
      <el-button type="primary" @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>
