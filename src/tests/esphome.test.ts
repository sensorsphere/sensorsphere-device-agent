import assert from "node:assert/strict";
import test from "node:test";
import { EspHomeProvider } from "../providers/esphome.js";

test("EspHomeProvider advertises initial V1 actions", () => {
  const provider = new EspHomeProvider();
  assert.equal(provider.provider, "ESPHOME");
  assert.deepEqual(provider.actions, ["LIST_ENTITIES", "GET_STATE", "POWER_ON", "POWER_OFF", "TOGGLE"]);
  assert.equal(typeof provider.discover, "function");
});
