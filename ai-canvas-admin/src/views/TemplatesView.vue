<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import draggable from 'vuedraggable'
import { adminApi, type AdminTemplate, type AdminCategory } from '@/api'

/** 不在任一分组里的模板（category 为空或指向已删/停用分组）归到这里，绝不隐藏。 */
const ORPHAN = '__orphan__'

const cats = ref<AdminCategory[]>([])
const buckets = ref<Record<string, AdminTemplate[]>>({})
const activeKey = ref<string>('')
const loading = ref(false)
const total = ref(0)

// 当前分类的模板数组：可写 computed，给 vuedraggable v-model 用
const activeList = computed<AdminTemplate[]>({
  get: () => buckets.value[activeKey.value] ?? [],
  set: (v) => {
    buckets.value[activeKey.value] = v
  },
})

const orphanCount = computed(() => buckets.value[ORPHAN]?.length ?? 0)

async function load() {
  loading.value = true
  try {
    const [catList, tpls] = await Promise.all([adminApi.getCategories(), adminApi.getTemplates()])
    cats.value = catList
    total.value = tpls.length
    const known = new Set(catList.map((c) => c.key))
    const bk: Record<string, AdminTemplate[]> = { [ORPHAN]: [] }
    for (const c of catList) bk[c.key] = []
    for (const t of tpls) {
      const k = t.category && known.has(t.category) ? t.category : ORPHAN
      ;(bk[k] ??= []).push(t)
    }
    buckets.value = bk
    // activeKey 保持有效，否则落到第一个有模板的分类
    const valid =
      (activeKey.value === ORPHAN && orphanCount.value > 0) ||
      cats.value.some((c) => c.key === activeKey.value)
    if (!valid) {
      activeKey.value =
        cats.value.find((c) => (bk[c.key]?.length ?? 0) > 0)?.key ??
        cats.value[0]?.key ??
        (bk[ORPHAN].length ? ORPHAN : '')
    }
  } catch {
    // adminApi 已弹错
  } finally {
    loading.value = false
  }
}

/** 把所有桶按分类顺序拼平成完整 id 列表（孤儿桶垫底），整表重排时发给服务端。 */
function fullOrderedIds(): string[] {
  const ids: string[] = []
  for (const c of cats.value) for (const t of buckets.value[c.key] ?? []) ids.push(t.id)
  for (const t of buckets.value[ORPHAN] ?? []) ids.push(t.id)
  return ids
}

async function onTemplateDrop() {
  try {
    await adminApi.reorderTemplates(fullOrderedIds())
    ElMessage.success('排序已保存')
  } catch {
    load() // 回滚到服务端真实顺序
  }
}

async function onCatDrop() {
  try {
    await adminApi.reorderCategories(cats.value.map((c) => c.key))
    ElMessage.success('分类顺序已保存')
  } catch {
    load()
  }
}

// ── 卡片操作（沿用原表格逻辑，挪到卡片上）─────────────────────────────
const editVisible = ref(false)
const editing = ref<AdminTemplate | null>(null)
const editForm = ref({ name: '', description: '', category: '', minAppVersion: '' })

function openEdit(row: AdminTemplate) {
  editing.value = row
  editForm.value = {
    name: row.name,
    description: row.description || '',
    category: row.category || '',
    minAppVersion: row.minAppVersion || '',
  }
  editVisible.value = true
}

async function submitEdit() {
  if (!editing.value) return
  if (!editForm.value.name.trim()) {
    ElMessage.warning('名称必填')
    return
  }
  try {
    await adminApi.updateTemplateMeta(editing.value.id, {
      name: editForm.value.name,
      description: editForm.value.description || undefined,
      category: editForm.value.category || undefined,
      minAppVersion: editForm.value.minAppVersion || undefined,
    })
    ElMessage.success('已保存')
    editVisible.value = false
    load() // 改了分类要重新分桶
  } catch {}
}

async function toggleActive(row: AdminTemplate) {
  try {
    if (row.isActive === 1) {
      await ElMessageBox.confirm(
        `下架「${row.name}」?下架后客户端模板列表不再出现(已用它创建的项目不受影响)。`,
        '确认下架',
        { confirmButtonText: '下架', cancelButtonText: '取消', type: 'warning' },
      )
      await adminApi.deactivateTemplate(row.id)
      ElMessage.success('已下架')
    } else {
      await adminApi.activateTemplate(row.id)
      ElMessage.success('已上架')
    }
    load()
  } catch {}
}

async function removeTemplate(row: AdminTemplate) {
  try {
    await ElMessageBox.confirm(
      `永久删除「${row.name}」(${row.id})?不可恢复。\n注:图片文件不会被删(在极境 NAS),需要的话手动清。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'error' },
    )
    await adminApi.deleteTemplate(row.id)
    ElMessage.success('已删除')
    load()
  } catch {}
}

onMounted(load)
</script>

<template>
  <div class="page-card" v-loading="loading">
    <div class="page-header">
      <span class="page-title">模板库</span>
      <span class="hint">
        共 {{ total }} 个 · 拖卡片排顺序、拖标签排分类，松手即存 · 新建模板走本机脚本
      </span>
    </div>

    <!-- 分类标签：可拖拽重排 -->
    <draggable
      v-model="cats"
      item-key="key"
      class="tabs"
      :animation="160"
      ghost-class="drag-ghost"
      @end="onCatDrop"
    >
      <template #item="{ element: c }">
        <button
          class="tab"
          :class="{ active: c.key === activeKey, off: c.isActive !== 1 }"
          @click="activeKey = c.key"
        >
          {{ c.label }}<span v-if="c.isActive !== 1" class="tab-off">停用</span>
          <span class="cnt">{{ buckets[c.key]?.length ?? 0 }}</span>
        </button>
      </template>
    </draggable>
    <button
      v-if="orphanCount > 0"
      class="tab orphan"
      :class="{ active: activeKey === ORPHAN }"
      @click="activeKey = ORPHAN"
    >
      未分类<span class="cnt">{{ orphanCount }}</span>
    </button>

    <!-- 当前分类的模板卡片网格：可拖拽重排 -->
    <draggable
      v-model="activeList"
      item-key="id"
      class="grid"
      :animation="160"
      ghost-class="drag-ghost"
      filter=".no-drag"
      :preventOnFilter="false"
      @end="onTemplateDrop"
    >
      <template #item="{ element: t }">
        <div class="tpl-card" :class="{ inactive: t.isActive !== 1 }" :title="t.name">
          <div class="cover">
            <el-image v-if="t.coverUrl" :src="t.coverUrl" fit="cover" lazy />
            <div v-else class="cover-empty">{{ t.name }}</div>
            <span class="badge" :class="t.isActive === 1 ? 'on' : 'offbadge'">
              {{ t.isActive === 1 ? '上架' : '下架' }}
            </span>
          </div>
          <div class="name">{{ t.name }}</div>
          <div class="actions no-drag">
            <el-button size="small" @click.stop="openEdit(t)">编辑</el-button>
            <el-button
              size="small"
              :type="t.isActive === 1 ? 'warning' : 'success'"
              @click.stop="toggleActive(t)"
            >
              {{ t.isActive === 1 ? '下架' : '上架' }}
            </el-button>
            <el-button size="small" type="danger" @click.stop="removeTemplate(t)">删除</el-button>
          </div>
        </div>
      </template>
    </draggable>
    <div v-if="!loading && activeList.length === 0" class="empty">该分类暂无模板</div>
  </div>

  <el-dialog v-model="editVisible" title="编辑模板元信息" width="520px">
    <el-form label-width="90px" v-if="editing">
      <el-form-item label="ID"><span class="mono">{{ editing.id }}</span></el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="editForm.name" />
      </el-form-item>
      <el-form-item label="分类">
        <el-select v-model="editForm.category" clearable placeholder="选填" style="width: 200px">
          <el-option v-for="c in cats" :key="c.key" :label="c.label" :value="c.key" />
        </el-select>
      </el-form-item>
      <el-form-item label="最低版本">
        <el-input v-model="editForm.minAppVersion" placeholder="留空=全版本可用,如 1.4.0(低于此版本客户端不下发)" />
      </el-form-item>
      <el-form-item label="描述">
        <el-input v-model="editForm.description" type="textarea" :rows="2" />
      </el-form-item>
    </el-form>
    <div class="dlg-hint">排序请直接拖拽卡片；卡片/连线/图(definition)改动走本机 seed 脚本。</div>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="submitEdit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.hint {
  color: #909399;
  font-size: 12px;
}

/* 分类标签栏 */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 6px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border: none;
  border-radius: 999px;
  background: #f0f2f5;
  color: #606266;
  font-size: 13px;
  cursor: grab;
  transition: background 0.15s, color 0.15s;
}
.tab:hover {
  background: #e6e8eb;
}
.tab.active {
  background: var(--el-color-primary);
  color: #fff;
}
.tab.off {
  opacity: 0.55;
}
.tab.orphan {
  margin: 14px 0 6px 8px;
  background: #fdf6ec;
  color: #b88230;
}
.tab .cnt {
  font-size: 11px;
  opacity: 0.7;
}
.tab .tab-off {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.08);
}

/* 卡片网格 */
.grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-top: 10px;
}
@media (max-width: 1400px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
.tpl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  cursor: grab;
  transition: box-shadow 0.2s, transform 0.2s;
}
.tpl-card:hover {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}
.tpl-card:active {
  cursor: grabbing;
}
.tpl-card.inactive {
  opacity: 0.5;
  filter: grayscale(0.6);
}
.cover {
  position: relative;
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, #f5f7fa, #e9edf2);
}
.cover :deep(.el-image) {
  width: 100%;
  height: 100%;
  display: block;
}
.cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 8px;
  text-align: center;
  font-size: 12px;
  color: #c0c4cc;
}
.badge {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  color: #fff;
}
.badge.on {
  background: rgba(103, 194, 58, 0.92);
}
.badge.offbadge {
  background: rgba(144, 147, 153, 0.92);
}
.name {
  padding: 7px 9px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.actions {
  position: absolute;
  inset: 0 0 auto 0;
  top: 0;
  display: flex;
  gap: 4px;
  justify-content: center;
  padding: 6px;
  background: rgba(255, 255, 255, 0.92);
  opacity: 0;
  transition: opacity 0.15s;
}
.tpl-card:hover .actions {
  opacity: 1;
}

.drag-ghost {
  opacity: 0.4;
}
.empty {
  padding: 40px 0;
  text-align: center;
  color: #c0c4cc;
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dlg-hint {
  font-size: 12px;
  color: #909399;
}
</style>
