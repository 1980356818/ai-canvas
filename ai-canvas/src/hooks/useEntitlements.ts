import { useMemo } from "react";
import { useAuthStore } from "@/stores/authStore";
import { entitlementsFromUser, type Entitlements } from "@/lib/entitlements";

/** 读取当前用户的归一化功能权限。user 变化（登录/兑换/刷新状态）时自动重算。 */
export function useEntitlements(): Entitlements {
  const user = useAuthStore((s) => s.user);
  return useMemo(() => entitlementsFromUser(user), [user]);
}
