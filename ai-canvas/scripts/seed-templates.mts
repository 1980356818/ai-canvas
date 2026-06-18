// 模板种子:把 WORKFLOW_TEMPLATES 里的本地图引用(/src/assets/templates/**)改写成
// **极境 NAS 的内容哈希 URL**,产出:
//   - scripts/templates-seed.json            给 seed-templates-db.py 写 aicat.template
//   - src/config/templatesFallback.json      桌面端离线兜底
//   - scripts/templates-assets-manifest.json 给 upload-template-assets.py(localRel → remoteRel)
//
// ## 内容哈希命名(根治 stale)
// 文件名 = `<base>.<sha16>.<ext>`(sha256 前 16 hex)。换图 = 内容变 = 哈希变 = URL 变 →
// 客户端拉到新定义看到新 URL → 重下新图,旧文件被 prune。同一 URL 内容永不变 → 下载一次。
//
// 图片本体由 upload-template-assets.py 按 manifest scp 到极境 NAS(nginx 静态,**非 COS**);
// 桌面端 Rust `sync_template_assets` 再下到本地 data_dir/template-assets/。
//
// 跑法:npx vite-node scripts/seed-templates.mts(纯改写 + 算哈希,无网络/无 key)。
import { WORKFLOW_TEMPLATES } from "../src/config/workflows";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";

const SRC_PREFIX = "/src/assets/templates/";
const BASE = "https://www.jjowo.com/aicanvas-static/templates/";
const ROOT = process.cwd();
const LOCAL_TPL_DIR = resolve(ROOT, "src/assets/templates");

// localRel(如 covers/white-bg.jpg) → { remoteRel(带哈希), url }
const manifest = new Map<string, { remoteRel: string; url: string }>();

function hashed(localRel: string): { remoteRel: string; url: string } {
  const cached = manifest.get(localRel);
  if (cached) return cached;
  const abs = resolve(LOCAL_TPL_DIR, localRel);
  const sha = createHash("sha256").update(readFileSync(abs)).digest("hex").slice(0, 16);
  const dir = dirname(localRel);
  const ext = extname(localRel);
  const base = basename(localRel, ext);
  const remoteRel = (dir === "." ? "" : dir + "/") + `${base}.${sha}${ext}`;
  const entry = { remoteRel, url: BASE + remoteRel };
  manifest.set(localRel, entry);
  return entry;
}

function rewrite(node: any): any {
  if (typeof node === "string" && node.startsWith(SRC_PREFIX)) {
    return hashed(node.slice(SRC_PREFIX.length)).url;
  }
  if (Array.isArray(node)) return node.map(rewrite);
  if (node && typeof node === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(node)) o[k] = rewrite(node[k]);
    return o;
  }
  return node;
}

const seeded = WORKFLOW_TEMPLATES.map(rewrite);
const manifestArr = [...manifest.entries()].map(([localRel, v]) => ({
  localRel,
  remoteRel: v.remoteRel,
}));

writeFileSync(resolve(ROOT, "scripts/templates-seed.json"), JSON.stringify(seeded, null, 2));
writeFileSync(resolve(ROOT, "src/config/templatesFallback.json"), JSON.stringify(seeded, null, 2));
writeFileSync(
  resolve(ROOT, "scripts/templates-assets-manifest.json"),
  JSON.stringify(manifestArr, null, 2),
);

console.log(`DONE: ${seeded.length} 模板, ${manifest.size} 张图 → 内容哈希 URL`);
console.log("→ scripts/templates-seed.json (DB 种子)");
console.log("→ src/config/templatesFallback.json (桌面端兜底)");
console.log("→ scripts/templates-assets-manifest.json (上传清单)");
console.log("下一步:① upload-template-assets.py 传哈希名到极境 NAS ② seed-templates-db.py 写库");
