/**
 * 生成统一重构(P2)的确定性回归测试。
 *
 * 为什么测 build*Request 就够验"组跑==手点":编辑器手点与 cardRunner 组运行
 * 调的是**同一个** build 函数,所以断言 build 的产出 = 同时断言两条路径发出的
 * model/body。这正是 P2.1 修的核心(组跑发真实 SKU 而非 canonical alias)——
 * 而 SKU 在 UI/像素上不可见,只能靠这种请求体断言来验。
 *
 * 这些用例都用「无素材 / http 素材」的卡:uploadMediaBatch 对 http URL 直接透传
 * (mediaToApiRef 短路返回,不碰 Tauri),data.model 给定则不走 modelDefaults 兜底,
 * 所以 build 实际是纯函数,node 环境可确定性执行,无需 app / API Key / 真生成。
 */

import { describe, it, expect } from "vitest";
import type { CanvasCard, CardType } from "@/types";
import { buildVideoRequest, type BuildVideoRequestResult } from "@/services/generation/buildVideoRequest";
import { buildImageRequest, type BuildImageRequestResult } from "@/services/generation/buildImageRequest";
import { buildTryonRequest } from "@/services/generation/buildTryonRequest";
import { buildChatRequest } from "@/services/generation/buildChatRequest";

function makeCard(type: CardType, data: Record<string, unknown>): CanvasCard {
  return {
    id: "card-1",
    projectId: "proj-1",
    type,
    x: 0,
    y: 0,
    width: 360,
    height: 300,
    zIndex: 1,
    locked: false,
    collapsed: false,
    title: undefined,
    data,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as CanvasCard;
}

function assertOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok).toBe(true);
  return r as Extract<T, { ok: true }>;
}

// ─────────────────────────────────────────────────────────────────────────
// P2.1 video —— 五模型族 canonical alias → 真实 SKU(最高危,组跑发错 SKU 是原 bug)
// ─────────────────────────────────────────────────────────────────────────

describe("buildVideoRequest — 五族 tier→真实 SKU", () => {
  async function video(data: Record<string, unknown>): Promise<BuildVideoRequestResult> {
    return buildVideoRequest(makeCard("ai_video", { content: "a cat walking", ...data }));
  }

  it("veo: 默认 tier → veo3.1-fast-720p,不发 resolution/generateAudio", async () => {
    const r = assertOk(await video({ model: "veo3.1" }));
    expect(r.request.model).toBe("veo3.1-fast-720p");
    expect(r.request.resolution).toBeUndefined();
    expect(r.request.generateAudio).toBeUndefined();
  });

  it("veo: std-1080p tier → veo3.1-1080p + 传 duration", async () => {
    const r = assertOk(await video({ model: "veo3.1", veoTier: "std-1080p", duration: 8 }));
    expect(r.request.model).toBe("veo3.1-1080p");
    expect(r.request.duration).toBe(8);
  });

  it("seedance: 默认 standard → doubao-seedance-2-0-260128 + resolution 720p + 默认有声", async () => {
    const r = assertOk(await video({ model: "seedance" }));
    expect(r.request.model).toBe("doubao-seedance-2-0-260128");
    expect(r.request.resolution).toBe("720p");
    expect(r.request.generateAudio).toBe(true);
  });

  it("seedance: fast tier → doubao-seedance-2-0-fast-260128", async () => {
    const r = assertOk(await video({ model: "seedance", seedanceTier: "fast" }));
    expect(r.request.model).toBe("doubao-seedance-2-0-fast-260128");
  });

  it("grok: 16s tier → grok-video-16s,不传 duration", async () => {
    const r = assertOk(await video({ model: "grok-video", grokTier: "16s" }));
    expect(r.request.model).toBe("grok-video-16s");
    expect(r.request.duration).toBeUndefined();
    expect(r.request.generateAudio).toBe(true);
  });

  it("VIP alias: 1080p 无视频 → seedance-2-0-1080p + 具体像素 size", async () => {
    const r = assertOk(
      await video({ model: "seedance-2-0", seedanceVipResolution: "1080p", size: "16:9", duration: 15 }),
    );
    expect(r.request.model).toBe("seedance-2-0-1080p");
    expect(r.request.size).toBe("1920x1080");
    expect(r.request.duration).toBe(15);
  });

  it("V2 alias(火山): fast 无视频 → seedance-2-0-fast + resolution 720p", async () => {
    const r = assertOk(await video({ model: "seedance-v2", seedanceV2Version: "fast" }));
    expect(r.request.model).toBe("seedance-2-0-fast");
    expect(r.request.resolution).toBe("720p");
    expect(r.request.generateAudio).toBe(true);
  });

  it("V2 alias: standard + 含视频参考 → seedance-2-0-video-ref", async () => {
    const r = assertOk(
      await video({
        model: "seedance-v2",
        seedanceV2Version: "standard",
        imageMode: "reference",
        refImages: { refImage0: { url: "http://r0", sourceType: "card" } },
        refVideos: [{ url: "http://v0" }],
      }),
    );
    expect(r.request.model).toBe("seedance-2-0-video-ref");
  });

  it("缺提示词 → skipped", async () => {
    const r = await buildVideoRequest(makeCard("ai_video", { model: "veo3.1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toBe("skipped");
  });
});

describe("buildVideoRequest — 素材 role 分配", () => {
  it("首尾帧: 1 张=firstFrame, 2 张=firstFrame+lastFrame", async () => {
    const r = assertOk(
      await buildVideoRequest(
        makeCard("ai_video", {
          model: "veo3.1",
          content: "x",
          refFrames: [
            { url: "http://a", sourceCardId: "" },
            { url: "http://b", sourceCardId: "" },
          ],
        }),
      ),
    );
    expect(r.request.referenceImages).toEqual([
      { url: "http://a", role: "firstFrame" },
      { url: "http://b", role: "lastFrame" },
    ]);
  });

  it("参考模式: refImages → role referenceImage", async () => {
    const r = assertOk(
      await buildVideoRequest(
        makeCard("ai_video", {
          model: "seedance",
          content: "x",
          imageMode: "reference",
          refImages: {
            refImage0: { url: "http://r0", sourceType: "card" },
            refImage1: { url: "http://r1", sourceType: "card" },
          },
        }),
      ),
    );
    expect(r.request.referenceImages).toEqual([
      { url: "http://r0", role: "referenceImage" },
      { url: "http://r1", role: "referenceImage" },
    ]);
  });
});

describe("buildVideoRequest — 约束(不弹 toast,返回 ok:false)", () => {
  it("seedance + 参考视频 → skipped 该模型不支持参考视频", async () => {
    const r = await buildVideoRequest(
      makeCard("ai_video", {
        model: "seedance",
        content: "x",
        imageMode: "reference",
        refVideos: [{ url: "http://v0" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.outcome).toBe("skipped");
      expect(r.reason).toContain("不支持参考视频");
    }
  });

  it("seedance + 参考音频但无参考图 → skipped 参考音频不能单独使用", async () => {
    const r = await buildVideoRequest(
      makeCard("ai_video", {
        model: "seedance",
        content: "x",
        imageMode: "reference",
        refAudios: [{ url: "http://a0", filename: "a.mp3" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("参考音频不能单独使用");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2.2 / P2.4 image —— ai_image + ai_multiangle(角度 prompt)+ enhancer 预检
// ─────────────────────────────────────────────────────────────────────────

describe("buildImageRequest", () => {
  it("multiangle: prompt 由角度编码 h:..,v:..,z:..", async () => {
    const r = assertOk(
      await buildImageRequest(
        makeCard("ai_multiangle", {
          model: "qwen-image-edit-2511-multipie",
          h: 90,
          v: 0,
          z: 5,
          size: "1:1",
          refImages: { refImage0: { url: "http://p", sourceType: "card" } },
        }),
      ),
    );
    expect(r.request.prompt).toBe("h:90,v:0,z:5");
  });

  it("ai_image: 普通卡走 content prompt + 携带 cardId/projectId", async () => {
    const r = assertOk(
      await buildImageRequest(makeCard("ai_image", { model: "nano-banana", content: "a poster", size: "1:1" })),
    );
    expect(r.request.prompt).toBe("a poster");
    expect(r.request.cardId).toBe("card-1");
    expect(r.request.projectId).toBe("proj-1");
  });

  it("Real-ESRGAN enhancer: 无 prompt 也能跑(size 不发)", async () => {
    const r = assertOk(
      await buildImageRequest(
        makeCard("ai_image", {
          model: "Real-ESRGAN",
          refImages: { refImage0: { url: "http://x", sourceType: "file", width: 512, height: 512 } },
        }),
      ),
    );
    expect(r.request.model).toBe("Real-ESRGAN");
    expect(r.request.size).toBeUndefined();
  });

  it("Real-ESRGAN: 输入>1024 → skipped 图片分辨率过大", async () => {
    const r: BuildImageRequestResult = await buildImageRequest(
      makeCard("ai_image", {
        model: "Real-ESRGAN",
        refImages: { refImage0: { url: "http://x", sourceType: "file", width: 2048, height: 2048 } },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("分辨率过大");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2.4 tryon —— 模特换装前缀 + person/garment 双槽(修了旧手点不发图的 bug)
// ─────────────────────────────────────────────────────────────────────────

describe("buildTryonRequest", () => {
  it("前缀 + person/garment role + 固定 size/quality", async () => {
    const r = assertOk(
      await buildTryonRequest(
        makeCard("ai_tryon", {
          model: "nano-banana",
          personImageUrl: "http://p",
          garmentImageUrl: "http://g",
          content: "红裙",
        }),
      ),
    );
    expect(r.request.prompt).toBe("模特换装: 红裙");
    expect(r.request.referenceImages).toEqual([
      { url: "http://p", role: "person" },
      { url: "http://g", role: "garment" },
    ]);
    expect(r.request.size).toBe("1024x1024");
    expect(r.request.quality).toBe("standard");
  });

  it("空 content → 默认换装指令", async () => {
    const r = assertOk(
      await buildTryonRequest(makeCard("ai_tryon", { model: "nano-banana", personImageUrl: "http://p" })),
    );
    expect(r.request.prompt).toBe("模特换装: 将服装穿在人物身上，保持人物姿态和背景不变");
  });

  it("人/衣都没有 → skipped 请至少上传一张图片", async () => {
    const r = await buildTryonRequest(makeCard("ai_tryon", { model: "nano-banana" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("请至少上传一张图片");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P2.3 chat —— 多模态请求体(修了组跑只发纯文本 stub);<upstream_context> 前缀
// ─────────────────────────────────────────────────────────────────────────

describe("buildChatRequest", () => {
  it("纯文本对话: model/messages/maxTokens 正确", async () => {
    const r = assertOk(await buildChatRequest(makeCard("ai_chat", { model: "gemini-3.1-pro-preview", content: "你好" })));
    expect(r.request.model).toBe("gemini-3.1-pro-preview");
    expect(r.request.maxTokens).toBe(65536);
    expect(r.request.messages).toHaveLength(1);
    expect(r.request.messages[0]!.content).toEqual([{ type: "text", text: "你好" }]);
  });

  it("有上游 → systemPrompt 带 <upstream_context> 包裹", async () => {
    const r = assertOk(
      await buildChatRequest(
        makeCard("ai_chat", {
          model: "gemini-3.1-pro-preview",
          content: "总结",
          upstreamTexts: { src1: "上游产出的文字" },
        }),
      ),
    );
    expect(r.request.systemPrompt).toContain("<upstream_context>");
    expect(r.request.systemPrompt).toContain("上游产出的文字");
  });

  it("无 content 无上游 → skipped", async () => {
    const r = await buildChatRequest(makeCard("ai_chat", { model: "gemini-3.1-pro-preview" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toBe("skipped");
  });
});
