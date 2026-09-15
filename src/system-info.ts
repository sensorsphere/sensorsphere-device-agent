import fs from "node:fs";
import os from "node:os";

export interface SystemInfo {
  os: string;
  osVersion: string;
  architecture: string;
}

function parseOsRelease(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value.replace(/\\"/g, '"');
  }
  return values;
}

export function getSystemInfo(): SystemInfo {
  let release: Record<string, string> = {};
  try { release = parseOsRelease(fs.readFileSync("/host/etc/os-release", "utf8")); } catch { /* host mount is optional for older deployments */ }
  return {
    os: release.NAME || release.ID || os.type(),
    osVersion: release.VERSION_ID || release.VERSION || os.release(),
    architecture: os.machine() || os.arch()
  };
}
