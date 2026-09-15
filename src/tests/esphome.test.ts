import assert from "node:assert/strict";
import test from "node:test";
import { decodeEspHomeEntityValue, decodeEspHomePower, EspHomeProvider } from "../providers/esphome.js";

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
