<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { adminApi, type TierDef, type TierFeatures } from '@/api'
import TierEditDialog from '@/components/dialogs/TierEditDialog.vue'

const tiers = ref<TierDef[]>([])
const loading = ref(false)
const editVisible = ref(false)
const editTier = ref<TierDef | null>(null)

function parseFeatures(raw: unknown): TierFeatures {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as TierFeatures
  try {
    return JSON.parse(raw as string) as TierFeatures
  } catch {
    return {}
  }
}

function templatesSummary(t: TierDef): string {
  const f = parseFeatures(t.features)
  if (f.templates === '*') return '全部模板'
  if (Array.isArray(f.templates)) return `${f.templates.length} 个模板`
  return '无'
}

function flag(t: TierDef, key: 'allowBlank' | 'allowImport'): boolean {
  return !!parseFeatures(t.features)[key]
}

async function load() {
  loading.value = true
  try {
    tiers.value = await adminApi.getTiers()
  } catch {
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editTier.value = null
  editVisible.value = true
}

function openEdit(row: TierDef) {
  editTier.value = row
  editVisible.value = true
}

async function toggle(row: TierDef) {
  try {
    await adminApi.toggleTier(row.id, row.isActive !== 1)
    ElMessage.success('操作成功')
    load()
  } catch {}
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">会员等级</span>
      <el-button type="primary" @click="openCreate">新建等级</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      style="margin-bottom: 12px"
      title="等级越高越优先，激活码只升不降。试用版的核心限制 = 只能用这里勾选的项目模板；空白/自由创作、导入也按开关控制。"
    />

    <el-table :data="tiers" stripe v-loading="loading">
      <el-table-column prop="tierRank" label="序号" width="70" align="center" />
      <el-table-column prop="name" label="名称" width="120" />
      <el-table-column prop="tierKey" label="标识" width="120" />
      <el-table-column label="类型" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="row.isOfficial === 1 ? 'warning' : 'info'" size="small">
            {{ row.isOfficial === 1 ? '正式版' : '试用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="可用模板" min-width="110">
        <template #default="{ row }">{{ templatesSummary(row) }}</template>
      </el-table-column>
      <el-table-column label="空白" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="flag(row, 'allowBlank') ? 'success' : 'info'">
            {{ flag(row, 'allowBlank') ? '✓' : '✗' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="导入" width="70" align="center">
        <template #default="{ row }">
          <el-tag size="small" :type="flag(row, 'allowImport') ? 'success' : 'info'">
            {{ flag(row, 'allowImport') ? '✓' : '✗' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80" align="center">
        <template #default="{ row }">
          <el-tag :type="row.isActive === 1 ? 'success' : 'info'" size="small">
            {{ row.isActive === 1 ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="170" align="center">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button
            size="small"
            :type="row.isActive === 1 ? 'danger' : 'success'"
            @click="toggle(row)"
          >
            {{ row.isActive === 1 ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <TierEditDialog v-model="editVisible" :tier="editTier" @saved="load" />
</template>
