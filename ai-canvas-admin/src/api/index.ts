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

  forceUnbind(userId: number, newMachineCode: string, deviceInfo: string) {
    return api('/admin/user/force-unbind', {
      method: 'POST',
      body: JSON.stringify({ userId, newMachineCode, deviceInfo }),
    })
  },

  getRedeemCodes(page: number, size: number, status?: string) {
    let q = `?page=${page}&size=${size}`
    if (status) q += `&status=${status}`
    return api<{ records: any[]; total: number }>(`/admin/redeem-codes${q}`)
  },

  generateCodes(data: { count: number; days: number; validDays: number; remark: string }) {
    return api<{ count: number; batchNo: string; codes: string[] }>('/admin/redeem-codes/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  disableCode(id: number) {
    return api(`/admin/redeem-codes/disable/${id}`, { method: 'POST' })
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
}
