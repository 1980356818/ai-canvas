#!/usr/bin/env node
/**
 * 图片落卡几何归一 —— 构建期防回归守卫。
 *
 * ## 它守的不变量
 * 「把一张生成结果图写进 ai_image / ai_multiangle / ai_tryon 卡」的任何路径,都必须让**卡片几何
 * 跟随结果图的真实比例**(经 `services/imageCardGeometry.normalizeImageCardGeometry`,或在编辑器里
 * 用 `imageCardSizeFromUrl` / `sizeFromRatio` 自行定尺寸)。否则 3:4 竖图会被塞进默认/导入的方框里
 * 被 object-cover 裁切显示成「方形」。
 *
 * ## 检测策略(低误报)
 * 只针对**内联字面量**写法:`updateCardData(id, { …imageUrl/results/resultImageUrl… })` —— 这是
 * ad-hoc 新路径最可能出现的形态。命中此写法的文件,必须引用下列「已归一」符号之一,否则报错:
 *   - normalizeImageCardGeometry  (统一收口,首选)
 *   - imageCardSizeFromUrl / sizeFromRatio  (编辑器自行按比例定尺寸)
 * 或在文件中显式标注 `geometry-exempt:<原因>`(如「同图换本地址不变比例」)。
 *
 * 经 `patch` 变量写的中心路径(taskBridge)不在内联检测内,改由下方「钉死清单」PINNED 兜底:
 * 这些中心文件**必须**引用 normalizeImageCardGeometry,防止有人把归一悄悄删掉。
 *
 * 退出码:0 全过;1 有违例;2 脚本自身异常。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "..", "src");

/** 写进卡片即应触发几何归一的「图片产物」字段键。 */
const RESULT_KEYS = ["imageUrl", "resultImageUrl", "results"];
/** 文件里出现任一即视为「已做几何归一」。 */
const SANCTIONED = [
  "normalizeImageCardGeometry",
  "imageCardSizeFromUrl",
  "sizeFromRatio",
];
const EXEMPT_MARK = "geometry-exempt";

/** 钉死清单:中心落卡路径必须引用归一函数(防止归一被静默移除)。 */
const PINNED = [
  { file: "services/taskBridge.ts", needs: "normalizeImageCardGeometry" },
  { file: "services/cardRunner.ts", needs: "normalizeImageCardGeometry" },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** 从 `updateCardData?(` 起,按括号配平截取调用实参文本(上限 600 字符防失控)。 */
function callArgText(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx, end = Math.min(src.length, openParenIdx + 600); i < end; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx, openParenIdx + 600);
}

const CALL_RE = /updateCardData?\s*\(/g;
const KEY_RE = new RegExp(`\\b(${RESULT_KEYS.join("|")})\\s*:`);

let checks = 0;
const violations = [];

for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  const rel = relative(SRC, file).split(sep).join("/");

  let m;
  CALL_RE.lastIndex = 0;
  let hasInlineResultWrite = false;
  while ((m = CALL_RE.exec(src))) {
    const arg = callArgText(src, m.index + m[0].length - 1);
    if (KEY_RE.test(arg)) {
      hasInlineResultWrite = true;
      break;
    }
  }
  if (hasInlineResultWrite) {
    checks++;
    const ok = SANCTIONED.some((s) => src.includes(s)) || src.includes(EXEMPT_MARK);
    if (!ok) {
      violations.push(
        `src/${rel}\n` +
          `    内联把结果图写进卡片(updateCardData{…imageUrl/results…}),但全文未做几何归一。\n` +
          `    修法:写完后 \`void normalizeImageCardGeometry(cardId, url)\`(见 services/imageCardGeometry.ts),\n` +
          `    或编辑器自行 imageCardSizeFromUrl/sizeFromRatio 定尺寸;确属同图换址等无需归一,加注释 // ${EXEMPT_MARK}:<原因>`,
      );
    }
  }
}

for (const pin of PINNED) {
  checks++;
  const abs = join(SRC, ...pin.file.split("/"));
  let src = "";
  try {
    src = readFileSync(abs, "utf8");
  } catch {
    violations.push(`src/${pin.file}\n    钉死清单文件缺失(中心落卡路径不应消失)。`);
    continue;
  }
  if (!src.includes(pin.needs)) {
    violations.push(
      `src/${pin.file}\n    中心落卡路径必须引用 \`${pin.needs}\`(几何归一被移除会让落卡比例 bug 复发)。`,
    );
  }
}

if (violations.length) {
  console.error("[check-image-landing] 失败:发现未做几何归一的图片落卡路径\n");
  for (const v of violations) console.error("  ✗ " + v + "\n");
  console.error(
    `[check-image-landing] ${violations.length} 处违例 / 共 ${checks} 项检查。` +
      `详见 src/services/imageCardGeometry.ts 与 scripts/check-image-landing.mjs 头注释。`,
  );
  process.exit(1);
}

console.log(`[check-image-landing] OK: ${checks}/${checks} 项几何归一检查通过`);
process.exit(0);
