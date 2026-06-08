import { useState, useEffect, useCallback } from "react";
import {
  X,
  ReceiptText,
  Loader2,
  RefreshCw,
  Image as ImageIcon,
  Clapperboard,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { useUIStore } from "@/stores/uiStore";
import { fetchPriceMap } from "@/services/pricing/fetchPrices";
import { buildPriceCatalog } from "@/services/pricing/priceCatalog";
import { priceValue, unitLabel, tokenRateLabel, formatYuan } from "@/services/pricing/format";
import type { PriceRow, PriceCapability, PriceInfo } from "@/services/pricing/types";
import { cn } from "@/lib/utils";

const CAP_META: Record<PriceCapability, { label: string; icon: LucideIcon; color: string }> = {
  IMAGE: { label: "图片", icon: ImageIcon, color: "#a78bfa" },
  VIDEO: { label: "视频", icon: Clapperboard, color: "#fb7185" },
  CHAT: { label: "对话", icon: MessageSquare, color: "#60a5fa" },
};
const CAP_ORDER: PriceCapability[] = ["IMAGE", "VIDEO", "CHAT"];

interface ModelGroup {
  modelName: string;
  capability: PriceCapability;
  variants: PriceRow[];
}

/** 把扁平行集按模型聚合(保持目录顺序,同模型的规格档相邻)。 */
function groupByModel(rows: PriceRow[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.modelName === r.modelName) last.variants.push(r);
    else out.push({ modelName: r.modelName, capability: r.capability, variants: [r] });
  }
  return out;
}

const isToken = (info: PriceInfo | null) =>
  info?.costType === "PER_TOKEN" || info?.costType === "PER_TOKEN_PREPAID";

/** 矩阵单元格取值:按次/秒 → 绝对价;按 token → 单价(元/百万,优先 output)。 */
function matrixCell(info: PriceInfo | null): string {
  if (!info) return "—";
  if (info.costType === "PER_REQUEST" && info.perRequest != null) return formatYuan(info.perRequest);
  if (info.costType === "PER_SECOND" && info.perSecond != null) return formatYuan(info.perSecond);
  const rate = info.outputPer1m ?? info.inputPer1m;
  return rate != null ? formatYuan(rate) : "—";
}

/** 画质 × 分辨率 矩阵(gpt-image-2 等多档图片模型):行=画质,列=分辨率。
 *  把 6 档铺成对齐的小表格,而不是挤成一行价签。 */
function PriceMatrix({ variants }: { variants: PriceRow[] }) {
  const cols: string[] = [];
  for (const v of variants) if (v.resolution && !cols.includes(v.resolution)) cols.push(v.resolution);
  const rows: string[] = [];
  for (const v of variants) if (v.quality && !rows.includes(v.quality)) rows.push(v.quality);
  const at = (q: string, c: string) =>
    variants.find((v) => v.quality === q && v.resolution === c)?.price ?? null;

  return (
    <table className="shrink-0 border-separate border-spacing-x-5 border-spacing-y-1.5">
      <thead>
        <tr>
          <td />
          {cols.map((c) => (
            <th key={c} className="text-right text-[11px] font-medium text-muted-foreground">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((q) => (
          <tr key={q}>
            <th className="pr-1 text-left text-[11px] font-normal text-muted-foreground">{q}</th>
            {cols.map((c) => {
              const txt = matrixCell(at(q, c));
              return (
                <td
                  key={c}
                  className={cn(
                    "text-right text-[14px] font-semibold tabular-nums tracking-tight",
                    txt === "—" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {txt}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 一个模型一行:左侧名称 + 计费单位,右侧价格当主角。 */
function ModelRow({ group, last }: { group: ModelGroup; last: boolean }) {
  const head = group.variants[0]!.price;
  const token = isToken(head);
  const matrix =
    group.variants.length > 1 &&
    group.variants.some((v) => v.quality) &&
    group.variants.some((v) => v.resolution);
  const unit = matrix
    ? token
      ? "每百万 token"
      : unitLabel(head, group.capability)
    : token
      ? ""
      : unitLabel(head, group.capability);

  return (
    <div
      className={cn(
        "flex justify-between gap-6 py-3.5",
        matrix ? "items-start" : "items-center",
        !last && "border-b border-border/40",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[15px] font-medium text-foreground">{group.modelName}</span>
        {unit && <span className="shrink-0 text-[11px] text-muted-foreground">{unit}</span>}
      </div>

      {matrix ? (
        <PriceMatrix variants={group.variants} />
      ) : token ? (
        <div className="max-w-[280px] shrink-0 text-right">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">按用量</div>
          <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
            {tokenRateLabel(head) ?? "按 token 实时结算 · 随时长变化"}
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-5 gap-y-1.5">
          {group.variants.map((v) => {
            const val = priceValue(v.price);
            return (
              <span key={`${v.sku}::${v.specLabel}`} className="inline-flex items-baseline gap-1.5">
                {v.specLabel && (
                  <span className="text-[11px] text-muted-foreground">{v.specLabel}</span>
                )}
                <span
                  className={cn(
                    "text-[15px] font-semibold tabular-nums tracking-tight",
                    val ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {val ?? "—"}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CapabilitySection({ capability, rows }: { capability: PriceCapability; rows: PriceRow[] }) {
  const meta = CAP_META[capability];
  const groups = groupByModel(rows);
  const Icon = meta.icon;

  return (
    <section>
      <div className="mb-0.5 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" style={{ color: meta.color }} />
        <h3 className="text-[13px] font-semibold tracking-wide text-foreground">{meta.label}</h3>
        <span className="text-[11px] text-muted-foreground">{groups.length}</span>
      </div>
      <div>
        {groups.map((g, i) => (
          <ModelRow key={g.modelName} group={g} last={i === groups.length - 1} />
        ))}
      </div>
    </section>
  );
}

export default function PriceListDialog() {
  const visible = useUIStore((s) => s.priceListVisible);
  const toggle = useUIStore((s) => s.togglePriceList);

  const [rows, setRows] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const map = await fetchPriceMap();
      setRows(buildPriceCatalog(map));
      setUpdatedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次打开即拉最新价(不缓存,保证实时)。
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) toggle();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[82vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-foreground/[0.06] text-foreground">
              <ReceiptText className="h-[18px] w-[18px]" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold leading-tight text-foreground">极境价格表</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                按你的会员等级实时计价 · 以实际扣费为准
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {updatedAt && !loading && (
              <span className="mr-1 hidden text-[11px] text-muted-foreground sm:inline">
                {updatedAt}
              </span>
            )}
            <button
              onClick={() => void load()}
              disabled={loading}
              title="刷新最新价格"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("h-[15px] w-[15px]", loading && "animate-spin")} />
            </button>
            <button
              onClick={toggle}
              title="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && rows.length === 0 ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : error && rows.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
              <ReceiptText className="h-10 w-10 opacity-25" />
              <p className="text-sm">价格加载失败</p>
              <p className="max-w-md text-center text-xs opacity-70">{error}</p>
              <button
                onClick={() => void load()}
                className="mt-1 rounded-lg border border-border px-3.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-foreground"
              >
                重试
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {CAP_ORDER.map((cap) => {
                const capRows = rows.filter((r) => r.capability === cap);
                if (capRows.length === 0) return null;
                return <CapabilitySection key={cap} capability={cap} rows={capRows} />;
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
