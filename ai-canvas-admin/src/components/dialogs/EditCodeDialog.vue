<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean; code: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'updated'): void
}>()

const days = ref(30)
const remark = ref('')

watch(
  () => props.code,
  (val) => {
    if (val) {
      days.value = val.days
      remark.value = val.remark || ''
    }
  },
)

async function doUpdate() {
  if (!props.code) return
  try {
    await adminApi.updateCode(props.code.id, { days: days.value, remark: remark.value })
    ElMessage.success('更新成功')
    emit('update:modelValue', false)
    emit('updated')
  } catch {}
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="编辑兑换码"
    width="440"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div style="margin-bottom: 16px">
      兑换码：<b style="font-family: monospace">{{ code?.code }}</b>
    </div>
    <el-form label-width="70px">
      <el-form-item label="天数">
        <el-input-number v-model="days" :min="1" :max="9999" />
        <span style="margin-left: 8px; color: #909399">天</span>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="remark" placeholder="可选备注" clearable />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="doUpdate">保存</el-button>
    </template>
  </el-dialog>
</template>
