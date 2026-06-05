<script setup lang="ts">
import { reactive, ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, type TierDef, type TierFeatures } from '@/api'
import { TEMPLATE_CATALOG } from '@/constants/templates'

// tier 为 null = 新建；否则编辑
const props = defineProps<{ modelValue: boolean; tier: TierDef | null }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'saved'): void
}>()

const isEdit = computed(() => !!props.tier)
const loading = ref(false)

const form = reactive({
  tierKey: '',
  name: '',
  tierRank: 10,
  isOfficial: true,
  templateMode: 'all' as 'all' | 'pick',
  templates: [] as string[],
  allowBlank: true,
  allowImport: true,
  maxProjects: 0,
  isActive: true,
})

function parseFeatures(raw: unknown): TierFeatures {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as TierFeatures
  try {
    return JSON.parse(raw as string) as TierFeatures
  } catch {
    return {}
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    if (props.tier) {
      const f = parseFeatures(props.tier.features)
      form.tierKey = props.tier.tierKey
      form.name = props.tier.name
      form.tierRank = props.tier.tierRank
      form.isOfficial = props.tier.isOfficial === 1
      form.isActive = props.tier.isActive === 1
      form.allowBlank = !!f.allowBlank
      form.allowImport = !!f.allowImport
      form.maxProjects = typeof f.maxProjects === 'number' ? f.maxProjects : 0
      if (f.templates === '*') {
        form.templateMode = 'all'
        form.templates = []
      } else {
        form.templateMode = 'pick'
        form.templates = Array.isArray(f.templates) ? f.templates : []
      }
    } else {
      form.tierKey = ''
      form.name = ''
      form.tierRank = 10
      form.isOfficial = true
      form.isActive = true
      form.allowBlank = true
      form.allowImport = true
      form.maxProjects = 0
      form.templateMode = 'all'
      form.templates = []
    }
  },
)

async function submit() {
  if (!isEdit.value && !form.tierKey.trim()) {
    ElMessage.warning('请填写等级标识')
    return
  }
  if (!form.name.trim()) {
    ElMessage.warning('请填写等级名称')
    return
  }
  if (form.templateMode === 'pick' && form.templates.length === 0) {
    ElMessage.warning('请至少勾选一个模板，或选"全部模板"')
    return
  }
  const features: TierFeatures = {
    templates: form.templateMode === 'all' ? '*' : form.templates,
    allowBlank: form.allowBlank,
    allowImport: form.allowImport,
    maxProjects: form.maxProjects,
  }
  loading.value = true
  try {
    if (isEdit.value && props.tier) {
      await adminApi.updateTier(props.tier.id, {
        name: form.name,
        tierRank: form.tierRank,
        isOfficial: form.isOfficial ? 1 : 0,
        features,
        isActive: form.isActive ? 1 : 0,
      })
    } else {
      await adminApi.createTier({
        tierKey: form.tierKey.trim(),
        name: form.name,
        tierRank: form.tierRank,
        isOfficial: form.isOfficial ? 1 : 0,
        features,
        isActive: form.isActive ? 1 : 0,
        sort: form.tierRank,
      })
    }
    ElMessage.success('已保存')
    emit('update:modelValue', false)
    emit('saved')
  } catch {
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="isEdit ? '编辑等级' : '新建等级'"
    width="620"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="110px">
      <el-form-item label="等级标识">
        <el-input
          v-model="form.tierKey"
          :disabled="isEdit"
          placeholder="如 vip1（用户/激活码引用，创建后不可改）"
        />
      </el-form-item>
      <el-form-item label="等级名称">
        <el-input v-model="form.name" placeholder="如 VIP1" />
      </el-form-item>
      <el-form-item label="等级序号">
        <el-input-number v-model="form.tierRank" :min="0" :step="10" controls-position="right" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px">
          越大越高；激活码只升不降按它比较（试用=0，VIP1=10，VIP2=20…）
        </span>
      </el-form-item>
      <el-form-item label="正式版">
        <el-switch v-model="form.isOfficial" />
      </el-form-item>

      <el-divider content-position="left">功能权限</el-divider>

      <el-form-item label="可用模板">
        <el-radio-group v-model="form.templateMode">
          <el-radio value="all">全部模板</el-radio>
          <el-radio value="pick">指定模板</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="form.templateMode === 'pick'" label=" ">
        <el-checkbox-group v-model="form.templates">
          <el-checkbox
            v-for="t in TEMPLATE_CATALOG"
            :key="t.id"
            :value="t.id"
            border
            style="margin: 0 8px 8px 0"
          >
            {{ t.name }}
          </el-checkbox>
        </el-checkbox-group>
      </el-form-item>

      <el-form-item label="空白/自由创作">
        <el-switch v-model="form.allowBlank" />
      </el-form-item>
      <el-form-item label="导入项目">
        <el-switch v-model="form.allowImport" />
      </el-form-item>
      <el-form-item label="项目数上限">
        <el-input-number v-model="form.maxProjects" :min="0" controls-position="right" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px">0 = 不限</span>
      </el-form-item>
      <el-form-item label="启用">
        <el-switch v-model="form.isActive" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>
