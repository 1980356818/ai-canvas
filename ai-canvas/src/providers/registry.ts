import type { AIProvider, ProviderCapability, ProviderConfig } from "./types";
import { getSetting, setSetting } from "@/platform";

export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private configs = new Map<string, ProviderConfig>();

  register(provider: AIProvider): void {
    this.providers.set(provider.descriptor.id, provider);
  }

  get(id: string): AIProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Provider "${id}" 未注册`);
    return p;
  }

  tryGet(id: string): AIProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): AIProvider[] {
    return [...this.providers.values()];
  }

  getByCapability(cap: ProviderCapability): AIProvider[] {
    return this.getAll().filter((p) =>
      p.descriptor.capabilities.includes(cap),
    );
  }

  getEnabledByCapability(cap: ProviderCapability): AIProvider[] {
    return this.getByCapability(cap).filter((p) => {
      const cfg = this.configs.get(p.descriptor.id);
      return !cfg || cfg.enabled !== false;
    });
  }

  setConfig(id: string, config: ProviderConfig): void {
    this.configs.set(id, config);
    const provider = this.providers.get(id);
    if (provider?.initialize) provider.initialize(config);
  }

  getConfig(id: string): ProviderConfig | undefined {
    return this.configs.get(id);
  }

  async loadConfigs(): Promise<void> {
    const raw = await getSetting("provider_configs");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, ProviderConfig>;
      for (const [id, cfg] of Object.entries(parsed)) {
        this.configs.set(id, cfg);
        const provider = this.providers.get(id);
        if (provider?.initialize) provider.initialize(cfg);
      }
    } catch { /* ignore corrupt data */ }
  }

  async saveConfigs(): Promise<void> {
    const obj: Record<string, ProviderConfig> = {};
    for (const [id, cfg] of this.configs) {
      obj[id] = cfg;
    }
    await setSetting("provider_configs", JSON.stringify(obj));
  }

  listDescriptors() {
    return this.getAll().map((p) => p.descriptor);
  }
}

export const registry = new ProviderRegistry();
