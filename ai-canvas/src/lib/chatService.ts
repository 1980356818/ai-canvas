import { aiProxy } from "@/platform";
import { CHAT_TITLE_SYSTEM_PROMPT } from "@/lib/systemPrompts";

// ── Auto-title generation ───────────────────────────────────

export async function generateTitle(
  firstUserMessage: string,
  model: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: CHAT_TITLE_SYSTEM_PROMPT },
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
