<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox, type UploadRawFile } from 'element-plus'
import { adminApi } from '@/api'
import { formatTime } from '@/utils/format'

interface Release {
  id: number
  version: string
  versionCode: number
  target: string
  arch: string
  fileName: string
  fileSize: number
  sha256: string
  releaseNotes: string | null
  minVersion: string | null
  isActive: number
  pubDate: string | null
  createdAt: string | null
}

const releases = ref<{ records: Release[]; total: number }>({ records: [], total: 0 })
const page = ref(1)
const targetFilter = ref('')
const archFilter = ref('')
const loading = ref(false)

const uploadVisible = ref(false)
const uploadForm = ref({
  version: '',
  target: 'windows',
  arch: 'x86_64',
  releaseNotes: '',
  minVersion: '',
  file: null as File | null,
  signature: null as File | null,
})
const uploading = ref(false)

const editVisible = ref(false)
const editing = ref<Release | null>(null)
const editForm = ref({ releaseNotes: '', minVersion: '' })

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function loadReleases() {
  loading.value = true
  try {
    releases.value = await adminApi.getReleases(
      page.value,
      20,
      targetFilter.value || undefined,
      archFilter.value || undefined,
    )
  } catch {} finally {
    loading.value = false
  }
}

function resetUploadForm() {
  uploadForm.value = {
    version: '',
    target: 'windows',
    arch: 'x86_64',
    releaseNotes: '',
    minVersion: '',
    file: null,
    signature: null,
  }
}

function pickFile(raw: UploadRawFile) {
  uploadForm.value.file = raw
  return false // 阻止 el-upload 自动上传
}

function pickSig(raw: UploadRawFile) {
  uploadForm.value.signature = raw
  return false
}

const canSubmitUpload = computed(() =>
  !!uploadForm.value.version
  && !!uploadForm.value.target
  && !!uploadForm.value.arch
  && !!uploadForm.value.file
  && !!uploadForm.value.signature,
)

async function submitUpload() {
  if (!canSubmitUpload.value) {
    ElMessage.warning('请填写所有必填项并选择文件')
    return
  }
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('version', uploadForm.value.version)
    fd.append('target', uploadForm.value.target)
    fd.append('arch', uploadForm.value.arch)
    if (uploadForm.value.releaseNotes) fd.append('releaseNotes', uploadForm.value.releaseNotes)
    if (uploadForm.value.minVersion) fd.append('minVersion', uploadForm.value.minVersion)
    fd.append('file', uploadForm.value.file!)
    fd.append('signature', uploadForm.value.signature!)
    await adminApi.uploadRelease(fd)
    ElMessage.success('上传成功')
    uploadVisible.value = false
    resetUploadForm()
    loadReleases()
  } catch (e) {
    // adminApi 已弹过 ElMessage,这里不再叠加
    console.error(e)
  } finally {
    uploading.value = false
  }
}

function openEdit(row: Release) {
  editing.value = row
  editForm.value = {
    releaseNotes: row.releaseNotes || '',
    minVersion: row.minVersion || '',
  }
  editVisible.value = true
}

async function submitEdit() {
  if (!editing.value) return
  try {
    await adminApi.updateReleaseMeta(editing.value.id, { ...editForm.value })
    ElMessage.success('已保存')
    editVisible.value = false
    loadReleases()
  } catch {}
}

async function toggleActive(row: Release) {
  try {
    if (row.isActive === 1) {
      await ElMessageBox.confirm(
        `停用 v${row.version} (${row.target}/${row.arch})?\n停用后客户端不可切换到此版本。`,
        '确认停用',
        { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
      )
      await adminApi.deactivateRelease(row.id)
      ElMessage.success('已停用')
    } else {
      await adminApi.activateRelease(row.id)
      ElMessage.success('已启用')
    }
    loadReleases()
  } catch {}
}

async function removeRelease(row: Release) {
  try {
    await ElMessageBox.confirm(
      `永久删除 v${row.version} (${row.target}/${row.arch})?\n磁盘文件也会一并删除,不可恢复。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'error' },
    )
    await adminApi.deleteRelease(row.id)
    ElMessage.success('已删除')
    loadReleases()
  } catch {}
}

onMounted(loadReleases)
</script>

<template>
  <div class="page-card">
    <div class="page-header">
      <span class="page-title">客户端版本管理</span>
      <div style="display: flex; gap: 8px; align-items: center">
        <el-select
          v-model="targetFilter"
          placeholder="全部平台"
          clearable
          style="width: 120px"
          @change="loadReleases"
        >
          <el-option label="Windows" value="windows" />
          <el-option label="macOS" value="darwin" />
          <el-option label="Linux" value="linux" />
        </el-select>
        <el-select
          v-model="archFilter"
          placeholder="全部架构"
          clearable
          style="width: 120px"
          @change="loadReleases"
        >
          <el-option label="x86_64" value="x86_64" />
          <el-option label="aarch64" value="aarch64" />
        </el-select>
        <el-button type="primary" @click="uploadVisible = true; resetUploadForm()">
          上传新版本
        </el-button>
      </div>
    </div>

    <el-table :data="releases.records" stripe v-loading="loading">
      <el-table-column prop="version" label="版本" width="100">
        <template #default="{ row }">
          <span class="version-cell">v{{ row.version }}</span>
        </template>
      </el-table-column>
      <el-table-column label="平台" width="160">
        <template #default="{ row }">
          {{ row.target }}/{{ row.arch }}
        </template>
      </el-table-column>
      <el-table-column label="文件" min-width="200">
        <template #default="{ row }">
          <div style="font-size: 12px">
            <div>{{ row.fileName }}</div>
            <div style="color: #909399">{{ formatSize(row.fileSize) }}</div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="row.isActive === 1 ? 'success' : 'info'" size="small">
            {{ row.isActive === 1 ? '启用中' : '已停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发布时间" width="160">
        <template #default="{ row }">{{ formatTime(row.pubDate) }}</template>
      </el-table-column>
      <el-table-column prop="minVersion" label="强更阈值" width="100" align="center">
        <template #default="{ row }">
          <span v-if="row.minVersion">{{ row.minVersion }}</span>
          <span v-else style="color: #c0c4cc">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="releaseNotes" label="更新说明" min-width="200" show-overflow-tooltip />
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
          <el-button size="small" type="danger" @click="removeRelease(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      :page-size="20"
      :total="releases.total"
      layout="total, prev, pager, next"
      @current-change="loadReleases"
    />
  </div>

  <!-- 上传弹窗 -->
  <el-dialog v-model="uploadVisible" title="上传新版本" width="540px" :close-on-click-modal="false">
    <el-form label-width="100px">
      <el-form-item label="版本号" required>
        <el-input
          v-model="uploadForm.version"
          placeholder="1.2.0 (语义版本号,无 v 前缀)"
        />
      </el-form-item>
      <el-form-item label="平台" required>
        <el-radio-group v-model="uploadForm.target">
          <el-radio value="windows">Windows</el-radio>
          <el-radio value="darwin">macOS</el-radio>
          <el-radio value="linux">Linux</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="架构" required>
        <el-radio-group v-model="uploadForm.arch">
          <el-radio value="x86_64">x86_64</el-radio>
          <el-radio value="aarch64">aarch64</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="安装包" required>
        <el-upload
          :before-upload="pickFile"
          :show-file-list="false"
          accept=".exe,.msi,.zip,.gz,.tar,.dmg,.AppImage,.nsis"
        >
          <el-button>选择文件</el-button>
          <span v-if="uploadForm.file" style="margin-left: 8px; font-size: 12px; color: #606266">
            {{ uploadForm.file.name }} ({{ formatSize(uploadForm.file.size) }})
          </span>
        </el-upload>
        <div style="font-size: 12px; color: #909399; margin-top: 4px">
          Win: <code>.nsis.zip</code> 或 <code>.msi.zip</code> &nbsp;&nbsp;
          macOS: <code>.app.tar.gz</code>
        </div>
      </el-form-item>
      <el-form-item label="签名文件" required>
        <el-upload :before-upload="pickSig" :show-file-list="false" accept=".sig">
          <el-button>选择 .sig</el-button>
          <span v-if="uploadForm.signature" style="margin-left: 8px; font-size: 12px; color: #606266">
            {{ uploadForm.signature.name }}
          </span>
        </el-upload>
      </el-form-item>
      <el-form-item label="强更阈值">
        <el-input
          v-model="uploadForm.minVersion"
          placeholder="留空 = 不强更, 如 1.0.0 表示 <1.0.0 强制升级"
        />
      </el-form-item>
      <el-form-item label="更新说明">
        <el-input
          v-model="uploadForm.releaseNotes"
          type="textarea"
          :rows="4"
          placeholder="支持多行,客户端 UpdateDialog 直接展示"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="uploadVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="uploading"
        :disabled="!canSubmitUpload"
        @click="submitUpload"
      >
        上传
      </el-button>
    </template>
  </el-dialog>

  <!-- 编辑弹窗 -->
  <el-dialog v-model="editVisible" title="编辑版本元数据" width="500px">
    <el-form label-width="100px" v-if="editing">
      <el-form-item label="版本">
        <span class="version-cell">v{{ editing.version }} ({{ editing.target }}/{{ editing.arch }})</span>
      </el-form-item>
      <el-form-item label="强更阈值">
        <el-input v-model="editForm.minVersion" placeholder="留空 = 不强更" />
      </el-form-item>
      <el-form-item label="更新说明">
        <el-input v-model="editForm.releaseNotes" type="textarea" :rows="4" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" @click="submitEdit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.version-cell {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-weight: 600;
}
</style>
