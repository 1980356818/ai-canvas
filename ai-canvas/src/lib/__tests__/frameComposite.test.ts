//! 锁住"抽帧合成内存根治"的核心不变量。
//!
//! 背景:早期 composeFrameGrid 用 `Promise.all(frames.map(loadImage))` 把 N 张原分辨率
//! 帧同时解码,峰值内存 ∝ N。小间隔抽几百帧在弱机/软件渲染上 OOM → "失败"。改成
//! `runDecodePool` 有界并发 + 降采样解码后,峰值 ∝ 并发数(常量)。本测试钉死:
//!   1. 任意时刻在飞解码数 ≤ 并发上限(无论帧数多大)—— 这是不爆内存的根据;
//!   2. 每个任务恰好处理一次、不漏不重;
//!   3. containSize 的 contain 数学正确。
//! 注:composeFrameGrid 本体依赖 canvas/createImageBitmap,vitest node 环境跑不了,
//! 故只测可隔离的纯逻辑层。

import { describe, it, expect } from "vitest";
import { runDecodePool, containSize } from "@/lib/frameComposite";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("runDecodePool — 并发上限与帧数解耦", () => {
  it("几百个任务下在飞数永不超过并发上限,且每个恰好跑一次", async () => {
    const N = 500;
    const LIMIT = 4;
    const items = Array.from({ length: N }, (_, i) => i);

    let inFlight = 0;
    let peak = 0;
    const seen = new Array<number>(N).fill(0);

    await runDecodePool(items, LIMIT, async (item, index) => {
      expect(index).toBe(item); // index 与原数组对齐
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // 让多个 worker 真正重叠在飞,逼出真实峰值
      await tick();
      await tick();
      seen[item] = (seen[item] ?? 0) + 1;
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(LIMIT); // ← 不爆内存的根据:与 N=500 无关
    expect(peak).toBe(LIMIT); // 充分并发,确实把池占满
    expect(seen.every((c) => c === 1)).toBe(true); // 不漏不重
  });

  it("并发上限大于任务数时,在飞数被任务数夹住", async () => {
    let inFlight = 0;
    let peak = 0;
    await runDecodePool([1, 2, 3], 16, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("空数组直接 resolve,worker 不被调用", async () => {
    let calls = 0;
    await runDecodePool([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("并发上限为 0/负数时退化为至少 1,仍能跑完", async () => {
    const items = [0, 1, 2];
    const seen: number[] = [];
    await runDecodePool(items, 0, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([0, 1, 2]);
  });
});

describe("containSize — contain 数学", () => {
  it("16:9 帧塞进方框,宽绑定、高留白", () => {
    const fit = containSize(16 / 9, 800, 800);
    expect(fit.w).toBe(800);
    expect(fit.h).toBe(450); // 800 / (16/9)
  });

  it("9:16 竖帧塞进方框,高绑定、宽留白", () => {
    const fit = containSize(9 / 16, 800, 800);
    expect(fit.h).toBe(800);
    expect(fit.w).toBe(450); // 800 * (9/16)
  });

  it("帧比例与框一致时正好铺满", () => {
    const fit = containSize(2, 400, 200);
    expect(fit).toEqual({ w: 400, h: 200 });
  });

  it("永远不超出框、且至少 1px", () => {
    const fit = containSize(100, 240, 135); // 极宽帧
    expect(fit.w).toBeLessThanOrEqual(240);
    expect(fit.h).toBeLessThanOrEqual(135);
    expect(fit.w).toBeGreaterThanOrEqual(1);
    expect(fit.h).toBeGreaterThanOrEqual(1);
  });
});
