import assert from "node:assert/strict";
import test from "node:test";
import { decodeEspHomeEntityValue, decodeEspHomePower, discoveredEspHomeEntities, EspHomeProvider } from "../providers/esphome.js";

test("EspHomeProvider advertises initial V1 actions", () => {
  const provider = new EspHomeProvider();
  assert.equal(provider.provider, "ESPHOME");
  assert.deepEqual(provider.actions, ["LIST_ENTITIES", "GET_STATE", "POWER_ON", "POWER_OFF", "TOGGLE"]);
  assert.equal(typeof provider.discover, "function");
  assert.equal(typeof provider.syncDevices, "function");
  assert.equal(typeof provider.stop, "function");
});


test("decodeEspHomePower preserves proto3 false semantics for switch/light telemetry", () => {
  assert.equal(decodeEspHomePower("switch", { type: "switch", state: true }), true);
  assert.equal(decodeEspHomePower("switch", { type: "switch" }), false);
  assert.equal(decodeEspHomePower("light", { type: "light", state: true }), true);
  assert.equal(decodeEspHomePower("light", { type: "light" }), false);
  assert.equal(decodeEspHomePower("switch", undefined), null);
});


test("decodeEspHomeEntityValue preserves proto3 scalar defaults for realtime entities", () => {
  assert.equal(decodeEspHomeEntityValue("binary_sensor", { type: "binary_sensor" }), false);
  assert.equal(decodeEspHomeEntityValue("sensor", { type: "sensor" }), 0);
  assert.equal(decodeEspHomeEntityValue("number", { type: "number" }), 0);
  assert.equal(decodeEspHomeEntityValue("text_sensor", { type: "text_sensor" }), "");
  assert.equal(decodeEspHomeEntityValue("select", { type: "select", state: "Auto" }), "Auto");
  assert.equal(decodeEspHomeEntityValue("sensor", undefined), null);
});


test("discoveredEspHomeEntities reports every realtime entity type exposed by ESPHome", () => {
  assert.deepEqual(discoveredEspHomeEntities({
    light: ["light-living_room"],
    switch: ["switch-relay_1", "switch-relay_2"],
    binary_sensor: ["binary_sensor-status"],
    sensor: ["sensor-wifi_signal"],
    text_sensor: ["text_sensor-ip_address"],
    number: ["number-level"],
    select: ["select-mode"]
  }), [
    "binary_sensor:status",
    "light:living_room",
    "number:level",
    "select:mode",
    "sensor:wifi_signal",
    "switch:relay_1",
    "switch:relay_2",
    "text_sensor:ip_address"
  ]);
});
