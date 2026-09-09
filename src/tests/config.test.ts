import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig derives WebSocket URL and normalizes labels", () => {
  const previous = { ...process.env };
  try {
    process.env.SENSORSPHERE_URL = "https://sensorsphere.example.test/base";
    process.env.SENSORSPHERE_DEVICE_AGENT_TOKEN = "ssda_test";
    process.env.AGENT_NAME = "test-agent";
    process.env.AGENT_LABELS = "site-home, lan-main,site-home";

    const config = loadConfig();
    assert.equal(config.wsUrl, "wss://sensorsphere.example.test/api/v1/device-control/agent/ws");
    assert.deepEqual(config.agentLabels, ["site-home", "lan-main"]);
    assert.equal(config.agentName, "test-agent");
  } finally {
    process.env = previous;
  }
});
