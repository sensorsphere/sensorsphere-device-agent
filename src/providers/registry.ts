import type { CommandMessage, Provider, ProviderCapability, ProviderCommandResult } from "../protocol.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.provider.toUpperCase(), provider);
  }

  capabilities(): ProviderCapability[] {
    return [...this.providers.values()].map(provider => ({
      provider: provider.provider,
      actions: [...provider.actions]
    }));
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
