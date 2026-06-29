import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  X, Loader2, Sparkles, RefreshCw, AlertCircle, Check, Clapperboard, AlertTriangle,
} from "lucide-react";
import { useCardStore } from "@/stores/cardStore";
import { useUIStore } from "@/stores/uiStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { autoSave } from "@/lib/autoSave";
import { hasApiKey } from "@/platform";
import { friendlyError } from "@/lib/errors";
import { resolveDefaultModelForCardType } from "@/services/modelDefaults";
import ModelSelector from "@/features/editor/ModelSelector";
import { runScriptSeedance } from "@/services/script/runScriptSteps";
import MarkdownContent from "@/shared/MarkdownContent";
import { getSkipCostConfirm, setSkipCostConfirm } from "@/lib/scriptPrefs";
import {
  type ScriptConfig, type ScriptCardData,
  DEFAULT_SCRIPT_CONFIG, extractMentions,
  BUSINESS_OPTIONS, LANGUAGE_OPTIONS, CONTENT_TYPE_OPTIONS, DURATION_OPTIONS,
} from "@/lib/scriptModel";
import { cn } from "@/lib/utils";

function materialCount(d: ScriptCardData): number {
  const imgs = (d.refImages ? Object.keys(d.refImages).length : 0)
    + (d.directMedia ?? []).filter((m) => m.kind === "image").length;
  const vids = d.refVideos?.length ?? 0;
  const txt = d.upstreamTexts ? Object.keys(d.upstreamTexts).length : 0;
  return imgs + vids + txt;
}

/** 连入素材的指纹（url 集合）；用于判断生成后素材是否变化。 */
function materialFingerprint(d: ScriptCardData): string {
  const imgs = Object.values(d.refImages ?? {}).map((e) => e.url).sort();
  const direct = (d.directMedia ?? []).map((m) => m.url).sort();
  const vids = (d.refVideos ?? []).map((v) => v.url).sort();
  return JSON.stringify([imgs, direct, vids]);
}

export default function ScriptWizard() {
  const cardId = useUIStore((s) => s.scriptWizardCardId);
  if (!cardId) return null;
  return <WizardBody key={cardId} cardId={cardId} />;
}

const STEPS = ["脚本配置", "生成脚本"];

function WizardBody({ cardId }: { cardId: string }) {
  const close = useUIStore((s) => s.closeScriptWizard);
  const updateCardData = useCardStore((s) => s.updateCardData);
  const card = useCardStore((s) => s.cards.get(cardId));
  const liveData = (card?.data ?? {}) as ScriptCardData;
  const hasMaterial = materialCount(liveData) > 0;

  const [model, setModel] = useState(liveData.model ?? "");
  const [step, setStep] = useState<number>(liveData._wizardStep ?? (getSkipCostConfirm() ? 1 : 0));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  // 合并默认值: 老卡片的 config 可能缺新字段, 用默认补齐。
  const [config, setConfig] = useState<ScriptConfig>({ ...DEFAULT_SCRIPT_CONFIG, ...liveData.config });
  // 生成出的 markdown（下游真相）；初始化为上次已落库的 result。
  const [md, setMd] = useState<string>(liveData.result ?? "");
  const abortRef = useRef<AbortController | null>(null);
  // runEpoch 取代防护——慢返回的过期结果不写回；stepRef 给失败记录用。
  const epochRef = useRef(0);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // 生成后素材是否变化（指纹比对）→ 提示「建议重新生成」。
  const materialsChanged =
    !!md && !!liveData._analyzedFingerprint &&
    liveData._analyzedFingerprint !== materialFingerprint(liveData);
  // 上次某步失败（关弹窗重开时提示）。
  const lastStepError = liveData._lastStepError;
  // 脚本里引用到的素材标签（驱动预览底部的 @标签 chip）。
  const usedMentions = useMemo(() => (md ? extractMentions(md) : []), [md]);

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

  /** API Key 预检 + 进度/错误骨架(仿 runEditorGeneration) + runEpoch 取代防护。 */
  const runStep = useCallback(async (fn: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>) => {
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
    const myEpoch = ++epochRef.current;
    // 仅当本次仍是最新一轮且未被取消时，结果/错误才允许写回（防慢返回覆盖新一轮）。
    const isCurrent = () => epochRef.current === myEpoch && !ac.signal.aborted;
    setRunning(true); setError(null); setStreamText("");
    try {
      await fn(ac.signal, isCurrent);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") { /* 取消,静默 */ }
      else if (isCurrent()) {
        const msg = friendlyError(e instanceof Error ? e.message : String(e));
        setError(msg);
        persist({ _lastStepError: { step: stepRef.current, message: msg } });
      }
    } finally {
      if (abortRef.current === ac) { setRunning(false); abortRef.current = null; }
    }
  }, [persist]);

  const doGenerate = useCallback(() => {
    const c = useCardStore.getState().getCard(cardId);
    if (!c) return;
    void runStep(async (signal, isCurrent) => {
      const text = await runScriptSeedance(c, config, { signal, onText: setStreamText });
      if (!isCurrent()) return;
      setMd(text);
      // markdown 原文即真相：直接落 result（提交 + 触发下游传播）。
      persist({
        result: text,
        _resultStale: false,
        _analyzedFingerprint: materialFingerprint(c.data as ScriptCardData),
        config,
        _lastStepError: undefined,
      });
    });
  }, [cardId, config, runStep, persist]);

  const finish = useCallback(() => { persist({ _wizardStep: undefined }); close(); }, [persist, close]);

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
            const done = (n === 1 && step > 1) || (n === 2 && !!md);
            const active = step === n;
            return (
              <button
                key={label}
                disabled={running}
                onClick={() => goStep(n)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors",
                  active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
                  running && "cursor-not-allowed opacity-50",
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
            {!running && !error && lastStepError && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="flex-1 text-[13px] text-destructive">
                  上次「{STEPS[(lastStepError.step ?? 1) - 1] ?? "步骤"}」失败：{lastStepError.message}，可重试。
                </p>
              </div>
            )}
            {!running && materialsChanged && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="flex-1 text-[13px] text-amber-700 dark:text-amber-300">
                  连入素材自上次生成后已变化，建议重新生成以保持脚本与素材一致。
                </p>
              </div>
            )}

            {running ? (
              <RunningView streamText={streamText} />
            ) : step === 1 ? (
              <Step1 config={config} hasMaterial={hasMaterial} onChange={(c) => { setConfig(c); persist({ config: c }); }} />
            ) : (
              <Step2 md={md} usedMentions={usedMentions} hasMaterial={hasMaterial} onGenerate={doGenerate} />
            )}
          </div>

          {/* footer */}
          {!running && (
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
              <button
                onClick={() => goStep(1)}
                disabled={step <= 1}
                className="rounded-lg border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                上一步
              </button>
              <div className="flex items-center gap-2">
                {step === 1 && (
                  <button onClick={() => { goStep(2); doGenerate(); }} disabled={!hasMaterial}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
                    <Sparkles className="h-4 w-4" /> 生成脚本
                  </button>
                )}
                {step === 2 && (
                  <>
                    {md && (
                      <button onClick={doGenerate}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-muted">
                        <RefreshCw className="h-3.5 w-3.5" /> 重新生成
                      </button>
                    )}
                    <button onClick={finish} disabled={!md}
                      className="rounded-lg bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
                      完成
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
  return (
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
      <h3 className="text-base font-semibold">立即「帮我写」</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">将调用视觉对话模型一次，按网关实际用量计费。</p>
      <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
        <div className="mb-2.5 text-[13px] font-medium">本次任务</div>
        <ul className="space-y-2 text-[13px] text-foreground/80">
          <li className="flex items-center gap-2.5">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">1</span>
            分析产品图并生成分镜脚本 + Seedance 提示词
          </li>
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

function RunningView({ streamText }: { streamText: string }) {
  const tail = streamText.length > 1200 ? "…" + streamText.slice(-1200) : streamText;
  return (
    <div className="flex flex-col items-center gap-4 py-10">
      <Loader2 className="h-8 w-8 animate-spin text-primary/70" />
      <p className="text-sm font-medium text-muted-foreground">正在分析素材并生成脚本…</p>
      {tail && (
        <pre className="max-h-80 w-full max-w-xl overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground/80">
          {tail}
        </pre>
      )}
    </div>
  );
}

function Step1({ config, hasMaterial, onChange }: { config: ScriptConfig; hasMaterial: boolean; onChange: (c: ScriptConfig) => void }) {
  return (
    <div className="space-y-5">
      {!hasMaterial && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
          尚未连入素材，请先把产品图片卡片连到本卡，再生成脚本。
        </p>
      )}
      <PillRow label="业务场景" options={BUSINESS_OPTIONS} value={config.business} onChange={(business) => onChange({ ...config, business })} />
      <PillRow label="语言" options={LANGUAGE_OPTIONS} value={config.language} onChange={(language) => onChange({ ...config, language })} />
      <PillRow label="内容类型" options={CONTENT_TYPE_OPTIONS} value={config.contentType} onChange={(contentType) => onChange({ ...config, contentType })} />
      <div>
        <PillRow label="视频时长" options={DURATION_OPTIONS} value={config.durationSeconds} onChange={(durationSeconds) => onChange({ ...config, durationSeconds })} />
        <p className="mt-1.5 text-[11px] text-muted-foreground/70">脚本会自动拆成多个镜头，每镜引用具体参考图，画面不出现任何文字。</p>
      </div>
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

function Step2({
  md, usedMentions, hasMaterial, onGenerate,
}: {
  md: string;
  usedMentions: string[];
  hasMaterial: boolean;
  onGenerate: () => void;
}) {
  if (!md) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <Sparkles className="h-10 w-10 text-primary/50" />
        <p className="text-sm font-medium">点击生成分镜脚本与 Seedance 2.0 提示词</p>
        {!hasMaterial && <p className="text-[13px] text-amber-600 dark:text-amber-400">尚未连入素材，请先连入产品图片。</p>}
        <button onClick={onGenerate} disabled={!hasMaterial}
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40">
          <Sparkles className="h-4 w-4" /> 生成脚本
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {usedMentions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">引用素材：</span>
          {usedMentions.map((m) => (
            <span key={m} className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">@{m}</span>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-border bg-muted/10 p-4">
        <MarkdownContent content={md} />
      </div>
    </div>
  );
}

function PillRow<T extends string | number>({
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
