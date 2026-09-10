import type { CommandMessage, Provider, ProviderCapability, ProviderCommandResult } from "../protocol.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.provider.toUpperCase(), provider);
  }

  capabilities(): ProviderCapability[] {
    return [...this.providers.values()].map(provider => ({
      provider: provider.provider,
      actions: [...provider.actions],
      discovery: typeof provider.discover === "function"
    }));
  }

  async discover(providerName: string, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const provider = this.providers.get(providerName.toUpperCase());
    if (!provider) throw new Error(`Unsupported provider ${providerName}`);
    if (!provider.discover) throw new Error(`Provider ${provider.provider} does not support discovery`);
    return provider.discover(timeoutMs);
  }

  async execute(command: CommandMessage): Promise<ProviderCommandResult> {
    const provider = this.providers.get(command.provider.toUpperCase());
    if (!provider) throw new Error(`Unsupported provider ${command.provider}`);
    if (!provider.actions.includes(command.action)) {
      throw new Error(`Unsupported ${provider.provider} action ${command.action}`);
    }
    return provider.execute(command);
  }
}
