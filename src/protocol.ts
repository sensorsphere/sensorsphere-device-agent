export interface DeviceIdentity {
  identityType: string;
  value: string;
  source?: string | null;
  labelCode?: string | null;
  label?: string | null;
  isPrimary?: boolean;
  sortOrder?: number;
}

export interface CommandMessage {
  type: "COMMAND";
  commandId: string;
  deviceId: string;
  deviceName?: string;
  provider: string;
  action: string;
  parameters?: Record<string, unknown>;
  target?: {
    identities?: DeviceIdentity[];
  };
  expiresAt?: string;
}

export interface HelloAckMessage {
  type: "HELLO_ACK";
  agentId: string;
  serverTime: string;
}

export interface HeartbeatAckMessage {
  type: "HEARTBEAT_ACK";
  serverTime: string;
}

export type ServerMessage = CommandMessage | HelloAckMessage | HeartbeatAckMessage | {
  type: string;
  [key: string]: unknown;
};

export interface ProviderCapability {
  provider: string;
  actions: string[];
}

export interface ProviderCommandResult {
  result?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface Provider {
  readonly provider: string;
  readonly actions: string[];
  execute(command: CommandMessage): Promise<ProviderCommandResult>;
}
