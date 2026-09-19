import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
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

interface ProxmoxGuestConfig extends Record<string, unknown> {
  hostname?: unknown;
  ostype?: unknown;
  agent?: unknown;
}

interface ProxmoxGuestAgentInterface {
  name?: unknown;
  ['hardware-address']?: unknown;
  ['ip-addresses']?: unknown;
}

interface ProxmoxGuestAgentNetworkResult {
  result?: unknown;
}

interface ProxmoxBackupVersion {
  version?: unknown;
  release?: unknown;
  repoid?: unknown;
}

interface ProxmoxBackupNode {
  node?: unknown;
  status?: unknown;
  uptime?: unknown;
  cpu?: unknown;
  mem?: unknown;
  maxmem?: unknown;
}

export interface ProxmoxDiscoveryRecord extends Record<string, unknown> {
  kind: "PVE_NODE" | "PVE_VM" | "PVE_LXC" | "PBS_SERVER";
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


function splitConfigValue(value: string): Record<string, string> {
  return Object.fromEntries(value.split(",").map(part => {
    const [key, ...rest] = part.split("=");
    return [key?.trim() || "", rest.join("=").trim()];
  }).filter(([key]) => key));
}

function normalizeMac(value: unknown): string | undefined {
  const raw = stringValue(value)?.toUpperCase();
  return raw && /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(raw) ? raw : undefined;
}

function normalizeIp(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const withoutPrefix = raw.split("/")[0]?.trim();
  if (!withoutPrefix || withoutPrefix === "127.0.0.1" || withoutPrefix === "::1" || withoutPrefix.startsWith("169.254.") || withoutPrefix.toLowerCase().startsWith("fe80:")) return undefined;
  return withoutPrefix;
}

function configNetworks(config: ProxmoxGuestConfig): { ips: string[]; macs: string[] } {
  const ips: string[] = [];
  const macs: string[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (typeof raw !== "string") continue;
    if (/^net\d+$/.test(key)) {
      const parts = splitConfigValue(raw);
      const mac = normalizeMac(parts.hwaddr) || normalizeMac(Object.values(parts).find(value => /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(value)));
      if (mac) macs.push(mac);
      const ip = normalizeIp(parts.ip);
      if (ip && parts.ip?.toLowerCase() !== "dhcp") ips.push(ip);
    } else if (/^ipconfig\d+$/.test(key)) {
      const parts = splitConfigValue(raw);
      const ip = normalizeIp(parts.ip);
      if (ip && parts.ip?.toLowerCase() !== "dhcp") ips.push(ip);
    }
  }
  return { ips: [...new Set(ips)], macs: [...new Set(macs)] };
}

function guestAgentNetworks(payload: ProxmoxGuestAgentNetworkResult | undefined): { ips: string[]; macs: string[] } {
  if (!payload || !Array.isArray(payload.result)) return { ips: [], macs: [] };
  const ips: string[] = [];
  const macs: string[] = [];
  for (const item of payload.result as ProxmoxGuestAgentInterface[]) {
    const name = stringValue(item.name)?.toLowerCase();
    if (name === "lo" || name === "loopback") continue;
    const mac = normalizeMac(item["hardware-address"]);
    if (mac && mac !== "00:00:00:00:00:00") macs.push(mac);
    if (Array.isArray(item["ip-addresses"])) {
      for (const ipItem of item["ip-addresses"] as Array<Record<string, unknown>>) {
        const ip = normalizeIp(ipItem["ip-address"]);
        if (ip) ips.push(ip);
      }
    }
  }
  return { ips: [...new Set(ips)], macs: [...new Set(macs)] };
}

function guestOsLabel(kind: "PVE_VM" | "PVE_LXC", ostype: string | undefined): string | undefined {
  if (!ostype) return undefined;
  const labels: Record<string, string> = {
    l26: "Linux", win10: "Windows 10/11", win11: "Windows 11", w2k19: "Windows Server 2019", w2k22: "Windows Server 2022",
    debian: "Debian", ubuntu: "Ubuntu", centos: "CentOS", fedora: "Fedora", archlinux: "Arch Linux", alpine: "Alpine Linux"
  };
  return labels[ostype.toLowerCase()] || (kind === "PVE_LXC" ? ostype : ostype.toUpperCase());
}

function agentEnabled(config: ProxmoxGuestConfig): boolean {
  const value = config.agent;
  if (value === 1 || value === true) return true;
  const text = stringValue(value)?.toLowerCase();
  return text === "1" || text === "yes" || text?.includes("enabled=1") === true;
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
        Authorization: endpoint.product === "PBS"
          ? `PBSAPIToken=${endpoint.tokenId}:${endpoint.tokenSecret}`
          : `PVEAPIToken=${endpoint.tokenId}=${endpoint.tokenSecret}`
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


async function apiGetOptional<T>(endpoint: ProxmoxEndpointConfig, path: string, timeoutMs: number): Promise<T | undefined> {
  try {
    return await apiGet<T>(endpoint, path, timeoutMs);
  } catch {
    return undefined;
  }
}

async function discoverPbs(endpoint: ProxmoxEndpointConfig, timeoutMs: number): Promise<ProxmoxDiscoveryRecord[]> {
  const versionInfo = await apiGet<ProxmoxBackupVersion>(endpoint, "/version", timeoutMs);
  const nodes = await apiGetOptional<ProxmoxBackupNode[]>(endpoint, "/nodes", timeoutMs);
  const nodeInfo = Array.isArray(nodes) ? nodes[0] : undefined;
  const endpointUrl = new URL(endpoint.url);
  const node = stringValue(nodeInfo?.node) || endpointUrl.hostname;
  const status = stringValue(nodeInfo?.status) || "online";
  const release = stringValue(versionInfo.release) || stringValue(versionInfo.version);
  const record: ProxmoxDiscoveryRecord = {
    kind: "PBS_SERVER",
    providerId: `${endpoint.id}:pbs`,
    endpointId: endpoint.id,
    product: "PBS",
    name: node,
    hostname: node,
    node,
    status,
    ...(release ? { version: release, firmwareVersion: release } : {})
  };
  const uptime = numberValue(nodeInfo?.uptime);
  const cpu = numberValue(nodeInfo?.cpu);
  const mem = numberValue(nodeInfo?.mem);
  const maxmem = numberValue(nodeInfo?.maxmem);
  if (uptime !== undefined) record.uptime = uptime;
  if (cpu !== undefined) record.cpu = cpu;
  if (mem !== undefined) record.mem = mem;
  if (maxmem !== undefined) record.maxmem = maxmem;
  const endpointIp = normalizeIp(endpointUrl.hostname);
  if (endpointIp) record.ip = endpointIp;
  return [record];
}

async function enrichGuest(endpoint: ProxmoxEndpointConfig, record: ProxmoxDiscoveryRecord, timeoutMs: number): Promise<ProxmoxDiscoveryRecord> {
  if ((record.kind !== "PVE_VM" && record.kind !== "PVE_LXC") || typeof record.node !== "string" || typeof record.vmid !== "number") return record;
  const type = record.kind === "PVE_VM" ? "qemu" : "lxc";
  const base = `/nodes/${encodeURIComponent(record.node)}/${type}/${record.vmid}`;
  const config = await apiGetOptional<ProxmoxGuestConfig>(endpoint, `${base}/config`, timeoutMs);
  if (!config) return record;

  const configured = configNetworks(config);
  let agentNetwork = { ips: [] as string[], macs: [] as string[] };
  if (record.kind === "PVE_VM" && record.status === "running" && agentEnabled(config)) {
    const payload = await apiGetOptional<ProxmoxGuestAgentNetworkResult>(endpoint, `${base}/agent/network-get`, timeoutMs);
    agentNetwork = guestAgentNetworks(payload);
  }

  const ips = [...new Set([...agentNetwork.ips, ...configured.ips])].sort((left, right) => Number(left.includes(":")) - Number(right.includes(":")));
  const macs = [...new Set([...agentNetwork.macs, ...configured.macs])];
  const hostname = stringValue(config.hostname);
  const ostype = stringValue(config.ostype);
  const os = guestOsLabel(record.kind, ostype);

  return {
    ...record,
    ...(hostname ? { hostname } : {}),
    ...(ostype ? { osType: ostype } : {}),
    ...(os ? { os } : {}),
    ...(ips[0] ? { ip: ips[0], ipAddresses: ips } : {}),
    ...(macs[0] ? { mac: macs[0], macAddresses: macs } : {}),
    ...(record.kind === "PVE_VM" ? { guestAgent: agentEnabled(config) } : {})
  };
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
      if (endpoint.product === "PBS") {
        return discoverPbs(endpoint, effectiveTimeoutMs);
      }
      const resources = await apiGet<ProxmoxResource[]>(endpoint, "/cluster/resources", effectiveTimeoutMs);
      if (!Array.isArray(resources)) {
        throw new Error(`Proxmox endpoint ${endpoint.id} returned an invalid cluster resource list`);
      }
      const normalized = resources
        .map(resource => normalizeResource(endpoint, resource))
        .filter((resource): resource is ProxmoxDiscoveryRecord => resource !== null);
      return Promise.all(normalized.map(resource => enrichGuest(endpoint, resource, effectiveTimeoutMs)));
    }));

    return discovered.flat().sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async execute(_command: CommandMessage): Promise<ProviderCommandResult> {
    throw new Error("PROXMOX does not support Device Control actions");
  }
}
