import { ref } from 'vue'
import { setAuthHooks } from '@/api'

const TOKEN_KEY = 'aicat_admin_token'
const USER_KEY = 'aicat_admin_user'

const token = ref(localStorage.getItem(TOKEN_KEY) || '')
const adminUsername = ref(localStorage.getItem(USER_KEY) || '')

function login(t: string, username: string) {
  token.value = t
  adminUsername.value = username
  localStorage.setItem(TOKEN_KEY, t)
  localStorage.setItem(USER_KEY, username)
}

function logout() {
  token.value = ''
  adminUsername.value = ''
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

setAuthHooks(
  () => token.value,
  () => logout(),
)

export function useAuth() {
  return { token, adminUsername, login, logout }
}
