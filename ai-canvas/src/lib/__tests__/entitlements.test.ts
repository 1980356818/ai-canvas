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
  canInsertTemplate,
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

  it("templateCategories → 归一化为数组(缺省 → 空数组)", () => {
    const ent = entitlementsFromUser(
      makeUser("trial-video", { templateCategories: ["video"], allowBlank: true }),
    );
    expect(ent.templateCategories).toEqual(["video"]);
    // VIP_FEATURES 无该字段 → 兜底空数组
    expect(entitlementsFromUser(makeUser("vip1", VIP_FEATURES)).templateCategories).toEqual([]);
  });
});

describe("canUseTemplate", () => {
  it('"*" 放行任意模板', () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canUseTemplate(ent, { id: "wf-anything", category: "flat" })).toBe(true);
  });

  it("id 白名单只放行列表内模板", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canUseTemplate(ent, { id: "wf-white-bg", category: "flat" })).toBe(true);
    expect(canUseTemplate(ent, { id: "wf-tryon", category: "flat" })).toBe(true);
    expect(canUseTemplate(ent, { id: "wf-pose-fission", category: "flat" })).toBe(false);
  });

  it("templateCategories grant 放行整类(不在 id 白名单也可用)", () => {
    const ent = entitlementsFromUser(
      makeUser("trial-video", {
        templateCategories: ["trial", "video"],
        allowBlank: true,
        allowImport: false,
      }),
    );
    expect(canUseTemplate(ent, { id: "wf-x-video", category: "video" })).toBe(true);
    expect(canUseTemplate(ent, { id: "wf-white-bg-trial", category: "trial" })).toBe(true);
    expect(canUseTemplate(ent, { id: "wf-detail-cn", category: "detail" })).toBe(false);
    expect(canUseTemplate(ent, { id: "wf-pose-fission", category: "flat" })).toBe(false);
  });
});

describe("canSeeTemplate (展示可见性,独立于能否使用)", () => {
  const trialTpl = { id: "wf-white-bg-trial", category: "trial" };
  const flatTpl = { id: "wf-pose-fission", category: "flat" };
  const videoTpl = { id: "wf-clothing-fixed-video", category: "video" };
  const videoTrialTpl = { id: "wf-clothing-fixed-video-trial", category: "video" };

  it("正式版 → 隐藏 trial 模板(已有完整模板,不看重复试用副本),其它分类可见", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canSeeTemplate(ent, trialTpl)).toBe(false);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
  });

  it("正式版 → 视频分组:正式版可见,试用版(-trial 后缀)隐藏", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canSeeTemplate(ent, videoTpl)).toBe(true);
    expect(canSeeTemplate(ent, videoTrialTpl)).toBe(false);
  });

  it("试用版 → trial 模板可见,视频试用版也可见", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canSeeTemplate(ent, trialTpl)).toBe(true);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
    expect(canSeeTemplate(ent, videoTrialTpl)).toBe(true);
  });

  it("过期/无会员(非正式版) → 仍能看到 trial(引导体验),边界=只对正式版隐藏", () => {
    const ent = entitlementsFromUser(makeUser(null, null));
    expect(canSeeTemplate(ent, trialTpl)).toBe(true);
    expect(canSeeTemplate(ent, flatTpl)).toBe(true);
    expect(canSeeTemplate(ent, videoTrialTpl)).toBe(true);
  });
});

/**
 * 画布右键/双击「添加模板」插入门禁回归。
 *
 * 历史 bug:该菜单只过滤 canSeeTemplate(没有 canUseTemplate),试用版用户能看到并
 * 直接实例化正式版模板,绕过付费墙。canInsertTemplate 必须同时满足「可见 + 可用」。
 */
describe("canInsertTemplate (画布插入门禁 = 可见且可用)", () => {
  // 试用版白名单 = trial 分类模板(对齐 TRIAL_FEATURES.templates);正式版模板 id 不在内。
  const trialAllowed = { id: "wf-white-bg", category: "trial" };
  const officialFlat = { id: "wf-pose-fission", category: "flat" };

  it("试用版 → 只能插入白名单内模板,正式版模板(白名单外)一律不可插入【bug 回归】", () => {
    const ent = entitlementsFromUser(makeUser("trial", TRIAL_FEATURES));
    expect(canInsertTemplate(ent, trialAllowed)).toBe(true);
    // 这条若回到 true,就是 bug 复发:试用版又能从右键菜单插入正式版模板。
    expect(canInsertTemplate(ent, officialFlat)).toBe(false);
  });

  it("正式版 → 可插入正式版模板,但 trial 分类(重复试用副本)不列出", () => {
    const ent = entitlementsFromUser(makeUser("vip1", VIP_FEATURES));
    expect(canInsertTemplate(ent, officialFlat)).toBe(true);
    expect(canInsertTemplate(ent, trialAllowed)).toBe(false); // canSeeTemplate 藏掉 trial
  });

  it("过期/无会员 → 白名单为空,任何模板都不可插入", () => {
    const ent = entitlementsFromUser(makeUser(null, null));
    expect(canInsertTemplate(ent, trialAllowed)).toBe(false);
    expect(canInsertTemplate(ent, officialFlat)).toBe(false);
  });
});
