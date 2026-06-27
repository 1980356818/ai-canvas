/**
 * 单测「源卡 id 字段单一真相」cardSourceRefs:remapCardSourceIds(复制/粘贴/移动/撤销重建卡时
 * 把 data 里所有源卡 id 按 idMap 改写)与 collectCardSourceIds(收集引用到的源卡 id)。
 *
 * 这是「复制组后参考图/视频顺序全乱」的根因修复:副本若仍带旧源卡 id,注入管线按 sourceCardId
 * 找不到槽 → 按连线序整列重建 → 顺序被打乱。重映射后注入原位命中、顺序原样保留。
 *
 * 重点:**完整性守卫** —— 遍历 SOURCE_REF_FIELDS 断言每个字段都被 remap/collect 覆盖,
 * 新增字段忘了处理会让守卫测试失败,杜绝「漏一个字段」的 bug 复发。
 */
import { describe, it, expect } from "vitest";
import {
  remapCardSourceIds,
  collectCardSourceIds,
  SOURCE_REF_FIELDS,
  type SourceRefFieldKind,
} from "@/lib/cardSourceRefs";

const idMap = new Map<string, string>([
  ["s0", "n0"],
  ["s1", "n1"],
  ["s2", "n2"],
]);

/** 给某 kind 造一个「引用 s0」的字段值;完整性守卫用它逐字段构造数据。 */
function sampleValueFor(kind: SourceRefFieldKind): unknown {
  switch (kind) {
    case "slotRecord":
      return { refImage0: { url: "u", sourceCardId: "s0", sourceType: "card" } };
    case "sourceArray":
      return [{ url: "u", sourceCardId: "s0" }];
    case "idKeyedRecord":
      return { s0: "text" };
    case "scalarId":
      return "s0";
    case "inlineRefs":
      return [{ id: "r", displayLabel: "@s0", source: { type: "upstream", sourceCardId: "s0" } }];
  }
}

describe("remapCardSourceIds", () => {
  it("refImages:原位改 sourceCardId,槽 key 与顺序不变", () => {
    const out = remapCardSourceIds(
      {
        refImages: {
          refImage0: { url: "u2", sourceCardId: "s2", sourceType: "card" },
          refImage1: { url: "u0", sourceCardId: "s0", sourceType: "card" },
          refImage2: { url: "u1", sourceCardId: "s1", sourceType: "card" },
        },
      },
      idMap,
    );
    expect(out.refImages).toEqual({
      refImage0: { url: "u2", sourceCardId: "n2", sourceType: "card" },
      refImage1: { url: "u0", sourceCardId: "n0", sourceType: "card" },
      refImage2: { url: "u1", sourceCardId: "n1", sourceType: "card" },
    });
  });

  it("数组型源引用:refVideos / refFrames / refAudios / directMedia 各项原位改 id、顺序不变", () => {
    const out = remapCardSourceIds(
      {
        refVideos: [
          { url: "v1", sourceCardId: "s1" },
          { url: "v0", sourceCardId: "s0" },
        ],
        refFrames: [{ url: "f2", sourceCardId: "s2" }],
        refAudios: [{ url: "a0", filename: "a.mp3", sourceCardId: "s0" }],
        directMedia: [{ url: "m2", displayUrl: "d2", kind: "video", sourceCardId: "s2" }],
      },
      idMap,
    );
    expect(out.refVideos).toEqual([
      { url: "v1", sourceCardId: "n1" },
      { url: "v0", sourceCardId: "n0" },
    ]);
    expect(out.refFrames).toEqual([{ url: "f2", sourceCardId: "n2" }]);
    expect(out.refAudios).toEqual([{ url: "a0", filename: "a.mp3", sourceCardId: "n0" }]);
    expect(out.directMedia).toEqual([{ url: "m2", displayUrl: "d2", kind: "video", sourceCardId: "n2" }]);
  });

  it("upstreamTexts:键(= 源卡 id)被重映射,值不变", () => {
    const out = remapCardSourceIds({ upstreamTexts: { s0: "hello", s2: "world" } }, idMap);
    expect(out.upstreamTexts).toEqual({ n0: "hello", n2: "world" });
  });

  it("单值 id:upstreamCardId / sourceVideoCardId / upstreamChatCardId", () => {
    const out = remapCardSourceIds(
      { upstreamCardId: "s0", sourceVideoCardId: "s1", upstreamChatCardId: "s2" },
      idMap,
    );
    expect(out.upstreamCardId).toBe("n0");
    expect(out.sourceVideoCardId).toBe("n1");
    expect(out.upstreamChatCardId).toBe("n2");
  });

  it("inlineRefs:仅 upstream 源改 id,refSlot 等卡内槽位引用不动", () => {
    const out = remapCardSourceIds(
      {
        inlineRefs: [
          { id: "r1", displayLabel: "@s0", source: { type: "upstream", sourceCardId: "s0" } },
          { id: "r2", displayLabel: "@slot", source: { type: "refSlot", slotKey: "refImage0" } },
        ],
      },
      idMap,
    );
    expect(out.inlineRefs).toEqual([
      { id: "r1", displayLabel: "@s0", source: { type: "upstream", sourceCardId: "n0" } },
      { id: "r2", displayLabel: "@slot", source: { type: "refSlot", slotKey: "refImage0" } },
    ]);
  });

  it("未被复制的外部源(不在 idMap)保持原 id 不变", () => {
    const out = remapCardSourceIds(
      { refImages: { refImage0: { url: "u", sourceCardId: "external", sourceType: "card" } } },
      idMap,
    );
    expect((out.refImages as Record<string, { sourceCardId?: string }>).refImage0!.sourceCardId).toBe("external");
  });

  it("不改原对象(返回新引用),无关字段透传", () => {
    const src = { content: "prompt", refImages: { refImage0: { url: "u", sourceCardId: "s0", sourceType: "card" } } };
    const out = remapCardSourceIds(src, idMap);
    expect(out).not.toBe(src);
    expect(src.refImages.refImage0.sourceCardId).toBe("s0"); // 原对象未被篡改
    expect(out.content).toBe("prompt");
  });

  it("完整性守卫:SOURCE_REF_FIELDS 里**每个**字段都被 remap 覆盖(新增字段忘处理→此测试失败)", () => {
    for (const { field, kind } of SOURCE_REF_FIELDS) {
      const out = remapCardSourceIds({ [field]: sampleValueFor(kind) }, idMap);
      // 该字段引用的 s0 必须已被改写成 n0,且不残留 s0。
      expect(collectCardSourceIds(out), `字段 ${field}(${kind}) 未被 remap`).toEqual(new Set(["n0"]));
    }
  });
});

describe("collectCardSourceIds", () => {
  it("跨全部字段去重收集源卡 id", () => {
    const ids = collectCardSourceIds({
      refImages: { refImage0: { url: "u", sourceCardId: "s0", sourceType: "card" } },
      refVideos: [{ url: "v", sourceCardId: "s1" }],
      upstreamTexts: { s0: "t", s2: "t" }, // s0 与 refImages 重复 → 去重
      upstreamCardId: "s2",
      inlineRefs: [{ id: "r", displayLabel: "@x", source: { type: "upstream", sourceCardId: "s1" } }],
    });
    expect(ids).toEqual(new Set(["s0", "s1", "s2"]));
  });

  it("空 data → 空集合", () => {
    expect(collectCardSourceIds({})).toEqual(new Set());
  });

  it("完整性守卫:每个 kind 的字段都被 collect 覆盖", () => {
    for (const { field, kind } of SOURCE_REF_FIELDS) {
      const ids = collectCardSourceIds({ [field]: sampleValueFor(kind) });
      expect(ids, `字段 ${field}(${kind}) 未被 collect`).toEqual(new Set(["s0"]));
    }
  });
});
