import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { entityId, openEspHomeClient } from "esphome-client";
import type { CommandMessage, DeviceIdentity, Provider, ProviderCommandResult } from "../protocol.js";

type EspHomeEntityType = "light" | "switch";

type MdnsRecord = {
  name?: string;
  type?: string;
  data?: unknown;
};

type MdnsPacket = {
  answers?: MdnsRecord[];
  additionals?: MdnsRecord[];
};

type MdnsInstance = {
  on(event: "ready", listener: () => void): MdnsInstance;
  on(event: "response", listener: (packet: MdnsPacket) => void): MdnsInstance;
  on(event: "error", listener: (error: Error) => void): MdnsInstance;
  query(query: { questions: Array<{ name: string; type: string }> }): void;
  destroy(): void;
};

type MdnsFactory = (options?: Record<string, unknown>) => MdnsInstance;

const require = createRequire(import.meta.url);
const mdnsFactory = require("multicast-dns") as MdnsFactory;
const ESPHOME_SERVICE = "_esphomelib._tcp.local";

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return value == null ? "" : String(value).trim();
}

function normalizeMacAddress(value: unknown): string {
  const compact = textValue(value).replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  if (compact.length !== 12) return textValue(value);
  return compact.match(/.{2}/g)?.join(":") ?? compact;
}

function decodeTxt(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(value)) return result;

  for (const entry of value) {
    const text = textValue(entry);
    if (!text) continue;
    const separator = text.indexOf("=");
    const key = separator >= 0 ? text.slice(0, separator) : text;
    const itemValue = separator >= 0 ? text.slice(separator + 1) : "";
    if (key) result[key] = itemValue;
  }
  return result;
}

function activeIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

function normalizeDnsName(value: unknown): string {
  return textValue(value).replace(/\.$/, "");
}

function recordNameEquals(record: MdnsRecord, value: string): boolean {
  return normalizeDnsName(record.name).toLowerCase() === normalizeDnsName(value).toLowerCase();
}

function packetRecords(packet: MdnsPacket): MdnsRecord[] {
  return [...(packet.answers ?? []), ...(packet.additionals ?? [])];
}

function extractServices(packet: MdnsPacket): Array<Record<string, unknown>> {
  const records = packetRecords(packet);
  const ptrRecords = records.filter(record =>
    record.type === "PTR" && recordNameEquals(record, ESPHOME_SERVICE)
  );
  const devices: Array<Record<string, unknown>> = [];

  for (const ptr of ptrRecords) {
    const instance = normalizeDnsName(ptr.data);
    if (!instance) continue;

    const srv = records.find(record => record.type === "SRV" && recordNameEquals(record, instance));
    const txtRecord = records.find(record => record.type === "TXT" && recordNameEquals(record, instance));
    const srvData = srv?.data as { port?: unknown; target?: unknown } | undefined;
    const host = normalizeDnsName(srvData?.target);
    const addressRecord = host
      ? records.find(record => record.type === "A" && recordNameEquals(record, host))
      : undefined;
    const ip = textValue(addressRecord?.data);
    const txt = decodeTxt(txtRecord?.data);
    const serviceName = instance.replace(/\._esphomelib\._tcp\.local$/i, "");
    const mac = normalizeMacAddress(txt.mac);

    devices.push({
      id: mac || host || serviceName,
      name: txt.friendly_name || serviceName,
      ip,
      hostname: host,
      port: Number(srvData?.port ?? 6053),
      mac,
      model: txt.board ?? "",
      firmwareVersion: txt.version ?? "",
      platform: txt.platform ?? "",
      network: txt.network ?? "",
      apiEncryption: txt.api_encryption ?? "",
      entities: []
    });
  }

  return devices;
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

async function waitForBooleanState(client: any, id: any, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const cached = client.latest(id) as Record<string, unknown> | undefined;
  if (cached && typeof cached.state === "boolean") return cached;

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for await (const event of client.telemetryForId(id, { signal })) {
      const state = event as Record<string, unknown>;
      if (typeof state.state === "boolean") return state;
    }
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
  return null;
}

export class EspHomeProvider implements Provider {
  readonly provider = "ESPHOME";
  readonly actions = ["LIST_ENTITIES", "GET_STATE", "POWER_ON", "POWER_OFF", "TOGGLE"];

  constructor(
    private readonly requestTimeoutMs = 5000,
    private readonly noisePsk: string | null = null
  ) {}

  async discover(timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const interfaces = activeIpv4Addresses();
    const found = new Map<string, Record<string, unknown>>();
    const sockets: MdnsInstance[] = [];

    console.info(`[ESPHOME] Starting mDNS discovery on ${interfaces.length} IPv4 interface(s): ${interfaces.join(", ") || "none"}`);

    try {
      for (const address of interfaces) {
        const socket = mdnsFactory({
          interface: address,
          bind: "0.0.0.0",
          port: 5353,
          multicast: true,
          loopback: true,
          reuseAddr: true
        });
        sockets.push(socket);

        socket.on("ready", () => {
          console.info(`[ESPHOME] Querying ${ESPHOME_SERVICE} via ${address}`);
          socket.query({ questions: [{ name: ESPHOME_SERVICE, type: "PTR" }] });
        });

        socket.on("response", packet => {
          for (const device of extractServices(packet)) {
            const key = String(device.mac || device.ip || device.hostname || device.id);
            if (!key) continue;
            if (!found.has(key)) {
              console.info(`[ESPHOME] mDNS found ${String(device.hostname || device.name)} at ${String(device.ip || "?")}:${String(device.port || 6053)} via ${address}`);
            }
            found.set(key, { ...(found.get(key) ?? {}), ...device });
          }
        });

        socket.on("error", error => {
          console.warn(`[ESPHOME] mDNS socket error on ${address}: ${error.message}`);
        });
      }

      await new Promise(resolve => setTimeout(resolve, Math.max(500, timeoutMs)));
    } finally {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* no-op */ }
      }
    }

    const devices = [...found.values()];
    console.info(`[ESPHOME] mDNS discovery completed: ${devices.length} device(s)`);

    await Promise.allSettled(devices.map(async device => {
      const connectionHost = textValue(device.ip) || textValue(device.hostname);
      if (!connectionHost) return;

      let client: any = null;
      try {
        console.info(`[ESPHOME] Connecting Native API to ${connectionHost}:${String(device.port || 6053)}`);
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
          const lights = available.light ?? [];
          const switches = available.switch ?? [];
          device.entities = [
            ...lights.map(id => `light:${String(id).replace(/^light-/, "")}`),
            ...switches.map(id => `switch:${String(id).replace(/^switch-/, "")}`)
          ].sort();
          console.info(`[ESPHOME] Native API ${connectionHost}: ${lights.length} light(s), ${switches.length} switch(es)`);
        }
      } catch (error) {
        device.apiError = error instanceof Error ? error.message : String(error);
        console.warn(`[ESPHOME] Native API enrichment failed for ${connectionHost}: ${String(device.apiError)}`);
      } finally {
        if (client) await disposeClient(client);
      }
    }));

    console.info(`[ESPHOME] Discovery completed: ${devices.length} device(s)`);
    return devices;
  }

  async execute(command: CommandMessage): Promise<ProviderCommandResult> {
    const identities = command.target?.identities ?? [];
    const host = identityValue(identities, "IP")
      ?? identityValue(identities, "FQDN")
      ?? identityValue(identities, "HOSTNAME");
    if (!host) throw new Error("ESPHome target requires an IP, FQDN or HOSTNAME identity");

    const client = await openEspHomeClient({ host, psk: this.noisePsk });
    try {
      if (command.action === "LIST_ENTITIES") {
        const available = client.getAvailableEntityIds();
        const rawEntities = [
          ...(available.light ?? []).map(id => ({ type: "light" as const, entityId: id })),
          ...(available.switch ?? []).map(id => ({ type: "switch" as const, entityId: id }))
        ];
        const entities = rawEntities.map(item => {
          const rawId = String(item.entityId);
          const value = `${item.type}:${rawId.replace(new RegExp(`^${item.type}-`), "")}`;
          const entity = client.getEntityById(item.entityId as Parameters<typeof client.getEntityById>[0]) as Record<string, unknown> | undefined;
          const latest = client.latest(item.entityId as Parameters<typeof client.latest>[0]) as Record<string, unknown> | undefined;
          const name = typeof entity?.name === "string" && entity.name.trim() ? entity.name.trim() : value;
          return { type: item.type, id: rawId, value, name, label: `${name} (${value})`, power: asBoolean(latest?.state) };
        }).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
        return { result: { entities } };
      }

      const target = this.resolveTarget(client as any, identities, host, command.parameters?.entity);
      const id = entityId(target.entityType, target.entityObjectId) as any;

      if (command.action === "GET_STATE") {
        const state = await waitForBooleanState(client as any, id, Math.min(this.requestTimeoutMs, 1500));
        const normalized = state
          ? normalizeState(state, target)
          : { power: null, entityType: target.entityType, entityId: `${target.entityType}:${target.entityObjectId}` };
        return { result: normalized, state: normalized };
      }

      let desired: boolean;
      if (command.action === "POWER_ON") desired = true;
      else if (command.action === "POWER_OFF") desired = false;
      else if (command.action === "TOGGLE") {
        const current = await waitForBooleanState(client as any, id, Math.min(this.requestTimeoutMs, 1500));
        if (!current) {
          throw new Error("ESPHome entity state is unknown; use POWER_ON or POWER_OFF before TOGGLE");
        }
        desired = !current.state;
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

  private resolveTarget(client: any, identities: DeviceIdentity[], host: string, commandEntity?: unknown): ResolvedTarget {
    const explicit = textValue(commandEntity) || identityValue(identities, "ESPHOME_ENTITY");
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
