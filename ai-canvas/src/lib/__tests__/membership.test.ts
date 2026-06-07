/**
 * 会员展示视图纯逻辑回归测试。
 *
 * membership 把服务端下发的 user 归一化成"展示什么等级 / 到期 / 是否给升级入口",
 * 标题栏会员标签(MembershipChip)与 设置→账号 会员卡片共用此口径。这里只测纯函数
 * (不碰 store / React),用注入的固定 now 保证确定性:
 *  - membershipFromUser:试用 / 正式版 / 无会员三种归一化 + canUpgrade
 *  - remainingDays:向上取整、最小 0、空到期为 null
 *  - formatExpireDate:空 / 非法兜底
 */

import { describe, it, expect } from "vitest";
import type { AuthUser } from "@/platform/auth.api";
import { membershipFromUser, formatExpireDate } from "@/lib/membership";

const NOW = new Date("2026-06-07T00:00:00").getTime();

function makeUser(over: Partial<AuthUser>): AuthUser {
  return {
    id: 1,
    username: "u",
    email: null,
    memberExpireAt: null,
    status: "active",
    tier: null,
    tierName: null,
    tierRank: null,
    isOfficial: false,
    features: null,
    ...over,
  };
}

describe("membershipFromUser", () => {
  it("试用版 → 非正式版给升级入口 + 剩余天数向上取整", () => {
    const m = membershipFromUser(
      makeUser({
        tier: "trial",
        tierName: "试用版",
        tierRank: 0,
        isOfficial: false,
        // 距 NOW 还有 6.5 天 → 向上取整 = 7
        memberExpireAt: "2026-06-13T12:00:00",
      }),
      NOW,
    );
    expect(m.tierLabel).toBe("试用版");
    expect(m.isOfficial).toBe(false);
    expect(m.canUpgrade).toBe(true);
    expect(m.remainingDays).toBe(7);
  });

  it("正式版 → 不给升级入口", () => {
    const m = membershipFromUser(
      makeUser({
        tier: "vip1",
        tierName: "正式版VIP1",
        tierRank: 10,
        isOfficial: true,
        memberExpireAt: "2026-12-31T00:00:00",
      }),
      NOW,
    );
    expect(m.isOfficial).toBe(true);
    expect(m.canUpgrade).toBe(false);
    expect(m.tierLabel).toBe("正式版VIP1");
  });

  it("无会员 / 无等级名 → 兜底名 + 给升级入口 + 无到期天数", () => {
    const m = membershipFromUser(makeUser({}), NOW);
    expect(m.tierLabel).toBe("未开通会员");
    expect(m.canUpgrade).toBe(true);
    expect(m.expireAt).toBe(null);
    expect(m.remainingDays).toBe(null);
  });

  it("有 tier 但无 tierName → 兜底为「会员」", () => {
    const m = membershipFromUser(makeUser({ tier: "trial", tierName: null }), NOW);
    expect(m.tierLabel).toBe("会员");
  });

  it("已过期(到期早于 now) → 剩余天数夹到 0", () => {
    const m = membershipFromUser(
      makeUser({ tier: "trial", tierName: "试用版", memberExpireAt: "2026-06-01T00:00:00" }),
      NOW,
    );
    expect(m.remainingDays).toBe(0);
  });

  it("null user → 全兜底,给升级入口", () => {
    const m = membershipFromUser(null, NOW);
    expect(m.tier).toBe(null);
    expect(m.tierLabel).toBe("未开通会员");
    expect(m.canUpgrade).toBe(true);
    expect(m.remainingDays).toBe(null);
  });
});

describe("formatExpireDate", () => {
  it("空 → —", () => {
    expect(formatExpireDate(null)).toBe("—");
  });

  it("非法 → —", () => {
    expect(formatExpireDate("not-a-date")).toBe("—");
  });

  it("合法 ISO → zh-CN 本地日期", () => {
    expect(formatExpireDate("2026-06-13T12:00:00")).toBe(
      new Date("2026-06-13T12:00:00").toLocaleDateString("zh-CN"),
    );
  });
});
