import { aiProxy } from "@/platform";

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
