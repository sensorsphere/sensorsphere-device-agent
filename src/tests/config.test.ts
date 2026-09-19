import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

function withBaseEnvironment(): NodeJS.ProcessEnv {
  return {
    SENSORSPHERE_URL: "https://sensorsphere.example.test/base",
    SENSORSPHERE_DEVICE_AGENT_TOKEN: "ssda_test",
    AGENT_NAME: "test-agent",
    AGENT_LABELS: "site-home, lan-main,site-home"
  };
}

test("loadConfig derives WebSocket URL and normalizes labels", () => {
  const previous = { ...process.env };
  try {
    process.env = withBaseEnvironment();

    const config = loadConfig();
    assert.equal(config.wsUrl, "wss://sensorsphere.example.test/api/v1/device-control/agent/ws");
    assert.deepEqual(config.agentLabels, ["site-home", "lan-main"]);
    assert.equal(config.agentName, "test-agent");
    assert.deepEqual(config.proxmoxEndpoints, []);
  } finally {
    process.env = previous;
  }
});

test("loadConfig parses Proxmox API token endpoints without exposing them elsewhere", () => {
  const previous = { ...process.env };
  try {
    process.env = {
      ...withBaseEnvironment(),
      PROXMOX_REQUEST_TIMEOUT_MS: "7000",
      PROXMOX_ENDPOINTS_JSON: JSON.stringify([
        {
          id: "home-pve",
          url: "https://pve.example.test:8006/",
          tokenId: "sensorsphere@pve!discovery",
          tokenSecret: "secret-value"
        },
        {
          id: "lab-pve",
          url: "http://192.0.2.20:8006",
          tokenId: "sensorsphere@pve!discovery",
          tokenSecret: "other-secret",
          verifyTls: false
        }
      ])
    };

    const config = loadConfig();
    assert.equal(config.proxmoxRequestTimeoutMs, 7000);
    assert.deepEqual(config.proxmoxEndpoints, [
      {
        id: "home-pve",
        url: "https://pve.example.test:8006",
        tokenId: "sensorsphere@pve!discovery",
        tokenSecret: "secret-value",
        verifyTls: true
      },
      {
        id: "lab-pve",
        url: "http://192.0.2.20:8006",
        tokenId: "sensorsphere@pve!discovery",
        tokenSecret: "other-secret",
        verifyTls: false
      }
    ]);
  } finally {
    process.env = previous;
  }
});

test("loadConfig rejects duplicate Proxmox endpoint ids", () => {
  const previous = { ...process.env };
  try {
    process.env = {
      ...withBaseEnvironment(),
      PROXMOX_ENDPOINTS_JSON: JSON.stringify([
        { id: "pve", url: "https://pve-a.example.test:8006", tokenId: "u@pve!t", tokenSecret: "a" },
        { id: "pve", url: "https://pve-b.example.test:8006", tokenId: "u@pve!t", tokenSecret: "b" }
      ])
    };

    assert.throws(() => loadConfig(), /Duplicate Proxmox endpoint id pve/);
  } finally {
    process.env = previous;
  }
});
