import { Bonjour } from "bonjour-service";
import { entityId, openEspHomeClient } from "esphome-client";
import type { CommandMessage, DeviceIdentity, Provider, ProviderCommandResult } from "../protocol.js";

type EspHomeEntityType = "light" | "switch";

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return value == null ? "" : String(value).trim();
}

function ipv4Address(service: any): string | null {
  const addresses = Array.isArray(service?.addresses) ? service.addresses : [];
  const ipv4 = addresses.find((value: unknown) => typeof value === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value));
  return typeof ipv4 === "string" ? ipv4 : null;
}

function normalizeMacAddress(value: unknown): string {
  const compact = textValue(value).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (compact.length !== 12) return textValue(value);
  return compact.match(/.{2}/g)?.join(":") ?? compact;
}


interface ResolvedTarget {
  host: string;
  entityType: EspHomeEntityType;
  entityObjectId: string;
  entityId: string;
}

function identityValue(identities: DeviceIdentity[], type: string): string | null {
  const match = identities.find(identity => identity.identityType.toUpperCase() === type);
  return match?.value?.trim() || null;
}

function normalizeEntityIdentity(value: string): { entityType: EspHomeEntityType; objectId: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("ESPHOME_ENTITY must use light:<object_id> or switch:<object_id>");
  }
  const entityType = value.slice(0, separator).trim().toLowerCase();
  const objectId = value.slice(separator + 1).trim();
  if ((entityType !== "light" && entityType !== "switch") || !objectId) {
    throw new Error("ESPHOME_ENTITY must use light:<object_id> or switch:<object_id>");
  }
  return { entityType, objectId };
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeState(state: Record<string, unknown>, target: ResolvedTarget): Record<string, unknown> {
  const result: Record<string, unknown> = {
    power: asBoolean(state.state),
    entityType: target.entityType,
    entityId: `${target.entityType}:${target.entityObjectId}`
  };
  for (const key of ["brightness", "colorTemperature", "effect", "rgb"] as const) {
    if (key in state) result[key] = state[key];
  }
  return result;
}

async function disposeClient(client: unknown): Promise<void> {
  const value = client as Record<PropertyKey, unknown>;
  const asyncDisposeSymbol = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose;
  if (asyncDisposeSymbol) {
    const disposer = value[asyncDisposeSymbol];
    if (typeof disposer === "function") {
      await (disposer as () => Promise<void>).call(client);
      return;
    }
  }
  const disconnect = value.disconnect;
  if (typeof disconnect === "function") await (disconnect as () => Promise<void>).call(client);
}

async function waitForCachedState(client: any, id: any, timeoutMs: number): Promise<Record<string, unknown>> {
  const cached = client.latest(id) as Record<string, unknown> | undefined;
  if (cached) return cached;

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let subscription: any = null;
    const timeout = setTimeout(() => {
      try { subscription?.[Symbol.dispose]?.(); } catch { /* no-op */ }
      reject(new Error(`Timed out waiting for ESPHome state after ${timeoutMs} ms`));
    }, timeoutMs);
    subscription = client.on("telemetry", () => {
      const state = client.latest(id) as Record<string, unknown> | undefined;
      if (!state) return;
      clearTimeout(timeout);
      try { subscription?.[Symbol.dispose]?.(); } catch { /* no-op */ }
      resolve(state);
    });
  });
}

export class EspHomeProvider implements Provider {
  readonly provider = "ESPHOME";
  readonly actions = ["GET_STATE", "POWER_ON", "POWER_OFF", "TOGGLE"];

  constructor(
    private readonly requestTimeoutMs = 5000,
    private readonly noisePsk: string | null = null
  ) {}

  async discover(timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const bonjour = new Bonjour(undefined, () => undefined);
    const found = new Map<string, Record<string, unknown>>();
    const enrichments: Promise<void>[] = [];

    try {
      bonjour.find({ type: "esphomelib", protocol: "tcp" }, service => {
        const txt = service.txt ?? {};
        const host = textValue(service.host).replace(/\.$/, "");
        const ip = ipv4Address(service);
        const mac = normalizeMacAddress((txt as Record<string, unknown>).mac);
        const key = mac || ip || host || service.name;
        if (!key || found.has(key)) return;

        const device: Record<string, unknown> = {
          id: mac || host || service.name,
          name: textValue((txt as Record<string, unknown>).friendly_name) || service.name,
          ip: ip ?? "",
          hostname: host,
          port: service.port,
          mac,
          model: textValue((txt as Record<string, unknown>).board),
          firmwareVersion: textValue((txt as Record<string, unknown>).version),
          platform: textValue((txt as Record<string, unknown>).platform),
          network: textValue((txt as Record<string, unknown>).network),
          apiEncryption: textValue((txt as Record<string, unknown>).api_encryption),
          entities: []
        };
        found.set(key, device);

        const connectionHost = ip || host;
        if (!connectionHost) return;
        enrichments.push((async () => {
          let client: any = null;
          try {
            client = await openEspHomeClient({ host: connectionHost, psk: this.noisePsk });
            const info = client.deviceInfo?.();
            if (info) {
              device.name = info.name || device.name;
              device.firmwareVersion = info.esphomeVersion || device.firmwareVersion;
              device.mac = normalizeMacAddress(info.macAddress) || device.mac;
              device.id = device.mac || device.id;
            }
            const available = client.getAvailableEntityIds?.() as Record<string, string[]> | undefined;
            if (available) {
              device.entities = ["light", "switch"]
                .flatMap(type => (available[type] ?? []).map(id => `${type}:${String(id).replace(new RegExp(`^${type}-`), "")}`))
                .sort();
            }
          } catch (error) {
            device.apiError = error instanceof Error ? error.message : String(error);
          } finally {
            if (client) await disposeClient(client);
          }
        })());
      });

      await new Promise(resolve => setTimeout(resolve, Math.max(500, timeoutMs)));
      await Promise.allSettled(enrichments);
      return [...found.values()];
    } finally {
      bonjour.destroy();
    }
  }

  async execute(command: CommandMessage): Promise<ProviderCommandResult> {
    const identities = command.target?.identities ?? [];
    const host = identityValue(identities, "FQDN")
      ?? identityValue(identities, "HOSTNAME")
      ?? identityValue(identities, "IP");
    if (!host) throw new Error("ESPHome target requires an IP, FQDN or HOSTNAME identity");

    const client = await openEspHomeClient({ host, psk: this.noisePsk });
    try {
      const target = this.resolveTarget(client as any, identities, host);
      const id = entityId(target.entityType, target.entityObjectId) as any;

      if (command.action === "GET_STATE") {
        const state = await waitForCachedState(client as any, id, this.requestTimeoutMs);
        const normalized = normalizeState(state, target);
        return { result: normalized, state: normalized };
      }

      let desired: boolean;
      if (command.action === "POWER_ON") desired = true;
      else if (command.action === "POWER_OFF") desired = false;
      else if (command.action === "TOGGLE") {
        const current = await waitForCachedState(client as any, id, this.requestTimeoutMs);
        const power = asBoolean(current.state);
        if (power == null) throw new Error("ESPHome entity did not report a boolean state");
        desired = !power;
      } else {
        throw new Error(`Unsupported ESPHome action ${command.action}`);
      }

      const event = await (client as any).commandAndAwait(
        id,
        { state: desired },
        { timeoutMs: this.requestTimeoutMs }
      ) as Record<string, unknown>;
      const normalized = normalizeState(event, target);
      return { result: normalized, state: normalized };
    } finally {
      await disposeClient(client);
    }
  }

  private resolveTarget(client: any, identities: DeviceIdentity[], host: string): ResolvedTarget {
    const explicit = identityValue(identities, "ESPHOME_ENTITY");
    if (explicit) {
      const parsed = normalizeEntityIdentity(explicit);
      const id = entityId(parsed.entityType, parsed.objectId) as any;
      if (!client.hasEntity(id)) {
        throw new Error(`ESPHome entity ${explicit} was not advertised by ${host}`);
      }
      return {
        host,
        entityType: parsed.entityType,
        entityObjectId: parsed.objectId,
        entityId: String(id)
      };
    }

    const available = client.getAvailableEntityIds() as Record<string, string[]>;
    const candidates = [
      ...(available.light ?? []).map(id => ({ type: "light" as const, id })),
      ...(available.switch ?? []).map(id => ({ type: "switch" as const, id }))
    ];
    if (candidates.length !== 1) {
      throw new Error(`ESPHome target ${host} exposes ${candidates.length} controllable light/switch entities; add an ESPHOME_ENTITY identity such as light:living_room`);
    }
    const candidate = candidates[0]!;
    const prefix = `${candidate.type}-`;
    const objectId = candidate.id.startsWith(prefix) ? candidate.id.slice(prefix.length) : candidate.id;
    return {
      host,
      entityType: candidate.type,
      entityObjectId: objectId,
      entityId: candidate.id
    };
  }
}
