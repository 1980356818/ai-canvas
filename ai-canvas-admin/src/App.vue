<script setup lang="ts">
import { ref } from 'vue'
import { useAuth } from '@/composables/useAuth'
import LoginView from '@/views/LoginView.vue'
import AppLayout from '@/components/layout/AppLayout.vue'
import ChangePwdDialog from '@/components/dialogs/ChangePwdDialog.vue'

const { token } = useAuth()
const showChangePwd = ref(false)
const forcePwdChange = ref(false)

function onLoginForceChange() {
  forcePwdChange.value = true
  showChangePwd.value = true
}
</script>

<template>
  <LoginView v-if="!token" @force-change-pwd="onLoginForceChange" />
  <AppLayout v-else @change-pwd="showChangePwd = true" />
  <ChangePwdDialog
    v-model="showChangePwd"
    :force="forcePwdChange"
    @changed="forcePwdChange = false"
  />
</template>
