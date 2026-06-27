/**
 * 把结构化分镜脚本序列化成 markdown 文本，写入 `data.result`。
 * 这是该节点的下游唯一真相（extractOutput 当 text 下发，下游视频/图片卡读取）。
 *
 * @图1/@视频1 等素材标签**原样透传**（不转义），让下游视频卡能识别要配哪些素材。
 */

import type { ProductInsights, StoryboardScript } from "@/lib/scriptModel";

export function scriptToMarkdown(script: StoryboardScript, insights?: ProductInsights): string {
  const lines: string[] = [];
  const title =
    script.title || (insights?.productName ? `${insights.productName} · 视频脚本` : "视频脚本");
  lines.push(`# ${title}`);

  if (script.summary) {
    lines.push("");
    lines.push(`> ${script.summary}`);
  }

  lines.push("");
  lines.push("## 视频总览");
  if (script.overview.styleKeywords.length) {
    lines.push(`- 整体风格关键词：${script.overview.styleKeywords.join("、")}`);
  }
  if (script.overview.note) lines.push(`- 说明：${script.overview.note}`);

  if (script.scenes.length > 0) {
    lines.push("");
    lines.push("## 场景与光线");
    script.scenes.forEach((sc, i) => {
      const head = sc.name || `场景${i + 1}`;
      const parts: string[] = [];
      if (sc.setup) parts.push(sc.setup);
      if (sc.lighting) parts.push(`光线：${sc.lighting}`);
      lines.push(`- ${head}${parts.length ? `：${parts.join("；")}` : ""}`);
    });
  }

  lines.push("");
  lines.push("## 逐秒镜头拆解");
  script.shots.forEach((s, i) => {
    lines.push("");
    lines.push(`### ${s.timeRange || `镜头 ${i + 1}`}`);
    if (s.shotType) lines.push(`- 景别/角度：${s.shotType}`);
    if (s.cameraMove) lines.push(`- 运镜：${s.cameraMove}`);
    if (s.sceneDialogue) lines.push(`- 场景与对白：${s.sceneDialogue}`);
    if (s.voiceover) lines.push(`- 口播旁白${s.tone ? `（${s.tone}）` : ""}：${s.voiceover}`);
    if (s.audioBgm) lines.push(`- 音效/BGM：${s.audioBgm}`);
  });

  return lines.join("\n");
}
