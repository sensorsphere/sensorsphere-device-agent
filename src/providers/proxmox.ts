import http from "node:http";
import https from "node:https";
import type { ProxmoxEndpointConfig } from "../config.js";
import type { CommandMessage, Provider, ProviderCommandResult } from "../protocol.js";

interface ProxmoxApiResponse<T> {
  data: T;
}

interface ProxmoxResource {
  id?: unknown;
  type?: unknown;
  node?: unknown;
  vmid?: unknown;
  name?: unknown;
  status?: unknown;
  uptime?: unknown;
  maxcpu?: unknown;
  maxmem?: unknown;
  cpu?: unknown;
  mem?: unknown;
  template?: unknown;
}

export interface ProxmoxDiscoveryRecord extends Record<string, unknown> {
  kind: "PVE_NODE" | "PVE_VM" | "PVE_LXC";
  providerId: string;
  endpointId: string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  const valueAsNumber = numberValue(value);
  return valueAsNumber !== undefined && Number.isInteger(valueAsNumber) ? valueAsNumber : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return undefined;
}

function normalizeResource(endpoint: ProxmoxEndpointConfig, resource: ProxmoxResource): ProxmoxDiscoveryRecord | null {
  const type = stringValue(resource.type)?.toLowerCase();
  const node = stringValue(resource.node);
  const status = stringValue(resource.status);
  const uptime = numberValue(resource.uptime);

  if (type === "node" && node) {
    return {
      kind: "PVE_NODE",
      providerId: `${endpoint.id}:node:${node}`,
      endpointId: endpoint.id,
      node,
      name: node,
      ...(status ? { status } : {}),
      ...(uptime !== undefined ? { uptime } : {})
    };
  }

  if ((type === "qemu" || type === "lxc") && node) {
    const vmid = integerValue(resource.vmid);
    if (vmid === undefined) return null;
    const name = stringValue(resource.name) || `${type}-${vmid}`;
    const kind = type === "qemu" ? "PVE_VM" : "PVE_LXC";
    const record: ProxmoxDiscoveryRecord = {
      kind,
      providerId: `${endpoint.id}:${type}:${vmid}`,
      endpointId: endpoint.id,
      vmid,
      node,
      name,
      parentProviderId: `${endpoint.id}:node:${node}`,
      ...(status ? { status } : {}),
      ...(uptime !== undefined ? { uptime } : {})
    };
    const maxcpu = numberValue(resource.maxcpu);
    const maxmem = numberValue(resource.maxmem);
    const cpu = numberValue(resource.cpu);
    const mem = numberValue(resource.mem);
    const template = booleanValue(resource.template);
    if (maxcpu !== undefined) record.maxcpu = maxcpu;
    if (maxmem !== undefined) record.maxmem = maxmem;
    if (cpu !== undefined) record.cpu = cpu;
    if (mem !== undefined) record.mem = mem;
    if (template !== undefined) record.template = template;
    return record;
  }

  return null;
}

function apiUrl(endpoint: ProxmoxEndpointConfig, path: string): URL {
  const base = new URL(endpoint.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}/api2/json${path}`.replace(/\/+/g, "/");
  base.search = "";
  base.hash = "";
  return base;
}

async function apiGet<T>(endpoint: ProxmoxEndpointConfig, path: string, timeoutMs: number): Promise<T> {
  const url = apiUrl(endpoint, path);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<T>((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `PVEAPIToken=${endpoint.tokenId}=${endpoint.tokenSecret}`
      },
      ...(url.protocol === "https:" ? { rejectUnauthorized: endpoint.verifyTls } : {})
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Proxmox endpoint ${endpoint.id} returned HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        try {
          const parsed = JSON.parse(body) as ProxmoxApiResponse<T>;
          if (!("data" in parsed)) throw new Error("missing data field");
          resolve(parsed.data);
        } catch {
          reject(new Error(`Proxmox endpoint ${endpoint.id} returned invalid JSON`));
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Proxmox endpoint ${endpoint.id} request timed out`));
    });
    request.on("error", error => {
      reject(new Error(`Proxmox endpoint ${endpoint.id} request failed: ${error.message}`));
    });
    request.end();
  });
}

export class ProxmoxProvider implements Provider {
  readonly provider = "PROXMOX";
  readonly actions: string[] = [];

  constructor(
    private readonly endpoints: ProxmoxEndpointConfig[],
    private readonly requestTimeoutMs = 5000
  ) {}

  async discover(timeoutMs: number): Promise<Array<Record<string, unknown>>> {
    const effectiveTimeoutMs = Math.min(timeoutMs, this.requestTimeoutMs);
    const discovered = await Promise.all(this.endpoints.map(async endpoint => {
      const resources = await apiGet<ProxmoxResource[]>(endpoint, "/cluster/resources", effectiveTimeoutMs);
      if (!Array.isArray(resources)) {
        throw new Error(`Proxmox endpoint ${endpoint.id} returned an invalid cluster resource list`);
      }
      return resources
        .map(resource => normalizeResource(endpoint, resource))
        .filter((resource): resource is ProxmoxDiscoveryRecord => resource !== null);
    }));

    return discovered.flat().sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async execute(_command: CommandMessage): Promise<ProviderCommandResult> {
    throw new Error("PROXMOX does not support Device Control actions");
  }
}
