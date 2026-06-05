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
}
