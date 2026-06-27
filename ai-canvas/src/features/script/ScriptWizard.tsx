import { useState, useEffect, useRef, useCallback } from "react";
import {
  X, Loader2, Sparkles, RefreshCw, Plus, Trash2, AlertCircle, Check, Clapperboard,
} from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { friendlyError } from "@/lib/errors";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import ModelSelector from "@/features/editor/ModelSelector";
import {
  runScriptAnalyze, runScriptGenerate, runRefVideoBreakdown,
} from "@/services/script/runScriptSteps";
import { scriptToMarkdown } from "@/lib/scriptSerialize";
import { getSkipCostConfirm, setSkipCostConfirm } from "@/lib/scriptPrefs";
import {
  type ProductInsights, type ScriptConfig, type StoryboardScript, type ScriptCardData,
  DEFAULT_SCRIPT_CONFIG,
  BUSINESS_OPTIONS, LANGUAGE_OPTIONS, CONTENT_TYPE_OPTIONS, SHOOTING_STYLE_OPTIONS,
} from "@/lib/scriptModel";
import { cn } from "@/lib/utils";

function materialCount(d: ScriptCardData): number {
  const imgs = (d.refImages ? Object.keys(d.refImages).length : 0)
    + (d.directMedia ?? []).filter((m) => m.kind === "image").length;
  const vids = d.refVideos?.length ?? 0;
  const txt = d.upstreamTexts ? Object.keys(d.upstreamTexts).length : 0;
  return imgs + vids + txt;
}

export default function ScriptWizard() {
  const cardId = useUIStore((s) => s.scriptWizardCardId);
  if (!cardId) return null;
  return <WizardBody key={cardId} cardId={cardId} />;
}

const STEPS = ["分析我的素材", "脚本配置", "预览视频脚本"];

function WizardBody({ cardId }: { cardId: string }) {
  const close = useUIStore((s) => s.closeScriptWizard);
  const updateCardData = useCardStore((s) => s.updateCardData);
  const card = useCardStore((s) => s.cards.get(cardId));
  const liveData = (card?.data ?? {}) as ScriptCardData;
  const hasMaterial = materialCount(liveData) > 0;
  const hasVideo = (liveData.refVideos?.length ?? 0) > 0;

  const [model, setModel] = useState(liveData.model ?? "");
  const [step, setStep] = useState<number>(liveData._wizardStep ?? (getSkipCostConfirm() ? 1 : 0));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [insights, setInsights] = useState<ProductInsights | null>(liveData.insights ?? null);
  const [config, setConfig] = useState<ScriptConfig>(liveData.config ?? DEFAULT_SCRIPT_CONFIG);
  const [script, setScript] = useState<StoryboardScript | null>(liveData.script ?? null);
  const breakdownRef = useRef<string | undefined>(liveData.refVideoBreakdown);
  const abortRef = useRef<AbortController | null>(null);

  const persist = useCallback(
    (patch: Partial<ScriptCardData>) => {
      updateCardData(cardId, patch as Record<string, unknown>);
      autoSave.markDirty(cardId);
    },
    [cardId, updateCardData],
  );

  const goStep = useCallback((s: number) => { setStep(s); setError(null); persist({ _wizardStep: s }); }, [persist]);

  // 解析默认视觉模型(空 model 时)。
  useEffect(() => {
    if (model) return;
    let cancelled = false;
    resolveDefaultModelForCardType("ai_script").then((ref) => {
      if (cancelled || !ref) return;
      setModel(ref.modelId);
      persist({ model: ref.modelId, provider: ref.providerId });
    });
    return () => { cancelled = true; };
  }, [model, persist]);

  // 关闭/卸载时中止在飞的调用。
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleClose = useCallback(() => { abortRef.current?.abort(); close(); }, [close]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) { e.preventDefault(); handleClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [running, handleClose]);

  const handleModelChange = useCallback(
    (modelId: string, providerId: string) => {
      setModel(modelId);
      persist({ model: modelId, provider: providerId });
      useSettingsStore.getState().setLastModel("chat", modelId, providerId);
    },
    [persist],
  );

  /** API Key 预检 + 进度/错误骨架(仿 runEditorGeneration)。 */
  const runStep = useCallback(async (fn: (signal: AbortSignal) => Promise<void>) => {
    if (!(await hasApiKey())) {
      useUIStore.getState().addToast({
        type: "warning", title: "请先配置 API Key", description: "前往设置页面配置你的 API Key",
        action: { label: "打开设置", onClick: () => useUIStore.getState().toggleSettings() },
        duration: 5000,
      });
      return;
    }
    const ac = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ac;
    setRunning(true); setError(null); setStreamText("");
    try {
      await fn(ac.signal);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") { /* 取消,静默 */ }
      else setError(friendlyError(e instanceof Error ? e.message : String(e)));
    } finally {
      if (abortRef.current === ac) { setRunning(false); abortRef.current = null; }
    }
  }, []);

  const doAnalyze = useCallback(() => {
    const c = useCardStore.getState().getCard(cardId);
    if (!c) return;
    void runStep(async (signal) => {
      const res = await runScriptAnalyze(c, { signal, onText: setStreamText });
      setInsights(res);
      persist({ insights: res, _analyzedAt: new Date().toISOString() });
    });
  }, [cardId, runStep, persist]);

  const doGenerate = useCallback(() => {
    const c = useCardStore.getState().getCard(cardId);
    if (!c || !insights) return;
    void runStep(async (signal) => {
      let breakdown = breakdownRef.current;
      if (config.useReferenceVideo && hasVideo && !breakdown) {
        breakdown = await runRefVideoBreakdown(c, { signal });
        breakdownRef.current = breakdown;
        persist({ refVideoBreakdown: breakdown });
      }
      const s = await runScriptGenerate(c, insights, config, breakdown, { signal, onText: setStreamText });
      setScript(s);
      persist({ script: s, config });
    });
  }, [cardId, insights, config, hasVideo, runStep, persist]);

  const apply = useCallback(() => {
    if (!script) return;
    persist({
      result: scriptToMarkdown(script, insights ?? undefined),
      _resultStale: false, _wizardStep: undefined,
      script, config, insights: insights ?? undefined,
    });
    close();
  }, [script, insights, config, persist, close]);

  // ── 计费确认(step 0)= 独立小弹窗 ──
  if (step === 0) {
    return (
      <Overlay onBackdrop={running ? undefined : handleClose}>
        <CostConfirmCard
          onCancel={handleClose}
          onConfirm={(skip) => { if (skip) setSkipCostConfirm(true); goStep(1); }}
        />
      </Overlay>
    );
  }

  return (
    <Overlay onBackdrop={running ? undefined : handleClose}>
      <div
        className="flex h-[82vh] max-h-[760px] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 左侧步骤栏 */}
        <aside className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-muted/20 p-4">
          <div className="mb-3 flex items-center gap-1.5 px-1 text-sm font-semibold">
            <Clapperboard className="h-4 w-4 text-primary" /> 帮我写
          </div>
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = (n === 1 && insights) || (n === 2 && step > 2) || (n === 3 && script);
            const active = step === n;
            const reachable = n <= step || (n === 2 && insights) || (n === 3 && insights);
            return (
              <button
                key={label}
                disabled={running || !reachable}
                onClick={() => goStep(n)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
                  (running || !reachable) && "cursor-not-allowed opacity-50",
                )}
              >
                <span className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]",
                  active ? "bg-primary text-primary-foreground" : done ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground",
                )}>
                  {done && !active ? <Check className="h-3 w-3" /> : n}
                </span>
                <span className="min-w-0 truncate font-medium">{label}</span>
              </button>
            );
          })}
        </aside>

        {/* 右侧内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
            <h2 className="flex-1 truncate text-sm font-semibold">{STEPS[step - 1]}</h2>
            <div className="w-56"><ModelSelector capability="CHAT" value={model} providerId={liveData.provider} onChange={handleModelChange} /></div>
            <button onClick={handleClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="flex-1 text-[13px] text-destructive">{error}</p>
              </div>
            )}

            {running ? (
              <RunningView label={step === 1 ? "正在分析素材…" : "正在生成脚本…"} streamText={streamText} />
            ) : step === 1 ? (
              <Step1
                hasMaterial={hasMaterial}
                insights={insights}
                onAnalyze={doAnalyze}
                onChange={(next) => { setInsights(next); persist({ insights: next }); }}
              />
            ) : step === 2 ? (
              <Step2 config={config} hasVideo={hasVideo} onChange={(c) => { setConfig(c); persist({ config: c }); }} />
            ) : (
              <Step3 script={script} onGenerate={doGenerate} />
            )}
          </div>

          {/* footer */}
          {!running && (
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
              <button
                onClick={() => goStep(Math.max(1, step - 1))}
                disabled={step <= 1}
                className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一步
              </button>
              <div className="flex items-center gap-2">
                {step === 1 && (
                  <button onClick={() => goStep(2)} disabled={!insights}
                    className="rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
                    下一步
                  </button>
                )}
                {step === 2 && (
                  <button onClick={() => { goStep(3); doGenerate(); }}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
                    <Sparkles className="h-4 w-4" /> 生成脚本
                  </button>
                )}
                {step === 3 && (
                  <>
                    <button onClick={doGenerate}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-muted">
                      <RefreshCw className="h-3.5 w-3.5" /> 重新生成
                    </button>
                    <button onClick={apply} disabled={!script}
                      className="rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
                      应用脚本
                    </button>
                  </>
                )}
              </div>
            </footer>
          )}
        </div>
      </div>
    </Overlay>
  );
}

// ── 子组件 ──

function Overlay({ children, onBackdrop }: { children: React.ReactNode; onBackdrop?: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onBackdrop?.(); }}
    >
      {children}
    </div>
  );
}

function CostConfirmCard({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (skip: boolean) => void }) {
  const [skip, setSkip] = useState(false);
  const ITEMS = [
    { n: 1, label: "分析我的素材" },
    { n: 2, label: "参考视频拆解（可选）" },
    { n: 3, label: "生成视频脚本" },
  ];
  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
      <h3 className="text-base font-semibold">立即「帮我写」</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">以下步骤将调用对话模型，按网关实际用量计费。</p>
      <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
        <div className="mb-2.5 text-[13px] font-medium">计费明细</div>
        <ul className="space-y-2 text-[13px] text-foreground/80">
          {ITEMS.map((it) => (
            <li key={it.n} className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">{it.n}</span>
              {it.label}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-[12px] text-muted-foreground">实际扣费以任务成功结果为准，失败不计费。</p>
      <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
        <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--primary)]" />
        不再提示
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted">取消</button>
        <button onClick={() => onConfirm(skip)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">继续生成</button>
      </div>
    </div>
  );
}

function RunningView({ label, streamText }: { label: string; streamText: string }) {
  const tail = streamText.length > 600 ? "…" + streamText.slice(-600) : streamText;
  return (
    <div className="flex flex-col items-center gap-4 py-10">
      <Loader2 className="h-8 w-8 animate-spin text-primary/70" />
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      {tail && (
        <pre className="max-h-64 w-full max-w-xl overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground/80">
          {tail}
        </pre>
      )}
    </div>
  );
}

function Step1({
  hasMaterial, insights, onAnalyze, onChange,
}: {
  hasMaterial: boolean;
  insights: ProductInsights | null;
  onAnalyze: () => void;
  onChange: (next: ProductInsights) => void;
}) {
  if (!insights) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Sparkles className="h-10 w-10 text-primary/50" />
        <p className="text-sm font-medium">分析连入的图片 / 视频素材，自动提炼商品洞察</p>
        {!hasMaterial && <p className="text-[13px] text-amber-600 dark:text-amber-400">尚未连入素材，请先把图片/视频卡片连到本卡。</p>}
        <button onClick={onAnalyze} disabled={!hasMaterial}
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
          <Sparkles className="h-4 w-4" /> 分析素材
        </button>
      </div>
    );
  }
  const set = (patch: Partial<ProductInsights>) => onChange({ ...insights, ...patch });
  return (
    <div className="space-y-5">
      {insights.materials.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold text-muted-foreground">素材分析</div>
          <div className="space-y-2">
            {insights.materials.map((m, i) => (
              <div key={i} className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[13px]">
                <span className="font-medium text-foreground">{m.ref}</span>
                <span className="text-muted-foreground"> · {m.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <LabeledInput label="商品名称" value={insights.productName} onChange={(v) => set({ productName: v })} />
        <LabeledInput label="商品类目" value={insights.category} onChange={(v) => set({ category: v })} />
      </div>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <ChipGroup title="产品特性" items={insights.features} onChange={(v) => set({ features: v })} />
        <ChipGroup title="核心卖点" items={insights.sellingPoints} onChange={(v) => set({ sellingPoints: v })} />
        <ChipGroup title="目标人群" items={insights.targetAudience} onChange={(v) => set({ targetAudience: v })} />
        <ChipGroup title="使用场景" items={insights.usageScenarios} onChange={(v) => set({ usageScenarios: v })} />
      </div>
    </div>
  );
}

function Step2({ config, hasVideo, onChange }: { config: ScriptConfig; hasVideo: boolean; onChange: (c: ScriptConfig) => void }) {
  return (
    <div className="space-y-5">
      <PillRow label="业务场景" options={BUSINESS_OPTIONS} value={config.business} onChange={(business) => onChange({ ...config, business })} />
      <PillRow label="语言" options={LANGUAGE_OPTIONS} value={config.language} onChange={(language) => onChange({ ...config, language })} />
      <PillRow label="内容类型" options={CONTENT_TYPE_OPTIONS} value={config.contentType} onChange={(contentType) => onChange({ ...config, contentType })} />
      <PillRow label="拍摄方式" options={SHOOTING_STYLE_OPTIONS} value={config.shootingStyle} onChange={(shootingStyle) => onChange({ ...config, shootingStyle })} />
      {hasVideo && (
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" checked={config.useReferenceVideo} onChange={(e) => onChange({ ...config, useReferenceVideo: e.target.checked })} className="h-3.5 w-3.5 accent-[var(--primary)]" />
          参考视频拆解（先分析连入的视频，再据其结构生成脚本）
        </label>
      )}
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">补充说明</div>
        <textarea
          value={config.notes ?? ""}
          onChange={(e) => onChange({ ...config, notes: e.target.value })}
          placeholder="可选：补充卖点、场景描述、结尾文案等"
          rows={4}
          className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none ring-ring placeholder:text-muted-foreground/50 focus:ring-1"
        />
      </div>
    </div>
  );
}

function Step3({ script, onGenerate }: { script: StoryboardScript | null; onGenerate: () => void }) {
  if (!script) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Sparkles className="h-10 w-10 text-primary/50" />
        <p className="text-sm font-medium">点击生成逐秒分镜脚本</p>
        <button onClick={onGenerate} className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          <Sparkles className="h-4 w-4" /> 生成脚本
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4 text-[13px]">
      <section>
        <div className="mb-1.5 text-xs font-semibold text-muted-foreground">视频总览</div>
        {script.overview.styleKeywords.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {script.overview.styleKeywords.map((k, i) => (
              <span key={i} className="rounded-full bg-primary/10 px-2 py-0.5 text-[12px] text-primary">{k}</span>
            ))}
          </div>
        )}
        {script.overview.note && <p className="text-foreground/80">{script.overview.note}</p>}
      </section>
      {(script.sceneLighting.scene || script.sceneLighting.lighting) && (
        <section>
          <div className="mb-1.5 text-xs font-semibold text-muted-foreground">场景与光线</div>
          {script.sceneLighting.scene && <p className="text-foreground/80">拍摄场景：{script.sceneLighting.scene}</p>}
          {script.sceneLighting.lighting && <p className="text-foreground/80">布光与质感：{script.sceneLighting.lighting}</p>}
        </section>
      )}
      <section>
        <div className="mb-1.5 text-xs font-semibold text-muted-foreground">逐秒镜头拆解</div>
        <div className="space-y-2.5">
          {script.shots.map((s, i) => (
            <div key={i} className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="mb-1 text-[13px] font-semibold text-primary">{s.timeRange || `镜头 ${i + 1}`}</div>
              <ShotLine label="景别/角度" v={s.shotType} />
              <ShotLine label="运镜" v={s.cameraMove} />
              <ShotLine label="场景与对白" v={s.sceneDialogue} />
              <ShotLine label="口播旁白" v={s.voiceover} />
              <ShotLine label="音效/BGM" v={s.audioBgm} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ShotLine({ label, v }: { label: string; v: string }) {
  if (!v) return null;
  return (
    <p className="text-[12.5px] leading-relaxed text-foreground/80">
      <span className="text-muted-foreground">{label}：</span>{v}
    </p>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[13px] outline-none ring-ring focus:ring-1" />
    </div>
  );
}

function ChipGroup({ title, items, onChange }: { title: string; items: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => { if (draft.trim()) { onChange([...items, draft.trim()]); setDraft(""); } };
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-foreground">{title}</div>
      <div className="space-y-1.5">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5">
            <input value={it} onChange={(e) => { const n = [...items]; n[i] = e.target.value; onChange(n); }}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            <button onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              className="shrink-0 text-muted-foreground transition-colors hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
            placeholder="添加一项，回车确认"
            className="min-w-0 flex-1 rounded-md border border-dashed border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/40" />
          <button onClick={add} className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function PillRow<T extends string>({
  label, options, value, onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={cn(
              "rounded-lg border px-3.5 py-1.5 text-[13px] transition-colors",
              value === o.value ? "border-primary bg-primary/10 text-primary" : "border-border text-foreground/70 hover:border-primary/40",
            )}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
