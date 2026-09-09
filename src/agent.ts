import os from "node:os";
import WebSocket from "ws";
import type { AgentConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { CommandMessage, ServerMessage } from "./protocol.js";

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

export class DeviceAgent {
  private socket: WebSocket | null = null;
  private stopped = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;

  constructor(
    private readonly config: AgentConfig,
    private readonly providers: ProviderRegistry,
    private readonly logger: Logger
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
      providers: this.providers.capabilities().map(item => item.provider)
    });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
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
      this.reconnectDelayMs = this.config.reconnectInitialMs;
      this.logger.info("Connected to SensorSphere Device Control WebSocket");
      this.send({
        type: "HELLO",
        agentName: this.config.agentName,
        version: VERSION,
        hostname: os.hostname(),
        agentLabels: this.config.agentLabels,
        capabilities: this.providers.capabilities()
      });
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
    });

    socket.on("error", error => {
      this.logger.warn("Device Control WebSocket error", { error: error.message });
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
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.reconnectMaxMs);
    this.logger.info("Scheduling Device Control WebSocket reconnect", { delay_ms: delay });
    setTimeout(() => this.connect(), delay);
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

    if (!isCommandMessage(message)) {
      this.logger.debug("Ignoring unsupported server message", { type: message.type });
      return;
    }

    await this.executeCommand(message);
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
