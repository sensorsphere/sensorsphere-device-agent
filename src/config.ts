import os from "node:os";
import type { LogLevel } from "./logger.js";

export interface ProxmoxEndpointConfig {
  id: string;
  url: string;
  tokenId: string;
  tokenSecret: string;
  verifyTls: boolean;
  product: "PVE" | "PBS";
}

export interface AgentConfig {
  sensorsphereUrl: string;
  wsUrl: string;
  token: string;
  agentName: string;
  agentLabels: string[];
  logLevel: LogLevel;
  heartbeatIntervalMs: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  yeelightRequestTimeoutMs: number;
  esphomeRequestTimeoutMs: number;
  esphomeNoisePsk: string | null;
  proxmoxRequestTimeoutMs: number;
  proxmoxEndpoints: ProxmoxEndpointConfig[];
  supervisorSocketPath: string;
  supervisorRequestTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseLabels(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
}

function parseProxmoxEndpoints(raw: string | undefined): ProxmoxEndpointConfig[] {
  const text = raw?.trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("PROXMOX_ENDPOINTS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("PROXMOX_ENDPOINTS_JSON must be a JSON array");
  }

  const seenIds = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}] must be an object`);
    }

    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const url = typeof value.url === "string" ? value.url.trim() : "";
    const tokenId = typeof value.tokenId === "string" ? value.tokenId.trim() : "";
    const tokenSecret = typeof value.tokenSecret === "string" ? value.tokenSecret.trim() : "";
    const verifyTls = value.verifyTls === undefined ? true : value.verifyTls;
    const rawProduct = typeof value.product === "string" ? value.product.trim().toUpperCase() : "PVE";

    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].id must contain only letters, digits, '.', '_' or '-'`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate Proxmox endpoint id ${id}`);
    }
    seenIds.add(id);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].url must be a valid HTTP(S) URL`);
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].url must be an HTTP(S) URL without embedded credentials`);
    }
    if (!tokenId || !tokenId.includes("!")) {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].tokenId must be a Proxmox API token id such as user@realm!token`);
    }
    if (!tokenSecret) {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].tokenSecret is required`);
    }
    if (typeof verifyTls !== "boolean") {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].verifyTls must be a boolean`);
    }
    if (rawProduct !== "PVE" && rawProduct !== "PBS") {
      throw new Error(`PROXMOX_ENDPOINTS_JSON[${index}].product must be PVE or PBS`);
    }

    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
    parsedUrl.search = "";
    parsedUrl.hash = "";

    return {
      id,
      url: parsedUrl.toString().replace(/\/$/, ""),
      tokenId,
      tokenSecret,
      verifyTls,
      product: rawProduct as "PVE" | "PBS"
    };
  });
}

function deriveWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/device-control/agent/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function loadConfig(): AgentConfig {
  const sensorsphereUrl = required("SENSORSPHERE_URL");
  const token = required("SENSORSPHERE_DEVICE_AGENT_TOKEN");
  const explicitWs = process.env.SENSORSPHERE_DEVICE_AGENT_WS_URL?.trim();

  const rawLogLevel = (process.env.SENSORSPHERE_LOG_LEVEL?.trim().toLowerCase() || "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(rawLogLevel)) {
    throw new Error("SENSORSPHERE_LOG_LEVEL must be debug, info, warn or error");
  }

  return {
    sensorsphereUrl,
    wsUrl: explicitWs || deriveWsUrl(sensorsphereUrl),
    token,
    agentName: process.env.AGENT_NAME?.trim() || os.hostname(),
    agentLabels: parseLabels(process.env.AGENT_LABELS),
    logLevel: rawLogLevel,
    heartbeatIntervalMs: positiveInt("SENSORSPHERE_HEARTBEAT_INTERVAL_SECONDS", 20) * 1000,
    reconnectInitialMs: positiveInt("SENSORSPHERE_RECONNECT_INITIAL_MS", 1000),
    reconnectMaxMs: positiveInt("SENSORSPHERE_RECONNECT_MAX_MS", 30000),
    yeelightRequestTimeoutMs: positiveInt("YEELIGHT_REQUEST_TIMEOUT_MS", 5000),
    esphomeRequestTimeoutMs: positiveInt("ESPHOME_REQUEST_TIMEOUT_MS", 5000),
    esphomeNoisePsk: process.env.ESPHOME_NOISE_PSK?.trim() || null,
    proxmoxRequestTimeoutMs: positiveInt("PROXMOX_REQUEST_TIMEOUT_MS", 5000),
    proxmoxEndpoints: parseProxmoxEndpoints(process.env.PROXMOX_ENDPOINTS_JSON),
    supervisorSocketPath: process.env.SENSORSPHERE_SUPERVISOR_SOCKET_PATH?.trim() || "/run/sensorsphere-supervisor-agent/supervisor.sock",
    supervisorRequestTimeoutMs: positiveInt("SENSORSPHERE_SUPERVISOR_REQUEST_TIMEOUT_MS", 130000)
  };
}
