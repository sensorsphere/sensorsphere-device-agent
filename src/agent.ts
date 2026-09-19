import os from "node:os";
import WebSocket from "ws";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { AgentUpdateRequestMessage, CommandMessage, DiscoveredDeviceActionRequestMessage, DiscoverRequestMessage, ServerMessage, SyncDevicesMessage } from "./protocol.js";

function isDiscoverRequestMessage(message: ServerMessage): message is DiscoverRequestMessage {
  return message.type === "DISCOVER_REQUEST"
    && "commandId" in message
    && typeof message.commandId === "string"
    && "provider" in message
    && typeof message.provider === "string";
}

function isAgentUpdateRequestMessage(message: ServerMessage): message is AgentUpdateRequestMessage {
  return message.type === "AGENT_UPDATE_REQUEST"
    && "commandId" in message && typeof message.commandId === "string"
    && "version" in message && typeof message.version === "string";
}

function isDiscoveredDeviceActionRequestMessage(message: ServerMessage): message is DiscoveredDeviceActionRequestMessage {
  return message.type === "DISCOVERED_DEVICE_ACTION_REQUEST"
    && "commandId" in message && typeof message.commandId === "string"
    && "provider" in message && typeof message.provider === "string"
    && "action" in message && typeof message.action === "string"
    && "target" in message && typeof message.target === "object" && message.target !== null;
}

function isSyncDevicesMessage(message: ServerMessage): message is SyncDevicesMessage {
  return message.type === "SYNC_DEVICES"
    && "provider" in message && typeof message.provider === "string"
    && "devices" in message && Array.isArray(message.devices);
}

function isCommandMessage(message: ServerMessage): message is CommandMessage {
  return message.type === "COMMAND"
    && "commandId" in message
    && typeof message.commandId === "string"
    && "deviceId" in message
    && typeof message.deviceId === "string"
    && "provider" in message
    && typeof message.provider === "string"
    && "action" in message
    && typeof message.action === "string";
}
import type { ProviderRegistry } from "./providers/registry.js";
import { VERSION } from "./version.js";
import { getSystemInfo } from "./system-info.js";
import type { SupervisorClient } from "./supervisor-client.js";

export class DeviceAgent {
  private socket: WebSocket | null = null;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;

  constructor(
    private readonly config: AgentConfig,
    private readonly providers: ProviderRegistry,
    private readonly logger: Logger,
    private readonly supervisor: SupervisorClient
  ) {
    this.reconnectDelayMs = config.reconnectInitialMs;
  }

  start(): void {
    this.logger.info("SensorSphere Device Agent starting", {
      version: VERSION,
      hostname: os.hostname(),
      agent_name: this.config.agentName,
      agent_labels: this.config.agentLabels,
      sensorsphere_url: this.config.sensorsphereUrl,
      websocket_url: this.config.wsUrl,
      providers: this.providers.capabilities().map(item => item.provider),
      supervisor_socket: this.config.supervisorSocketPath
    });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnect();
    void this.providers.stop().catch(error => {
      this.logger.warn("Failed to stop provider subscriptions", { error: error instanceof Error ? error.message : String(error) });
    });
    this.socket?.close(1000, "Agent stopping");
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;

    this.logger.info("Connecting to SensorSphere Device Control WebSocket", {
      websocket_url: this.config.wsUrl
    });

    const socket = new WebSocket(this.config.wsUrl, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "X-SensorSphere-Agent-Name": this.config.agentName
      }
    });
    this.socket = socket;

    socket.on("open", () => {
      this.clearReconnect();
      this.reconnectDelayMs = this.config.reconnectInitialMs;
      this.logger.info("Connected to SensorSphere Device Control WebSocket");
      void this.sendHello();
      this.heartbeatTimer = setInterval(() => this.send({ type: "HEARTBEAT" }), this.config.heartbeatIntervalMs);
    });

    socket.on("message", data => {
      void this.handleMessage(data.toString()).catch(error => {
        this.logger.error("Failed to process WebSocket message", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    socket.on("unexpected-response", (_request, response) => {
      this.logger.error("SensorSphere rejected Device Agent WebSocket connection", {
        status_code: response.statusCode,
        status_message: response.statusMessage
      });
      if (this.socket === socket) this.socket = null;
      try {
        response.resume();
      } catch {
        // Ignore response cleanup errors; reconnect scheduling is the important path.
      }
      try {
        socket.terminate();
      } catch {
        // The socket may already be closed by ws after a failed handshake.
      }
      this.scheduleReconnect();
    });

    socket.on("error", error => {
      this.logger.warn("Device Control WebSocket error", { error: error.message });
      if (socket.readyState !== WebSocket.OPEN) {
        this.scheduleReconnect();
      }
    });

    socket.on("close", (code, reason) => {
      this.clearHeartbeat();
      if (this.socket === socket) this.socket = null;
      this.logger.warn("Device Control WebSocket disconnected", {
        code,
        reason: reason.toString()
      });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
    this.logger.info("Scheduling Device Control WebSocket reconnect", { delay_ms: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.logger.warn("Ignoring invalid JSON WebSocket message");
      return;
    }

    if (message.type === "HELLO_ACK") {
      this.logger.info("Device Agent authenticated by SensorSphere", {
        agent_id: "agentId" in message ? message.agentId : undefined
      });
      return;
    }

    if (message.type === "HEARTBEAT_ACK") return;

    if (isSyncDevicesMessage(message)) {
      await this.providers.syncDevices(message.provider, message.devices, (deviceId, provider, state) => {
        this.send({ type: "DEVICE_STATE", deviceId, provider, state });
      });
      this.logger.info("Synchronized realtime provider devices", { provider: message.provider, devices: message.devices.length });
      return;
    }

    if (isDiscoverRequestMessage(message)) {
      await this.executeDiscovery(message);
      return;
    }

    if (isAgentUpdateRequestMessage(message)) {
      await this.executeAgentUpdate(message);
      return;
    }

    if (isDiscoveredDeviceActionRequestMessage(message)) {
      await this.executeDiscoveredDeviceAction(message);
      return;
    }

    if (!isCommandMessage(message)) {
      this.logger.debug("Ignoring unsupported server message", { type: message.type });
      return;
    }

    await this.executeCommand(message);
  }


  private async sendHello(): Promise<void> {
    const systemInfo = getSystemInfo();
    const supervisorAvailable = await this.supervisor.isAvailable();
    this.send({
      type: "HELLO",
      agentName: this.config.agentName,
      version: VERSION,
      hostname: os.hostname(),
      systemInfo,
      agentLabels: this.config.agentLabels,
      capabilities: this.providers.capabilities(),
      agentUpdate: { supported: supervisorAvailable }
    });
    this.logger.info("Reported Supervisor Agent availability", { available: supervisorAvailable });
  }

  private async executeAgentUpdate(request: AgentUpdateRequestMessage): Promise<void> {
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) {
      this.send({ type: "AGENT_UPDATE_RESULT", commandId: request.commandId, status: "REJECTED", error: "Update request expired before execution" });
      return;
    }

    if (!(await this.supervisor.isAvailable())) {
      this.send({ type: "AGENT_UPDATE_RESULT", commandId: request.commandId, status: "FAILED", error: "Supervisor Agent is unavailable" });
      return;
    }

    this.logger.info("Forwarding Device Agent update to Supervisor Agent", {
      command_id: request.commandId,
      current_version: VERSION,
      target_version: request.version
    });

    // A successful update recreates this container. Acknowledge first so SensorSphere
    // can transition to VERIFYING and then confirm the target version on the next HELLO.
    this.send({
      type: "AGENT_UPDATE_RESULT",
      commandId: request.commandId,
      status: "ACCEPTED",
      currentVersion: VERSION,
      targetVersion: request.version
    });

    try {
      const response = await this.supervisor.updateAgent(request.commandId, request.version);
      if (!response.ok) {
        const error = response.error || "Supervisor Agent rejected the update";
        this.send({ type: "AGENT_UPDATE_RESULT", commandId: request.commandId, status: "FAILED", error });
        this.logger.warn("Supervisor Agent update failed", { command_id: request.commandId, target_version: request.version, error });
        return;
      }

      // This result is best-effort: on a real version change this process is normally
      // terminated by docker compose before the Supervisor response can be relayed.
      this.send({ type: "AGENT_UPDATE_RESULT", commandId: request.commandId, status: "SUCCESS", result: response.result ?? {} });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "AGENT_UPDATE_RESULT", commandId: request.commandId, status: "FAILED", error: message });
      this.logger.warn("Failed to communicate with Supervisor Agent", { command_id: request.commandId, target_version: request.version, error: message });
    }
  }


  private async executeDiscovery(request: DiscoverRequestMessage): Promise<void> {
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 4000, 1000), 15000);
    this.logger.info("Executing device discovery", {
      command_id: request.commandId,
      provider: request.provider,
      timeout_ms: timeoutMs
    });

    try {
      const devices = await this.providers.discover(request.provider, timeoutMs);
      this.send({
        type: "DISCOVER_RESULT",
        commandId: request.commandId,
        provider: request.provider,
        status: "SUCCESS",
        devices
      });
      this.logger.info("Device discovery succeeded", {
        command_id: request.commandId,
        provider: request.provider,
        devices: devices.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        type: "DISCOVER_RESULT",
        commandId: request.commandId,
        provider: request.provider,
        status: "FAILED",
        devices: [],
        error: message
      });
      this.logger.warn("Device discovery failed", {
        command_id: request.commandId,
        provider: request.provider,
        error: message
      });
    }
  }

  private async executeDiscoveredDeviceAction(request: DiscoveredDeviceActionRequestMessage): Promise<void> {
    this.logger.info("Executing discovered device action", { command_id: request.commandId, provider: request.provider, action: request.action, target_ip: typeof request.target.ip === "string" ? request.target.ip : undefined });
    try {
      const result = await this.providers.executeDiscoveredAction(request.provider, request.action, request.target, request.parameters ?? {});
      this.send({ type: "DISCOVERED_DEVICE_ACTION_RESULT", commandId: request.commandId, provider: request.provider, action: request.action, status: "SUCCESS", result });
      this.logger.info("Discovered device action succeeded", { command_id: request.commandId, provider: request.provider, action: request.action });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({ type: "DISCOVERED_DEVICE_ACTION_RESULT", commandId: request.commandId, provider: request.provider, action: request.action, status: "FAILED", error: message });
      this.logger.warn("Discovered device action failed", { command_id: request.commandId, provider: request.provider, action: request.action, error: message });
    }
  }

  private async executeCommand(command: CommandMessage): Promise<void> {
    if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now()) {
      this.send({
        type: "COMMAND_RESULT",
        commandId: command.commandId,
        status: "REJECTED",
        error: "Command expired before execution"
      });
      return;
    }

    this.logger.info("Executing device command", {
      command_id: command.commandId,
      device_id: command.deviceId,
      device_name: command.deviceName,
      provider: command.provider,
      action: command.action
    });

    try {
      const execution = await this.providers.execute(command);
      this.send({
        type: "COMMAND_RESULT",
        commandId: command.commandId,
        status: "SUCCESS",
        result: execution.result ?? {}
      });
      if (execution.state) {
        this.send({
          type: "DEVICE_STATE",
          deviceId: command.deviceId,
          provider: command.provider,
          state: execution.state
        });
      }
      this.logger.info("Device command succeeded", {
        command_id: command.commandId,
        provider: command.provider,
        action: command.action
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        type: "COMMAND_RESULT",
        commandId: command.commandId,
        status: "FAILED",
        error: message
      });
      this.logger.warn("Device command failed", {
        command_id: command.commandId,
        provider: command.provider,
        action: command.action,
        error: message
      });
    }
  }
}
