<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { adminApi, type TierDef } from '@/api'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'generated', result: { count: number; batchNo: string; codes: string[]; tierName?: string }): void
}>()

const form = reactive({ count: 10, days: 30, validDays: 180, remark: '', tier: 'vip1' })
const loading = ref(false)
const tiers = ref<TierDef[]>([])

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    if (tiers.value.length === 0) {
      try {
        tiers.value = await adminApi.getTiers()
      } catch {}
    }
    // 默认选最低的正式版等级（rank>=10 里最小），否则第一个
    const official = tiers.value.filter((t) => t.tierRank >= 10).sort((a, b) => a.tierRank - b.tierRank)
    form.tier = official[0]?.tierKey || tiers.value[0]?.tierKey || 'vip1'
  },
)

async function doGenerate() {
  loading.value = true
  try {
    const result = await adminApi.generateCodes(form)
    emit('generated', result)
  } catch {
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="批量生成兑换码"
    width="460"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="100px">
      <el-form-item label="激活等级">
        <el-select v-model="form.tier" style="width: 100%" placeholder="选择该批激活码的等级">
          <el-option
            v-for="t in tiers"
            :key="t.tierKey"
            :label="t.isOfficial === 1 ? t.name : `${t.name}（试用）`"
            :value="t.tierKey"
          />
        </el-select>
      </el-form-item>
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
