import { ElMessage } from 'element-plus'

const API_BASE = '/api'

let tokenGetter: () => string = () => ''
let onAuthExpired: () => void = () => {}

export function setAuthHooks(getter: () => string, onExpired: () => void) {
  tokenGetter = getter
  onAuthExpired = onExpired
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = tokenGetter()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(API_BASE + path, { ...opts, headers })
  const json = await res.json()

  if (json.code === 40102) {
    onAuthExpired()
    throw new Error('登录过期')
  }
  if (json.code !== 0) {
    ElMessage.error(json.msg)
    throw new Error(json.msg)
  }
  return json.data as T
}

export interface TierFeatures {
  templates?: string[] | '*'
  allowBlank?: boolean
  allowImport?: boolean
  maxProjects?: number
  [k: string]: unknown
}

export interface TierDef {
  id: number
  tierKey: string
  name: string
  tierRank: number
  isOfficial: number
  features: string // 后端 JSON 列映射为字符串，前端 JSON.parse
  isActive: number
  sort: number
}

export interface AdminTemplate {
  id: string
  name: string
  description: string | null
  icon: string | null
  category: string | null
  coverUrl: string | null
  definition: string // WorkflowTemplate JSON 文本
  minAppVersion: string | null
  sort: number
  isActive: number
}

export interface AdminCategory {
  key: string
  label: string
  sort: number
  isActive: number
  minAppVersion: string | null
}

export const adminApi = {
  login(data: { username: string; password: string }) {
    return api<{ token: string; username: string; forcePwdChange: boolean }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  changePassword(data: { oldPassword: string; newPassword: string }) {
    return api('/admin/change-password', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  getDashboard() {
    return api<{
      totalUsers: number
      activeMembers: number
      todayRegistered: number
      total: number
      unused: number
      used: number
    }>('/admin/dashboard')
  },

  getUsers(page: number, size: number, keyword?: string) {
    let q = `?page=${page}&size=${size}`
    if (keyword) q += `&keyword=${encodeURIComponent(keyword)}`
    return api<{ records: any[]; total: number }>(`/admin/users${q}`)
  },

  adjustMembership(userId: number, days: number) {
    return api('/admin/user/adjust-membership', {
      method: 'POST',
      body: JSON.stringify({ userId, days }),
    })
  },

  setUserStatus(userId: number, status: number) {
    return api('/admin/user/set-status', {
      method: 'POST',
      body: JSON.stringify({ userId, status }),
    })
  },

  resetUserPassword(userId: number, newPassword: string) {
    return api('/admin/user/reset-password', {
      method: 'POST',
      body: JSON.stringify({ userId, newPassword }),
    })
  },

  forceUnbind(userId: number) {
    return api('/admin/user/force-unbind', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    })
  },

  setUserTier(userId: number, tier: string, days?: number) {
    return api('/admin/user/set-tier', {
      method: 'POST',
      body: JSON.stringify({ userId, tier, days }),
    })
  },

  getRedeemCodes(page: number, size: number, status?: string) {
    let q = `?page=${page}&size=${size}`
    if (status) q += `&status=${status}`
    return api<{ records: any[]; total: number }>(`/admin/redeem-codes${q}`)
  },

  generateCodes(data: { count: number; days: number; validDays: number; remark: string; tier: string }) {
    return api<{ count: number; batchNo: string; codes: string[]; tier: string; tierName: string }>(
      '/admin/redeem-codes/generate',
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    )
  },

  updateCode(id: number, data: { days: number; remark: string }) {
    return api(`/admin/redeem-codes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  disableCode(id: number) {
    return api(`/admin/redeem-codes/disable/${id}`, { method: 'POST' })
  },

  // ── 会员等级管理（数据驱动 tier_def）────────────────────────────
  getTiers() {
    return api<TierDef[]>('/admin/tiers')
  },

  createTier(data: {
    tierKey: string
    name: string
    tierRank: number
    isOfficial: number
    features: TierFeatures
    isActive: number
    sort: number
  }) {
    return api('/admin/tiers', { method: 'POST', body: JSON.stringify(data) })
  },

  updateTier(
    id: number,
    data: {
      name?: string
      tierRank?: number
      isOfficial?: number
      features?: TierFeatures
      isActive?: number
      sort?: number
    },
  ) {
    return api(`/admin/tiers/${id}`, { method: 'PUT', body: JSON.stringify(data) })
  },

  toggleTier(id: number, active: boolean) {
    return api(`/admin/tiers/${id}/toggle`, { method: 'POST', body: JSON.stringify({ active }) })
  },

  editUser(data: { userId: number; username: string; email: string }) {
    return api('/admin/user/edit', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  getConfig() {
    return api<Record<string, string>>('/admin/config')
  },

  saveConfig(key: string, value: string) {
    return api('/admin/config', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    })
  },

  getOperationLogs(page: number, size: number) {
    return api<{ records: any[]; total: number }>(`/admin/operation-logs?page=${page}&size=${size}`)
  },

  // ── 客户端版本管理 ──────────────────────────────────────────────
  getReleases(page: number, size: number, target?: string, arch?: string) {
    let q = `?page=${page}&size=${size}`
    if (target) q += `&target=${target}`
    if (arch) q += `&arch=${arch}`
    return api<{ records: any[]; total: number }>(`/admin/release/list${q}`)
  },

  // 上传走 multipart, 不能套 application/json,所以独立写;鉴权 token 复用模块作用域的 tokenGetter
  async uploadRelease(form: FormData) {
    const headers: Record<string, string> = {}
    const token = tokenGetter()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(API_BASE + '/admin/release/upload', {
      method: 'POST',
      headers,
      body: form,
    })
    const json = await res.json()
    if (json.code === 40102) {
      onAuthExpired()
      throw new Error('登录过期')
    }
    if (json.code !== 0) {
      ElMessage.error(json.msg || '上传失败')
      throw new Error(json.msg || '上传失败')
    }
    return json.data
  },

  updateReleaseMeta(id: number, data: { releaseNotes?: string; minVersion?: string }) {
    return api(`/admin/release/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  activateRelease(id: number) {
    return api(`/admin/release/${id}/activate`, { method: 'POST' })
  },

  deactivateRelease(id: number) {
    return api(`/admin/release/${id}/deactivate`, { method: 'POST' })
  },

  deleteRelease(id: number) {
    return api(`/admin/release/${id}`, { method: 'DELETE' })
  },

  // ── 模板管理（定义在 aicat.template；图在极境 NAS，新建走本机脚本）──────────
  getTemplates() {
    return api<AdminTemplate[]>('/admin/template/list')
  },

  updateTemplateMeta(
    id: string,
    data: { name?: string; description?: string; category?: string; minAppVersion?: string; sort?: number },
  ) {
    return api(`/admin/template/${id}/meta`, { method: 'PUT', body: JSON.stringify(data) })
  },

  activateTemplate(id: string) {
    return api(`/admin/template/${id}/activate`, { method: 'POST' })
  },

  deactivateTemplate(id: string) {
    return api(`/admin/template/${id}/deactivate`, { method: 'POST' })
  },

  deleteTemplate(id: string) {
    return api(`/admin/template/${id}`, { method: 'DELETE' })
  },

  /** 拖拽重排：ids = 拖完后的完整有序模板 id 列表，服务端赋 sort=0..N。 */
  reorderTemplates(ids: string[]) {
    return api('/admin/template/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
  },

  // ── 模板分组管理（aicat.template_category，组名/顺序/上下架云端可配）──────────
  getCategories() {
    return api<AdminCategory[]>('/admin/template-category/list')
  },

  saveCategory(data: { key: string; label: string; sort?: number; isActive?: number; minAppVersion?: string }) {
    return api('/admin/template-category/upsert', { method: 'POST', body: JSON.stringify(data) })
  },

  updateCategoryMeta(key: string, data: { label?: string; sort?: number; minAppVersion?: string }) {
    return api(`/admin/template-category/${encodeURIComponent(key)}/meta`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  activateCategory(key: string) {
    return api(`/admin/template-category/${encodeURIComponent(key)}/activate`, { method: 'POST' })
  },

  deactivateCategory(key: string) {
    return api(`/admin/template-category/${encodeURIComponent(key)}/deactivate`, { method: 'POST' })
  },

  deleteCategory(key: string) {
    return api(`/admin/template-category/${encodeURIComponent(key)}`, { method: 'DELETE' })
  },

  /** 拖拽重排：keys = 拖完后的完整有序分组 key 列表，服务端赋 sort=0..N。 */
  reorderCategories(keys: string[]) {
    return api('/admin/template-category/reorder', { method: 'POST', body: JSON.stringify({ keys }) })
  },
}
