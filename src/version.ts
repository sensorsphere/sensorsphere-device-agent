import { readFileSync } from "node:fs";

function resolveVersion(): string {
  const environmentVersion = process.env.SENSORSPHERE_DEVICE_AGENT_VERSION?.trim();
  if (environmentVersion) return environmentVersion;

  try {
    const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
    return version || "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = resolveVersion();
