<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'adjusted'): void
}>()

const days = ref(30)

async function doAdjust() {
  if (!props.user) return
  try {
    await adminApi.adjustMembership(props.user.id, days.value)
    ElMessage.success('调整成功')
    emit('update:modelValue', false)
    emit('adjusted')
  } catch {}
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="调整会员时长"
    width="400"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p style="margin-bottom: 12px">
      用户：<b>{{ user?.username }}</b>
    </p>
    <el-input-number v-model="days" :min="-9999" :max="9999" />
    <span style="margin-left: 8px">天（负数为减少）</span>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="doAdjust">确定</el-button>
    </template>
  </el-dialog>
</template>
