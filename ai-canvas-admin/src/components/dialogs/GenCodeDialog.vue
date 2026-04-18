<script setup lang="ts">
import { reactive, ref } from 'vue'
import { adminApi } from '@/api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'generated', result: { count: number; batchNo: string; codes: string[] }): void
}>()

const form = reactive({ count: 10, days: 30, validDays: 180, remark: '' })
const loading = ref(false)

async function doGenerate() {
  loading.value = true
  try {
    const result = await adminApi.generateCodes(form)
    emit('generated', result)
  } catch {} finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="批量生成兑换码"
    width="440"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="100px">
      <el-form-item label="数量">
        <el-input-number v-model="form.count" :min="1" :max="1000" />
      </el-form-item>
      <el-form-item label="会员天数">
        <el-input-number v-model="form.days" :min="1" />
      </el-form-item>
      <el-form-item label="有效期(天)">
        <el-input-number v-model="form.validDays" :min="0" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" placeholder="如: 推广活动" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="doGenerate">生成</el-button>
    </template>
  </el-dialog>
</template>
