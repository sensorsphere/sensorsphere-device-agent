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

test("ProxmoxProvider discovers and enriches PVE nodes, QEMU VMs and LXC containers", async () => {
  let authorization = "";
  const requestedPaths: string[] = [];
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization || "";
    requestedPaths.push(request.url || "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api2/json/cluster/resources") {
      response.end(JSON.stringify({
        data: [
          { type: "node", node: "pve-1", status: "online", uptime: 1234 },
          { type: "qemu", vmid: 101, node: "pve-1", name: "homeassistant", status: "running", maxcpu: 4, maxmem: 8589934592 },
          { type: "lxc", vmid: 120, node: "pve-1", name: "mqtt", status: "stopped", template: 0 },
          { type: "storage", id: "storage/pve-1/local" }
        ]
      }));
      return;
    }
    if (request.url === "/api2/json/nodes/pve-1/qemu/101/config") {
      response.end(JSON.stringify({ data: {
        agent: "enabled=1",
        ostype: "l26",
        net0: "virtio=BC:24:11:22:33:44,bridge=vmbr0",
        ipconfig0: "ip=192.168.1.101/24,gw=192.168.1.1"
      } }));
      return;
    }
    if (request.url === "/api2/json/nodes/pve-1/qemu/101/agent/network-get") {
      response.end(JSON.stringify({ data: { result: [{
        name: "eth0",
        "hardware-address": "BC:24:11:22:33:44",
        "ip-addresses": [{ "ip-address": "10.0.0.101", "ip-address-type": "ipv4", prefix: 24 }]
      }] } }));
      return;
    }
    if (request.url === "/api2/json/nodes/pve-1/lxc/120/config") {
      response.end(JSON.stringify({ data: {
        hostname: "mqtt-lxc",
        ostype: "debian",
        net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:AA:BB:CC,ip=10.0.0.120/24,type=veth"
      } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ data: null }));
  });

  const port = await listen(server);
  try {
    const provider = new ProxmoxProvider([{
      id: "home-pve",
      url: `http://127.0.0.1:${port}`,
      tokenId: "sensorsphere@pve!discovery",
      tokenSecret: "test-secret",
      verifyTls: true,
      product: "PVE"
    }], 5000);

    const devices = await provider.discover(5000);

    assert.equal(authorization, "PVEAPIToken=sensorsphere@pve!discovery=test-secret");
    assert.ok(requestedPaths.includes("/api2/json/cluster/resources"));
    assert.ok(requestedPaths.includes("/api2/json/nodes/pve-1/qemu/101/config"));
    assert.ok(requestedPaths.includes("/api2/json/nodes/pve-1/qemu/101/agent/network-get"));
    assert.ok(requestedPaths.includes("/api2/json/nodes/pve-1/lxc/120/config"));
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
        template: false,
        hostname: "mqtt-lxc",
        osType: "debian",
        os: "Debian",
        ip: "10.0.0.120",
        ipAddresses: ["10.0.0.120"],
        mac: "BC:24:11:AA:BB:CC",
        macAddresses: ["BC:24:11:AA:BB:CC"]
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
        maxmem: 8589934592,
        osType: "l26",
        os: "Linux",
        ip: "10.0.0.101",
        ipAddresses: ["10.0.0.101", "192.168.1.101"],
        mac: "BC:24:11:22:33:44",
        macAddresses: ["BC:24:11:22:33:44"],
        guestAgent: true
      }
    ]);
  } finally {
    await close(server);
  }
});

test("ProxmoxProvider keeps base discovery when guest detail endpoints are unavailable", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api2/json/cluster/resources") {
      response.end(JSON.stringify({ data: [{ type: "qemu", vmid: 201, node: "pve-1", name: "no-agent", status: "running" }] }));
      return;
    }
    response.statusCode = 403;
    response.end(JSON.stringify({ errors: "permission denied" }));
  });

  const port = await listen(server);
  try {
    const provider = new ProxmoxProvider([{
      id: "home-pve",
      url: `http://127.0.0.1:${port}`,
      tokenId: "sensorsphere@pve!discovery",
      tokenSecret: "test-secret",
      verifyTls: true,
      product: "PVE"
    }]);
    const devices = await provider.discover(5000);
    assert.deepEqual(devices, [{
      kind: "PVE_VM",
      providerId: "home-pve:qemu:201",
      endpointId: "home-pve",
      vmid: 201,
      node: "pve-1",
      name: "no-agent",
      parentProviderId: "home-pve:node:pve-1",
      status: "running"
    }]);
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
      verifyTls: true,
      product: "PVE"
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


test("ProxmoxProvider discovers Proxmox Backup Server endpoints", async () => {
  let authorization = "";
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization || "";
    response.setHeader("content-type", "application/json");
    if (request.url === "/api2/json/version") {
      response.end(JSON.stringify({ data: { version: "4.2.6", release: "4.2.6-1", repoid: "pbs" } }));
      return;
    }
    if (request.url === "/api2/json/nodes") {
      response.end(JSON.stringify({ data: [{ node: "pbs-01", status: "online", uptime: 9876 }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ data: null }));
  });

  const port = await listen(server);
  try {
    const provider = new ProxmoxProvider([{
      id: "home-pbs",
      product: "PBS",
      url: `http://127.0.0.1:${port}`,
      tokenId: "sensorsphere@pbs!discovery",
      tokenSecret: "pbs-secret",
      verifyTls: true
    }], 5000);
    const devices = await provider.discover(5000);
    assert.equal(authorization, "PBSAPIToken=sensorsphere@pbs!discovery:pbs-secret");
    assert.deepEqual(devices, [{
      kind: "PBS_SERVER",
      providerId: "home-pbs:pbs",
      endpointId: "home-pbs",
      product: "PBS",
      name: "pbs-01",
      hostname: "pbs-01",
      node: "pbs-01",
      status: "online",
      version: "4.2.6-1",
      firmwareVersion: "4.2.6-1",
      uptime: 9876
    }]);
  } finally {
    await close(server);
  }
});
