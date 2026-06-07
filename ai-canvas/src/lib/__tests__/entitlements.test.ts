/**
 * 功能门禁纯逻辑回归测试。
 *
 * entitlements 把服务端下发的 tier features 归一化成门禁判定，是试用/正式版
 * 区分的地基。这里只测纯函数（不碰 store / React），node 环境可确定执行：
 *  - entitlementsFromUser：缺省/试用/正式版三种下发的归一化
 *  - canUseTemplate：模板白名单 vs "*"
 */

import { describe, it, expect } from "vitest";
import type { AuthUser, TierFeatures } from "@/platform/auth.api";
import {
  entitlementsFromUser,
  canUseTemplate,
  canSeeTemplate,
} from "@/lib/entitlements";

function makeUser(tier: string | null, features: TierFeatures | null): AuthUser {
  return {
    id: 1,
    username: "u",
    email: null,
    memberExpireAt: tier ? "2099-01-01T00:00:00" : null,
    status: tier ? "active" : "expired",
    tier,
    tierName: tier === "trial" ? "试用版" : tier ? "VIP1" : null,
    tierRank: tier === "trial" ? 0 : tier ? 10 : null,
    isOfficial: tier != null && tier !== "trial",
    features,
  };
}

const TRIAL_FEATURES: TierFeatures = {
  templates: ["wf-white-bg", "wf-tryon"],
  allowBlank: false,
  allowImport: false,
};
const VIP_FEATURES: TierFeatures = {
  templates: "*",
  allowBlank: true,
  allowImport: true,
};

describe("entitlementsFromUser", () => {
  it("无会员/过期 → 最保守：什么都不能建", () => {
    const ent = entitlementsFromUser(makeUser(null, null));
    expect(ent.templates).toEqual([]);
    expect(ent.allowBlank).toBe(false);
    expect(ent.allowImport).toBe(false);
    expect(ent.isOfficial).toBe(false);
  });

  it("null user → 同样兜底为最保守值", () => {
    const ent = entitlementsFromUser(null);
    expect(ent.templates).toEqual([]);
    expect(ent.allowBlank).toBe(false);
  });

  it("试用版 → 模板白名单 + 禁空白/导入", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(ent.templates).toEqual(["wf-white-bg", "wf-tryon"]);
    expect(ent.allowBlank).toBe(false);
    expect(ent.allowImport).toBe(false);
    expect(ent.isOfficial).toBe(false);
    expect(ent.tierName).toBe("试用版");
  });

  it("正式版 → 全模板 + 空白/导入", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(ent.templates).toBe("*");
    expect(ent.allowBlank).toBe(true);
    expect(ent.allowImport).toBe(true);
    expect(ent.isOfficial).toBe(true);
  });
});

describe("canUseTemplate", () => {
  it('"*" 放行任意模板', () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canUseTemplate(ent, "wf-anything")).toBe(true);
  });

  it("白名单只放行列表内模板", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canUseTemplate(ent, "wf-white-bg")).toBe(true);
    expect(canUseTemplate(ent, "wf-tryon")).toBe(true);
    expect(canUseTemplate(ent, "wf-pose-fission")).toBe(false);
  });
});

describe("canSeeTemplate (展示可见性,独立于能否使用)", () => {
  const trialTpl = { category: "trial" };
  const flatTpl = { category: "flat" };

  it("正式版 → 隐藏 trial 模板(已有完整模板,不看重复试用副本),其它分类可见", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canSeeTemplate(ent, trialTpl)).toBe(false);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
  });

  it("试用版 → trial 模板可见", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canSeeTemplate(ent, trialTpl)).toBe(true);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
  });

  it("过期/无会员(非正式版) → 仍能看到 trial(引导体验),边界=只对正式版隐藏", () => {
    const ent = entitlementsFromUser(makeUser(null, null));
    expect(canSeeTemplate(ent, trialTpl)).toBe(true);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
  });
});
