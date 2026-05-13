/**
 * Platform visibility toggle.
 *
 * Add a provider id (e.g. "jijing") to this set to completely hide
 * the platform from settings, model dropdowns, and provider registration.
 * This is a compile-time developer switch — not exposed to end users.
 */
export const HIDDEN_PLATFORMS: ReadonlySet<string> = new Set([]);

export function isPlatformVisible(id: string): boolean {
  return !HIDDEN_PLATFORMS.has(id);
}

/**
 * Features gated behind hidden platforms.
 *
 * When a platform is hidden, card types and toolbar actions
 * that depend exclusively on that platform are also hidden.
 */
export const HIDDEN_FEATURES = {
  upscale: HIDDEN_PLATFORMS.has("jijing"),
  multiangle: HIDDEN_PLATFORMS.has("jijing"),
} as const;
