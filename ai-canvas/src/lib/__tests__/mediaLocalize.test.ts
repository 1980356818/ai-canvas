/**
 * mediaLocalize(生成结果媒体统一收敛)的契约测试。
 *
 * 覆盖:
 *   - collectLocalizableUrls:只收结果字段 + results[].url;模板静态 URL /
 *     本地相对路径 / 输入字段(refImages)绝不收
 *   - localizeCardMedia:imageUrl 与 results[].url 同源同换 + remoteUrl 溯源;
 *     local:// 占位符零网络修复;失败按条目计数不抛
 *   - scheduleCardMediaLocalization:按卡单飞、退避重试、收敛后排干
 *   - sweepProjectMediaLocalization:只扫本项目、干净卡不入队
 *
 * saveMedia / autoSave 打桩,cardStore 用真 store(zustand 在 node 可用)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/platform/runtime", () => ({
  isTauri: true,
  ensureTauriAPIs: vi.fn(),
  getInvoke: vi.fn(),
}));

const saveMediaMock = vi.fn();
vi.mock("@/platform", () => ({
  saveMedia: (...args: unknown[]) => saveMediaMock(...args),
}));

const markDirtyMock = vi.fn();
vi.mock("@/lib/autoSave", () => ({
  autoSave: { markDirty: (...args: unknown[]) => markDirtyMock(...args), forceSave: vi.fn() },
}));

import { useCardStore } from "@/stores/cardStore";
import {
  collectLocalizableUrls,
  hasLocalizableMedia,
  localizeCardMedia,
  scheduleCardMediaLocalization,
  sweepProjectMediaLocalization,
  _resetForTests,
} from "@/lib/mediaLocalize";
import type { CanvasCard } from "@/types";

const TEMPLATE_URL = "https://www.jjowo.com/aicanvas-static/templates/imported/x.jpg";

let seq = 0;
function makeCard(
  over: Partial<Omit<CanvasCard, "data">> & { data: Record<string, unknown> },
): CanvasCard {
  seq++;
  return {
    id: `card-${seq}`,
    projectId: "p1",
    type: "ai_image",
    x: 0,
    y: 0,
    width: 320,
    height: 240,
    zIndex: 1,
    title: "测试卡",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as CanvasCard;
}

function getData(id: string): Record<string, unknown> {
  return useCardStore.getState().getCard(id)!.data as Record<string, unknown>;
}

beforeEach(() => {
  useCardStore.getState().clear();
  saveMediaMock.mockReset();
  markDirtyMock.mockReset();
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  vi.useRealTimers();
});

describe("collectLocalizableUrls", () => {
  it("收结果字段 + results[].url(去重);模板静态/本地相对路径/输入字段不收", () => {
    const urls = collectLocalizableUrls({
      imageUrl: "https://cdn.example.com/a.png",
      results: [
        { url: "https://cdn.example.com/a.png" }, // 与 imageUrl 同源 → 去重
        { url: "https://other.example.com/b.png", revisedPrompt: "p" },
        { url: "media/images/local.png" }, // 本地稳态
        { url: TEMPLATE_URL }, // 模板静态 → 规范保留公网
      ],
      refImages: ["https://cdn.example.com/ref.png"], // 输入字段,不在白名单
    });
    expect(urls).toEqual([
      "https://cdn.example.com/a.png",
      "https://other.example.com/b.png",
    ]);
  });

  it("local:// / asset.localhost 占位符泄漏也算待收敛", () => {
    expect(collectLocalizableUrls({ videoUrl: "local://media/videos/v.mp4" })).toEqual([
      "local://media/videos/v.mp4",
    ]);
    expect(hasLocalizableMedia({ imageUrl: "media/images/ok.png" })).toBe(false);
    expect(hasLocalizableMedia({ imageUrl: TEMPLATE_URL })).toBe(false);
  });
});

describe("localizeCardMedia", () => {
  it("下载成功:imageUrl 与 results[].url 同源同换,results 补 remoteUrl 溯源", async () => {
    const A = "https://cdn.example.com/a.png";
    const B = "https://other.example.com/b.png";
    saveMediaMock.mockImplementation(async (url: string) => ({
      localPath: url === A ? "media/images/A.png" : "media/images/B.png",
    }));
    const card = makeCard({
      data: {
        imageUrl: A,
        results: [{ url: A }, { url: B, revisedPrompt: "p" }, { url: TEMPLATE_URL }],
        selectedIndex: 0,
      },
    });
    useCardStore.getState().setCards([card]);

    const r = await localizeCardMedia(card.id);

    expect(r).toEqual({ repaired: 0, saved: 2, failed: 0, skipped: 0 });
    const d = getData(card.id);
    expect(d.imageUrl).toBe("media/images/A.png");
    const results = d.results as Array<Record<string, unknown>>;
    expect(results[0]).toEqual({ url: "media/images/A.png", remoteUrl: A });
    expect(results[1]).toEqual({ url: "media/images/B.png", revisedPrompt: "p", remoteUrl: B });
    expect(results[2]).toEqual({ url: TEMPLATE_URL }); // 模板条目原样
    expect(d.selectedIndex).toBe(0);
    expect(saveMediaMock).toHaveBeenCalledWith(A, undefined, "测试卡", "p1");
    expect(markDirtyMock).toHaveBeenCalledWith(card.id);
  });

  it("local:// 占位符零网络修复,不调 saveMedia", async () => {
    const card = makeCard({
      type: "ai_video",
      data: { videoUrl: "local://media/videos/v.mp4" },
    });
    useCardStore.getState().setCards([card]);

    const r = await localizeCardMedia(card.id);

    expect(r).toEqual({ repaired: 1, saved: 0, failed: 0, skipped: 0 });
    expect(getData(card.id).videoUrl).toBe("media/videos/v.mp4");
    expect(saveMediaMock).not.toHaveBeenCalled();
  });

  it("部分失败:成功的照常落地,失败的计数留待重试,不抛", async () => {
    const A = "https://cdn.example.com/a.png";
    const B = "https://dead.example.com/b.png";
    saveMediaMock.mockImplementation(async (url: string) => {
      if (url === B) throw new Error("下载失败 (重试3次): HTTP 502");
      return { localPath: "media/images/A.png" };
    });
    const card = makeCard({ data: { imageUrl: A, results: [{ url: A }, { url: B }] } });
    useCardStore.getState().setCards([card]);

    const r = await localizeCardMedia(card.id);

    expect(r).toEqual({ repaired: 0, saved: 1, failed: 1, skipped: 0 });
    const d = getData(card.id);
    expect(d.imageUrl).toBe("media/images/A.png");
    expect((d.results as Array<{ url: string }>)[1]!.url).toBe(B);
  });
});

describe("scheduleCardMediaLocalization / sweep", () => {
  it("按卡单飞 + 退避重试,收敛成功后排干", async () => {
    vi.useFakeTimers();
    const R = "https://cdn.example.com/r.png";
    saveMediaMock.mockRejectedValue(new Error("net down"));
    const card = makeCard({ data: { imageUrl: R } });
    useCardStore.getState().setCards([card]);

    expect(scheduleCardMediaLocalization(card.id)).toBe(true);
    expect(scheduleCardMediaLocalization(card.id)).toBe(false); // 单飞

    await vi.advanceTimersByTimeAsync(5_000); // 第 1 次
    expect(saveMediaMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000); // 第 2 次(退避)
    expect(saveMediaMock).toHaveBeenCalledTimes(2);

    saveMediaMock.mockResolvedValue({ localPath: "media/images/R.png" });
    await vi.advanceTimersByTimeAsync(45_000); // 第 3 次成功
    expect(getData(card.id).imageUrl).toBe("media/images/R.png");

    // 已收敛 → 再排队是 no-op
    expect(scheduleCardMediaLocalization(card.id)).toBe(false);
  });

  it("sweep 只扫本项目、干净卡/模板卡不入队", () => {
    vi.useFakeTimers();
    const dirty = makeCard({ data: { imageUrl: "https://cdn.example.com/x.png" } });
    const clean = makeCard({ data: { imageUrl: "media/images/ok.png" } });
    const template = makeCard({ data: { imageUrl: TEMPLATE_URL } });
    const otherProject = makeCard({
      projectId: "p2",
      data: { imageUrl: "https://cdn.example.com/y.png" },
    });
    useCardStore.getState().setCards([dirty, clean, template, otherProject]);

    expect(sweepProjectMediaLocalization("p1")).toBe(1);
    // dirty 已在队中,重复 sweep 不再入队
    expect(sweepProjectMediaLocalization("p1")).toBe(0);
  });
});
