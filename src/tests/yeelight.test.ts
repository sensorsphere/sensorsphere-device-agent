import assert from "node:assert/strict";
import test from "node:test";
import { YeelightProvider } from "../providers/yeelight.js";

test("YeelightProvider advertises the V1 actions", () => {
  const provider = new YeelightProvider(1000);
  assert.equal(provider.provider, "YEELIGHT");
  assert.deepEqual(provider.actions, [
    "GET_STATE",
    "POWER_ON",
    "POWER_OFF",
    "SET_BRIGHTNESS",
    "SET_COLOR",
    "SET_COLOR_TEMPERATURE"
  ]);
});


test("YeelightProvider rejects unsupported discovered-device actions", async () => {
  const provider = new YeelightProvider(1000);
  await assert.rejects(provider.executeDiscoveredAction("UNKNOWN", { ip: "192.0.2.10" }, {}), /Unsupported Yeelight discovered-device action/);
});
