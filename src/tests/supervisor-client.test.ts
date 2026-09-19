import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SupervisorClient } from "../supervisor-client.js";

async function createSocketServer(handler: (line: string, socket: net.Socket) => void): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-agent-supervisor-"));
  const socketPath = path.join(dir, "supervisor.sock");
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) handler(buffer.slice(0, newline), socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

test("SupervisorClient reports unavailable when the socket does not exist", async () => {
  const client = new SupervisorClient("/tmp/does-not-exist/supervisor.sock", 100);
  assert.equal(await client.isAvailable(), false);
});

test("SupervisorClient sends UPDATE_AGENT and parses the response", async () => {
  const fixture = await createSocketServer((line, socket) => {
    assert.deepEqual(JSON.parse(line), {
      request_id: "update-1",
      action: "UPDATE_AGENT",
      version: "1.2.0"
    });
    socket.write(`${JSON.stringify({ request_id: "update-1", ok: true, action: "UPDATE_AGENT", result: { target_version: "1.2.0" } })}\n`);
  });
  try {
    const client = new SupervisorClient(fixture.socketPath, 1000);
    assert.equal(await client.isAvailable(), true);
    const response = await client.updateAgent("update-1", "1.2.0");
    assert.equal(response.ok, true);
  } finally {
    await fixture.close();
  }
});

test("SupervisorClient rejects malformed responses", async () => {
  const fixture = await createSocketServer((_line, socket) => socket.write("not-json\n"));
  try {
    const client = new SupervisorClient(fixture.socketPath, 1000);
    await assert.rejects(() => client.updateAgent("update-2", "1.2.0"), /invalid JSON/);
  } finally {
    await fixture.close();
  }
});
