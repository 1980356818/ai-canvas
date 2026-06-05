<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, type TierDef } from '@/api'

const props = defineProps<{ modelValue: boolean; user: any }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'updated'): void
}>()

const tiers = ref<TierDef[]>([])
const tier = ref('')
const days = ref<number | undefined>(undefined)
const loading = ref(false)

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    if (tiers.value.length === 0) {
      try {
        tiers.value = await adminApi.getTiers()
      } catch {}
    }
    tier.value = props.user?.tier || tiers.value[0]?.tierKey || ''
    days.value = undefined
  },
)

async function submit() {
  if (!props.user || !tier.value) return
  loading.value = true
  try {
    await adminApi.setUserTier(props.user.id, tier.value, days.value)
    ElMessage.success('已设置等级')
    emit('update:modelValue', false)
    emit('updated')
  } catch {
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="设置用户等级"
    width="420"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p style="margin-bottom: 14px">
      用户：<b>{{ user?.username }}</b>
    </p>
    <el-form label-width="92px">
      <el-form-item label="等级">
        <el-select v-model="tier" style="width: 100%">
          <el-option
            v-for="t in tiers"
            :key="t.tierKey"
            :label="t.isOfficial === 1 ? t.name : `${t.name}（试用）`"
            :value="t.tierKey"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="赠送天数">
        <el-input-number v-model="days" :min="0" :max="9999" controls-position="right" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px">留空仅改等级、不改到期</span>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submit">确定</el-button>
    </template>
  </el-dialog>
</template>
