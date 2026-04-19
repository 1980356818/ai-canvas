import { aiProxy } from "@/platform";
import type { ChatContentPart, Intent, IntentResult, ChatServiceCallbacks, ChatHistoryMessage } from "@/types";

export type { ChatContentPart, Intent, IntentResult, ChatServiceCallbacks, ChatHistoryMessage } from "@/types";

// ── Intent parsing ──────────────────────────────────────────

export function parseIntent(input: string): IntentResult {
  const trimmed = input.trim();
  if (trimmed.startsWith("/image ")) {
    return { intent: "image", prompt: trimmed.slice(7).trim() };
  }
  if (trimmed.startsWith("/video ")) {
    return { intent: "video", prompt: trimmed.slice(7).trim() };
  }
  return { intent: "chat", prompt: trimmed };
}

const VALID_SIZES = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

export function extractSizeFromPrompt(prompt: string): { cleanPrompt: string; size?: string } {
  const match = prompt.match(/\b(\d{1,2}:\d{1,2})\b/);
  if (match && match[1] && VALID_SIZES.has(match[1])) {
    return { cleanPrompt: prompt.replace(match[0], "").replace(/\s{2,}/g, " ").trim(), size: match[1] };
  }
  return { cleanPrompt: prompt };
}

// ── Auto-title generation ───────────────────────────────────

export async function generateTitle(
  firstUserMessage: string,
  model: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content:
          "Generate a very short title (max 10 Chinese characters or 6 English words) for this conversation. Output ONLY the title, no quotes, no explanation.",
      },
      { role: "user", content: firstUserMessage },
    ],
    max_tokens: 30,
  };

  const raw = await aiProxy("comfly", "/v1/chat/completions", body);
  if (raw.status >= 400) return "新对话";

  try {
    const data = JSON.parse(raw.body);
    let title = data.choices?.[0]?.message?.content?.trim() ?? "";
    title = title.replace(/^["'"""'']+|["'"""'']+$/g, "").trim();
    if (title.length > 20) title = title.slice(0, 20);
    return title || "新对话";
  } catch {
    return "新对话";
  }
}
