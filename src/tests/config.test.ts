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
    assert.equal(config.supervisorSocketPath, "/run/sensorsphere-supervisor-agent/supervisor.sock");
    assert.equal(config.supervisorRequestTimeoutMs, 130000);
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
          tokenSecret: "secret-value",
          product: "PVE"
        },
        {
          id: "lab-pve",
          url: "http://192.0.2.20:8006",
          tokenId: "sensorsphere@pve!discovery",
          tokenSecret: "other-secret",
          verifyTls: false,
          product: "PVE"
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
        verifyTls: true,
        product: "PVE"
      },
      {
        id: "lab-pve",
        url: "http://192.0.2.20:8006",
        tokenId: "sensorsphere@pve!discovery",
        tokenSecret: "other-secret",
        verifyTls: false,
        product: "PVE"
      }
    ]);
  } finally {
    process.env = previous;
  }
});

test("loadConfig parses Proxmox Backup Server endpoints", () => {
  const previous = { ...process.env };
  try {
    process.env = {
      ...withBaseEnvironment(),
      PROXMOX_ENDPOINTS_JSON: JSON.stringify([
        { id: "backup-1", product: "PBS", url: "https://pbs.example.test:8007", tokenId: "sensorsphere@pbs!discovery", tokenSecret: "pbs-secret", verifyTls: false }
      ])
    };
    const config = loadConfig();
    assert.deepEqual(config.proxmoxEndpoints, [{
      id: "backup-1", url: "https://pbs.example.test:8007", tokenId: "sensorsphere@pbs!discovery", tokenSecret: "pbs-secret", verifyTls: false, product: "PBS"
    }]);
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


test("loadConfig accepts Supervisor Agent socket settings", () => {
  const previous = { ...process.env };
  try {
    process.env = {
      ...withBaseEnvironment(),
      SENSORSPHERE_SUPERVISOR_SOCKET_PATH: "/custom/supervisor.sock",
      SENSORSPHERE_SUPERVISOR_REQUEST_TIMEOUT_MS: "150000"
    };
    const config = loadConfig();
    assert.equal(config.supervisorSocketPath, "/custom/supervisor.sock");
    assert.equal(config.supervisorRequestTimeoutMs, 150000);
  } finally {
    process.env = previous;
  }
});
