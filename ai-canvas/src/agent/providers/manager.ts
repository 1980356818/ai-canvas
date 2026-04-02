import type { ProviderCapability } from "../types";
import type { AIProvider } from "./base";

export class ProviderManager {
  private providers = new Map<string, AIProvider>();
  private defaultId: string | null = null;

  register(provider: AIProvider) {
    this.providers.set(provider.descriptor.id, provider);
    if (!this.defaultId) this.defaultId = provider.descriptor.id;
  }

  get(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  resolve(required: ProviderCapability[]): AIProvider {
    for (const p of this.providers.values()) {
      const caps = p.descriptor.capabilities;
      if (required.every((c) => caps.includes(c))) return p;
    }
    const names = [...this.providers.values()]
      .map((p) => `${p.descriptor.id}(${p.descriptor.capabilities.join(",")})`)
      .join(", ");
    throw new Error(
      `No provider supports [${required.join(", ")}]. Registered: ${names || "none"}`,
    );
  }

  getDefault(): AIProvider {
    if (!this.defaultId) throw new Error("No provider registered");
    return this.providers.get(this.defaultId)!;
  }

  setDefault(id: string) {
    if (!this.providers.has(id))
      throw new Error(`Provider '${id}' not registered`);
    this.defaultId = id;
  }

  listProviders() {
    return [...this.providers.values()].map((p) => p.descriptor);
  }
}
