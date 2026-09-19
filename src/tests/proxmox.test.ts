import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { ProxmoxProvider } from "../providers/proxmox.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("ProxmoxProvider discovers PVE nodes, QEMU VMs and LXC containers with stable ids", async () => {
  let authorization = "";
  let requestedPath = "";
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization || "";
    requestedPath = request.url || "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [
        { type: "node", node: "pve-1", status: "online", uptime: 1234 },
        { type: "qemu", vmid: 101, node: "pve-1", name: "homeassistant", status: "running", maxcpu: 4, maxmem: 8589934592 },
        { type: "lxc", vmid: 120, node: "pve-1", name: "mqtt", status: "stopped", template: 0 },
        { type: "storage", id: "storage/pve-1/local" }
      ]
    }));
  });

  const port = await listen(server);
  try {
    const provider = new ProxmoxProvider([{
      id: "home-pve",
      url: `http://127.0.0.1:${port}`,
      tokenId: "sensorsphere@pve!discovery",
      tokenSecret: "test-secret",
      verifyTls: true
    }], 5000);

    const devices = await provider.discover(5000);

    assert.equal(requestedPath, "/api2/json/cluster/resources");
    assert.equal(authorization, "PVEAPIToken=sensorsphere@pve!discovery=test-secret");
    assert.deepEqual(devices, [
      {
        kind: "PVE_LXC",
        providerId: "home-pve:lxc:120",
        endpointId: "home-pve",
        vmid: 120,
        node: "pve-1",
        name: "mqtt",
        parentProviderId: "home-pve:node:pve-1",
        status: "stopped",
        template: false
      },
      {
        kind: "PVE_NODE",
        providerId: "home-pve:node:pve-1",
        endpointId: "home-pve",
        node: "pve-1",
        name: "pve-1",
        status: "online",
        uptime: 1234
      },
      {
        kind: "PVE_VM",
        providerId: "home-pve:qemu:101",
        endpointId: "home-pve",
        vmid: 101,
        node: "pve-1",
        name: "homeassistant",
        parentProviderId: "home-pve:node:pve-1",
        status: "running",
        maxcpu: 4,
        maxmem: 8589934592
      }
    ]);
  } finally {
    await close(server);
  }
});

test("ProxmoxProvider error messages identify an endpoint without exposing its token secret", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.end("authentication failed");
  });

  const port = await listen(server);
  try {
    const provider = new ProxmoxProvider([{
      id: "home-pve",
      url: `http://127.0.0.1:${port}`,
      tokenId: "sensorsphere@pve!discovery",
      tokenSecret: "never-log-this",
      verifyTls: true
    }]);

    await assert.rejects(
      () => provider.discover(5000),
      error => error instanceof Error
        && error.message.includes("home-pve")
        && !error.message.includes("never-log-this")
    );
  } finally {
    await close(server);
  }
});
