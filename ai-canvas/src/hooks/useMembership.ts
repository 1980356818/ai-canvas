import { useMemo } from "react";
import { useAuthStore } from "@/stores/authStore";
import { membershipFromUser, type MembershipView } from "@/lib/membership";

/** 读取当前用户的会员展示视图。user 变化(登录/兑换/刷新状态)时自动重算。 */
export function useMembership(): MembershipView {
  const user = useAuthStore((s) => s.user);
  return useMemo(() => membershipFromUser(user), [user]);
}
