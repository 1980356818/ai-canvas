export function formatTime(t: string | null | undefined): string {
  if (!t) return ''
  return t.replace('T', ' ').substring(0, 16)
}

export function isExpired(d: string | null | undefined): boolean {
  return !d || new Date(d) < new Date()
}

export function configDesc(key: string): string {
  const map: Record<string, string> = {
    unbind_limit_per_month: '每月允许解绑次数',
    unbind_cooldown_days: '两次解绑最短间隔天数',
  }
  return map[key] || ''
}

export function actionLabel(a: string): string {
  const map: Record<string, string> = {
    generate_codes: '生成兑换码',
    disable_code: '禁用兑换码',
    ban_user: '封禁用户',
    unban_user: '解封用户',
    adjust_membership: '调整会员',
    force_unbind: '强制解绑',
    update_config: '更新配置',
  }
  return map[a] || a
}

export function actionTagType(a: string): '' | 'success' | 'info' | 'warning' | 'danger' {
  if (a === 'ban_user' || a === 'disable_code') return 'danger'
  if (a === 'unban_user') return 'success'
  if (a === 'generate_codes') return ''
  return 'info'
}

export function statusType(s: string): '' | 'success' | 'info' | 'warning' | 'danger' {
  const map: Record<string, '' | 'success' | 'info' | 'warning' | 'danger'> = {
    unused: 'success',
    used: 'info',
    disabled: 'danger',
    expired: 'warning',
  }
  return map[s] || 'info'
}

export function statusLabel(s: string): string {
  const map: Record<string, string> = {
    unused: '未使用',
    used: '已使用',
    disabled: '已禁用',
    expired: '已过期',
  }
  return map[s] || s
}
