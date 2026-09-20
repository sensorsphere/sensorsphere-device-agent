import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { entityId, openEspHomeClient } from "esphome-client";
import type { CommandMessage, DeviceIdentity, Provider, ProviderCommandResult, ProviderStateSink, SyncedDevice } from "../protocol.js";

type EspHomeEntityType = "light" | "switch" | "sensor" | "binary_sensor" | "text_sensor" | "number" | "select";

const REALTIME_ENTITY_TYPES: EspHomeEntityType[] = [
  "light",
  "switch",
  "sensor",
  "binary_sensor",
  "text_sensor",
  "number",
  "select"
];

export function discoveredEspHomeEntities(available: Record<string, string[]>): string[] {
  return REALTIME_ENTITY_TYPES.flatMap(entityType =>
    (available[entityType] ?? []).map(id => `${entityType}:${String(id).replace(new RegExp(`^${entityType}-`), "")}`)
  ).sort();
}

export function discoveredEspHomeEntitiesFromClient(client: any): string[] {
  const directEntities = typeof client.entitiesByDevice === "function" ? client.entitiesByDevice(undefined) : [];
  if (Array.isArray(directEntities) && directEntities.length > 0) {
    const supported = new Set<string>(REALTIME_ENTITY_TYPES);
    const values = directEntities
      .filter((entity: unknown): entity is Record<string, unknown> => Boolean(entity) && typeof entity === "object")
      .filter(entity => typeof entity.type === "string" && supported.has(entity.type))
      .map(entity => {
        const type = String(entity.type);
        const objectId = typeof entity.objectId === "string" ? entity.objectId.trim() : "";
        return objectId ? `${type}:${objectId}` : "";
      })
      .filter(Boolean);
    if (values.length > 0) return [...new Set(values)].sort();
  }

  const available = client.getAvailableEntityIds?.() as Record<string, string[]> | undefined;
  return available ? discoveredEspHomeEntities(available) : [];
}

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

function normalizeEntityIdentity(value: string): { entityType: "light" | "switch"; objectId: string } {
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

export function decodeEspHomeEntityValue(
  entityType: EspHomeEntityType,
  state: Record<string, unknown> | null | undefined
): boolean | number | string | null {
  if (!state) return null;
  const value = state.state;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;

  // ESPHome API messages use proto3 scalar fields. Generated JavaScript can
  // omit fields when their wire value is the scalar default, but the presence
  // of the telemetry object itself still represents a current entity state.
  if (entityType === "light" || entityType === "switch" || entityType === "binary_sensor") return false;
  if (entityType === "sensor" || entityType === "number") return 0;
  if (entityType === "text_sensor" || entityType === "select") return "";
  return null;
}

export function decodeEspHomePower(
  entityType: EspHomeEntityType,
  state: Record<string, unknown> | null | undefined
): boolean | null {
  if (entityType !== "light" && entityType !== "switch") return null;
  const value = decodeEspHomeEntityValue(entityType, state);
  return typeof value === "boolean" ? value : null;
}

function normalizeState(state: Record<string, unknown>, target: ResolvedTarget): Record<string, unknown> {
  const result: Record<string, unknown> = {
    power: decodeEspHomePower(target.entityType, state),
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

async function waitForBooleanState(client: any, id: any, entityType: EspHomeEntityType, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const cached = client.latest(id) as Record<string, unknown> | undefined;
  if (cached && decodeEspHomePower(entityType, cached) !== null) return cached;

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for await (const event of client.telemetryForId(id, { signal })) {
      const state = event as Record<string, unknown>;
      if (decodeEspHomePower(entityType, state) !== null) return state;
    }
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
  return null;
}


interface RealtimeEntityState {
  type: EspHomeEntityType;
  id: string;
  value: string;
  name: string;
  power: boolean | null;
  currentValue: boolean | number | string | null;
  unit: string | null;
  metadata: Record<string, unknown>;
  controllable: boolean;
  state: Record<string, unknown> | null;
  observedAt: string | null;
}

interface RealtimeSubscription {
  device: SyncedDevice;
  host: string;
  abort: AbortController;
  client: any | null;
  entities: Map<string, RealtimeEntityState>;
  task: Promise<void>;
}

function entityValue(type: EspHomeEntityType, rawId: unknown): string {
  const id = String(rawId);
  return `${type}:${id.replace(new RegExp(`^${type}-`), "")}`;
}

function realtimeEntitySnapshot(entity: RealtimeEntityState): Record<string, unknown> {
  return {
    type: entity.type,
    id: entity.id,
    value: entity.value,
    name: entity.name,
    label: `${entity.name} (${entity.value})`,
    power: entity.power,
    currentValue: entity.currentValue,
    unit: entity.unit,
    metadata: entity.metadata,
    controllable: entity.controllable,
    state: entity.state,
    observedAt: entity.observedAt
  };
}

export class EspHomeProvider implements Provider {
  readonly provider = "ESPHOME";
  readonly actions = ["LIST_ENTITIES", "GET_STATE", "POWER_ON", "POWER_OFF", "TOGGLE"];
  private readonly subscriptions = new Map<string, RealtimeSubscription>();
  private stateSink: ProviderStateSink | null = null;

  constructor(
    private readonly requestTimeoutMs = 5000,
    private readonly noisePsk: string | null = null
  ) {}

  async syncDevices(devices: SyncedDevice[], onState: ProviderStateSink): Promise<void> {
    this.stateSink = onState;
    const wanted = new Map(devices.map(device => [device.deviceId, device]));

    for (const [deviceId, subscription] of this.subscriptions) {
      const next = wanted.get(deviceId);
      const nextHost = next ? this.hostForDevice(next) : null;
      if (!next || !nextHost || nextHost !== subscription.host) {
        subscription.abort.abort();
        this.subscriptions.delete(deviceId);
      }
    }

    for (const device of devices) {
      const existing = this.subscriptions.get(device.deviceId);
      if (existing) {
        existing.device = device;
        this.emitRealtimeState(existing, existing.client != null);
        continue;
      }
      const host = this.hostForDevice(device);
      if (!host) {
        console.warn(`[ESPHOME] Realtime subscription skipped for ${device.deviceName ?? device.deviceId}: no IP/FQDN/HOSTNAME identity`);
        continue;
      }
      const abort = new AbortController();
      const subscription: RealtimeSubscription = {
        device,
        host,
        abort,
        client: null,
        entities: new Map(),
        task: Promise.resolve()
      };
      subscription.task = this.runRealtimeSubscription(subscription);
      this.subscriptions.set(device.deviceId, subscription);
    }
  }

  async stop(): Promise<void> {
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const subscription of subscriptions) subscription.abort.abort();
    await Promise.allSettled(subscriptions.map(subscription => subscription.task));
  }

  private hostForDevice(device: SyncedDevice): string | null {
    return identityValue(device.identities, "IP")
      ?? identityValue(device.identities, "FQDN")
      ?? identityValue(device.identities, "HOSTNAME");
  }

  private emitRealtimeState(subscription: RealtimeSubscription, connected: boolean, error: string | null = null): void {
    this.stateSink?.(subscription.device.deviceId, this.provider, {
      realtime: true,
      connected,
      host: subscription.host,
      error,
      entities: [...subscription.entities.values()]
        .map(realtimeEntitySnapshot)
        .sort((left, right) => String(left.label).localeCompare(String(right.label), undefined, { sensitivity: "base" }))
    });
  }

  private async runRealtimeSubscription(subscription: RealtimeSubscription): Promise<void> {
    let retryMs = 1000;
    while (!subscription.abort.signal.aborted) {
      let client: any = null;
      try {
        console.info(`[ESPHOME] Realtime connecting ${subscription.device.deviceName ?? subscription.device.deviceId} at ${subscription.host}:6053`);
        client = await openEspHomeClient({ host: subscription.host, psk: this.noisePsk });
        subscription.client = client;
        retryMs = 1000;
        this.initializeRealtimeEntities(subscription, client);
        this.emitRealtimeState(subscription, true);
        console.info(`[ESPHOME] Realtime connected ${subscription.host}: ${subscription.entities.size} realtime entity(ies)`);

        const tasks = [...subscription.entities.values()].map(entity => this.consumeEntityTelemetry(subscription, client, entity));
        if (tasks.length === 0) {
          await new Promise<void>(resolve => subscription.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
        } else {
          await Promise.race(tasks);
        }
        if (!subscription.abort.signal.aborted) throw new Error("ESPHome realtime telemetry stream ended");
      } catch (error) {
        if (subscription.abort.signal.aborted) break;
        const message = error instanceof Error ? error.message : String(error);
        subscription.client = null;
        this.emitRealtimeState(subscription, false, message);
        console.warn(`[ESPHOME] Realtime connection ${subscription.host} failed: ${message}; retry in ${retryMs}ms`);
        await new Promise(resolve => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 30000);
      } finally {
        subscription.client = null;
        if (client) {
          try { await disposeClient(client); } catch { /* no-op */ }
        }
      }
    }
  }

  private initializeRealtimeEntities(subscription: RealtimeSubscription, client: any): void {
    const available = client.getAvailableEntityIds() as Record<string, unknown[]>;
    const items = REALTIME_ENTITY_TYPES.flatMap(type =>
      (available[type] ?? []).map(id => ({ type, id }))
    );
    const next = new Map<string, RealtimeEntityState>();
    for (const item of items) {
      const rawId = String(item.id);
      const value = entityValue(item.type, rawId);
      const metadata = (client.getEntityById(item.id) as Record<string, unknown> | undefined) ?? {};
      const latest = client.latest(item.id) as Record<string, unknown> | undefined;
      const currentValue = decodeEspHomeEntityValue(item.type, latest);
      const unit = typeof metadata.unitOfMeasurement === "string" && metadata.unitOfMeasurement.trim()
        ? metadata.unitOfMeasurement.trim()
        : null;
      next.set(value, {
        type: item.type,
        id: rawId,
        value,
        name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : value,
        power: decodeEspHomePower(item.type, latest),
        currentValue,
        unit,
        metadata,
        controllable: item.type === "light" || item.type === "switch",
        state: latest ?? null,
        observedAt: latest ? new Date().toISOString() : null
      });
    }
    subscription.entities = next;
  }

  private async consumeEntityTelemetry(subscription: RealtimeSubscription, client: any, entity: RealtimeEntityState): Promise<void> {
    const id = entity.id as any;
    try {
      for await (const event of client.telemetryForId(id, { signal: subscription.abort.signal })) {
        if (subscription.abort.signal.aborted) return;
        const state = event as Record<string, unknown>;
        entity.state = state;
        entity.currentValue = decodeEspHomeEntityValue(entity.type, state);
        entity.power = decodeEspHomePower(entity.type, state);
        entity.observedAt = new Date().toISOString();
        this.emitRealtimeState(subscription, true);
      }
    } catch (error) {
      if (subscription.abort.signal.aborted) return;
      throw error;
    }
  }

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
        const discoveredEntities = discoveredEspHomeEntitiesFromClient(client);
        device.entities = discoveredEntities;
        const counts = REALTIME_ENTITY_TYPES
          .map(entityType => `${discoveredEntities.filter(entity => entity.startsWith(`${entityType}:`)).length} ${entityType}`)
          .join(", ");
        console.info(`[ESPHOME] Native API ${connectionHost}: ${discoveredEntities.length} discoverable entity(ies) (${counts})`);
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

    const subscription = this.subscriptions.get(command.deviceId);
    const persistentClient = subscription?.host === host ? subscription.client : null;
    const client = persistentClient ?? await openEspHomeClient({ host, psk: this.noisePsk });
    const temporaryClient = !persistentClient;
    try {
      if (command.action === "LIST_ENTITIES") {
        const available = client.getAvailableEntityIds();
        const rawEntities = [
          ...(available.light ?? []).map((id: Parameters<typeof client.getEntityById>[0]) => ({ type: "light" as const, entityId: id })),
          ...(available.switch ?? []).map((id: Parameters<typeof client.getEntityById>[0]) => ({ type: "switch" as const, entityId: id }))
        ];
        const entities = rawEntities.map(item => {
          const rawId = String(item.entityId);
          const value = `${item.type}:${rawId.replace(new RegExp(`^${item.type}-`), "")}`;
          const entity = client.getEntityById(item.entityId as Parameters<typeof client.getEntityById>[0]) as Record<string, unknown> | undefined;
          const latest = client.latest(item.entityId as Parameters<typeof client.latest>[0]) as Record<string, unknown> | undefined;
          const name = typeof entity?.name === "string" && entity.name.trim() ? entity.name.trim() : value;
          return { type: item.type, id: rawId, value, name, label: `${name} (${value})`, power: decodeEspHomePower(item.type, latest) };
        }).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
        return { result: { entities } };
      }

      const target = this.resolveTarget(client as any, identities, host, command.parameters?.entity);
      const id = entityId(target.entityType, target.entityObjectId) as any;

      if (command.action === "GET_STATE") {
        const state = await waitForBooleanState(client as any, id, target.entityType, Math.min(this.requestTimeoutMs, 1500));
        const normalized = state
          ? normalizeState(state, target)
          : { power: null, entityType: target.entityType, entityId: `${target.entityType}:${target.entityObjectId}` };
        return { result: normalized };
      }

      let desired: boolean;
      if (command.action === "POWER_ON") desired = true;
      else if (command.action === "POWER_OFF") desired = false;
      else if (command.action === "TOGGLE") {
        const current = await waitForBooleanState(client as any, id, target.entityType, Math.min(this.requestTimeoutMs, 1500));
        if (!current) {
          throw new Error("ESPHome entity state is unknown; use POWER_ON or POWER_OFF before TOGGLE");
        }
        desired = !decodeEspHomePower(target.entityType, current);
      } else {
        throw new Error(`Unsupported ESPHome action ${command.action}`);
      }

      const event = await (client as any).commandAndAwait(
        id,
        { state: desired },
        { timeoutMs: this.requestTimeoutMs }
      ) as Record<string, unknown>;
      const normalized = normalizeState(event, target);
      return { result: normalized };
    } finally {
      if (temporaryClient) await disposeClient(client);
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
