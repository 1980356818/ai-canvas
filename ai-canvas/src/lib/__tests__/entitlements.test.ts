/**
 * 功能门禁纯逻辑回归测试。
 *
 * entitlements 把服务端下发的 tier features 归一化成门禁判定，是试用/正式版
 * 区分的地基。这里只测纯函数（不碰 store / React），node 环境可确定执行：
 *  - entitlementsFromUser：缺省/试用/正式版三种下发的归一化
 *  - canUseTemplate：模板白名单 vs "*"
 *  - canCreateProject：maxProjects 配额闸（试用限 2、正式版不限）
 */

import { describe, it, expect } from "vitest";
import type { AuthUser, TierFeatures } from "@/platform/auth.api";
import {
  entitlementsFromUser,
  canUseTemplate,
  canCreateProject,
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
  maxProjects: 2,
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
    expect(ent.maxProjects).toBe(0);
    expect(ent.isOfficial).toBe(false);
  });

  it("null user → 同样兜底为最保守值", () => {
    const ent = entitlementsFromUser(null);
    expect(ent.templates).toEqual([]);
    expect(ent.allowBlank).toBe(false);
    expect(ent.maxProjects).toBe(0);
  });

  it("试用版 → 模板白名单 + 禁空白/导入 + 限 2 项目", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(ent.templates).toEqual(["wf-white-bg", "wf-tryon"]);
    expect(ent.allowBlank).toBe(false);
    expect(ent.allowImport).toBe(false);
    expect(ent.maxProjects).toBe(2);
    expect(ent.isOfficial).toBe(false);
    expect(ent.tierName).toBe("试用版");
  });

  it("正式版 → 全模板 + 空白/导入 + 不限项目(maxProjects 缺省=0)", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(ent.templates).toBe("*");
    expect(ent.allowBlank).toBe(true);
    expect(ent.allowImport).toBe(true);
    expect(ent.maxProjects).toBe(0);
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

describe("canCreateProject", () => {
  it("maxProjects=0(不限) → 任何数量都可建", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canCreateProject(ent, 0)).toBe(true);
    expect(canCreateProject(ent, 999)).toBe(true);
  });

  it("试用版限 2：count<2 放行，>=2 拦截", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canCreateProject(ent, 0)).toBe(true);
    expect(canCreateProject(ent, 1)).toBe(true);
    expect(canCreateProject(ent, 2)).toBe(false);
    expect(canCreateProject(ent, 3)).toBe(false);
  });
});
