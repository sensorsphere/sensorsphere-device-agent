import os from "node:os";
import type { LogLevel } from "./logger.js";

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
    yeelightRequestTimeoutMs: positiveInt("YEELIGHT_REQUEST_TIMEOUT_MS", 5000)
  };
}
