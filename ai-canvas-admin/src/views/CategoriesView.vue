<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { adminApi, type AdminCategory } from '@/api'

const categories = ref<AdminCategory[]>([])
const loading = ref(false)

const dialogVisible = ref(false)
const creating = ref(false)
const form = ref({ key: '', label: '', sort: 0, minAppVersion: '' })

async function load() {
  loading.value = true
  try {
    categories.value = await adminApi.getCategories()
  } catch {
    // adminApi 已弹错
  } finally {
    loading.value = false
  }
}

function nextSort() {
  return categories.value.reduce((m, c) => Math.max(m, c.sort), -1) + 1
}

function openCreate() {
  creating.value = true
  form.value = { key: '', label: '', sort: nextSort(), minAppVersion: '' }
  dialogVisible.value = true
}

function openEdit(row: AdminCategory) {
  creating.value = false
  form.value = { key: row.key, label: row.label, sort: row.sort, minAppVersion: row.minAppVersion || '' }
  dialogVisible.value = true
}

async function submit() {
  if (!form.value.label.trim()) {
    ElMessage.warning('显示名必填')
    return
  }
  try {
    if (creating.value) {
      if (!form.value.key.trim()) {
        ElMessage.warning('slug (key) 必填')
        return
      }
      await adminApi.saveCategory({
        key: form.value.key.trim(),
        label: form.value.label.trim(),
        sort: form.value.sort,
        minAppVersion: form.value.minAppVersion || undefined,
      })
    } else {
      await adminApi.updateCategoryMeta(form.value.key, {
        label: form.value.label.trim(),
        sort: form.value.sort,
        minAppVersion: form.value.minAppVersion || undefined,
      })
    }
    ElMessage.success('已保存')
    dialogVisible.value = false
    load()
  } catch {}
}

async function toggleActive(row: AdminCategory) {
  try {
    if (row.isActive === 1) {
      await ElMessageBox.confirm(
        `停用分组「${row.label}」?停用后客户端不再显示该分类 Tab;该组下的模板会变成「未注册分类」（Tab 显示原 slug）。建议先把这些模板改派到别的分组。`,
        '确认停用',
        { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
      )
      await adminApi.deactivateCategory(row.key)
      ElMessage.success('已停用')
    } else {
      await adminApi.activateCategory(row.key)
      ElMessage.success('已启用')
    }
    load()
  } catch {}
}

async function removeCategory(row: AdminCategory) {
  try {
    await ElMessageBox.confirm(
      `永久删除分组「${row.label}」（${row.key}）？\n若仍有模板用此分类，它们会变成未注册 slug（Tab 显示原文）。请先在「模板管理」把这些模板改派到别的分组。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'error' },
    )
    await adminApi.deleteCategory(row.key)
    ElMessage.success('已删除')
    load()
  } catch {}
}

onMounted(load)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">分类管理</span>
      <el-button type="primary" @click="openCreate">新建分组</el-button>
    </div>

    <el-alert
      type="info"
      :closable="false"
      style="margin-bottom: 12px"
      title="组名 / 顺序 / 上下架云端可配，客户端拉新即生效（桌面端无需发版）。把模板归到某组 = 在「模板管理」里改该模板的「分类」为对应 slug。video / trial 是保留 slug（有特殊行为），可改名勿改 key。"
    />

    <el-table :data="categories" stripe v-loading="loading" row-key="key">
      <el-table-column prop="label" label="显示名" min-width="160" />
      <el-table-column prop="key" label="slug (key)" width="190">
        <template #default="{ row }"><span class="mono">{{ row.key }}</span></template>
      </el-table-column>
      <el-table-column prop="sort" label="排序" width="80" align="center" />
      <el-table-column label="状态" width="90" align="center">
        <template #default="{ row }">
          <el-tag :type="row.isActive === 1 ? 'success' : 'info'" size="small">
            {{ row.isActive === 1 ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="minAppVersion" label="最低版本" width="100" align="center">
        <template #default="{ row }">
          <span v-if="row.minAppVersion">{{ row.minAppVersion }}</span>
          <span v-else style="color: #c0c4cc">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="240" align="center" fixed="right">
        <template #default="{ row }">
          <el-button size="small" @click="openEdit(row)">编辑</el-button>
          <el-button
            size="small"
            :type="row.isActive === 1 ? 'warning' : 'success'"
            @click="toggleActive(row)"
          >
            {{ row.isActive === 1 ? '停用' : '启用' }}
          </el-button>
          <el-button size="small" type="danger" @click="removeCategory(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="dialogVisible" :title="creating ? '新建分组' : '编辑分组'" width="460px">
    <el-form label-width="100px">
      <el-form-item label="slug (key)" required>
        <el-input
          v-model="form.key"
          :disabled="!creating"
          placeholder="如 digital-human（英文/连字符，创建后不可改）"
        />
      </el-form-item>
      <el-form-item label="显示名" required>
        <el-input v-model="form.label" placeholder="如 数字人融合模板" />
      </el-form-item>
      <el-form-item label="排序">
        <el-input-number v-model="form.sort" :min="0" controls-position="right" />
        <span style="margin-left: 8px; color: #909399; font-size: 12px">越小越靠前</span>
      </el-form-item>
      <el-form-item label="最低版本">
        <el-input v-model="form.minAppVersion" placeholder="留空=全版本（预留）" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
