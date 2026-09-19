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

export interface SyncedDevice {
  deviceId: string;
  deviceName?: string;
  provider: string;
  identities: DeviceIdentity[];
}

export interface SyncDevicesMessage {
  type: "SYNC_DEVICES";
  provider: string;
  devices: SyncedDevice[];
}

export interface DiscoverRequestMessage {
  type: "DISCOVER_REQUEST";
  commandId: string;
  provider: string;
  timeoutMs?: number;
}


export interface AgentUpdateRequestMessage {
  type: "AGENT_UPDATE_REQUEST";
  commandId: string;
  version: string;
  expiresAt?: string;
}

export interface SupervisorUpdateRequestMessage {
  type: "SUPERVISOR_UPDATE_REQUEST";
  commandId: string;
  version: string;
  expiresAt?: string;
}

export interface DiscoveredDeviceActionRequestMessage {
  type: "DISCOVERED_DEVICE_ACTION_REQUEST";
  commandId: string;
  provider: string;
  action: string;
  target: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

export type ServerMessage = CommandMessage | DiscoverRequestMessage | AgentUpdateRequestMessage | SupervisorUpdateRequestMessage | DiscoveredDeviceActionRequestMessage | HelloAckMessage | HeartbeatAckMessage | SyncDevicesMessage | {
  type: string;
  [key: string]: unknown;
};

export interface ProviderCapability {
  provider: string;
  actions: string[];
  discovery?: boolean;
}

export interface ProviderCommandResult {
  result?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export type ProviderStateSink = (deviceId: string, provider: string, state: Record<string, unknown>) => void;

export interface Provider {
  readonly provider: string;
  readonly actions: string[];
  execute(command: CommandMessage): Promise<ProviderCommandResult>;
  syncDevices?(devices: SyncedDevice[], onState: ProviderStateSink): Promise<void>;
  stop?(): Promise<void> | void;
  discover?(timeoutMs: number): Promise<Array<Record<string, unknown>>>;
  executeDiscoveredAction?(action: string, target: Record<string, unknown>, parameters: Record<string, unknown>): Promise<Record<string, unknown>>;
}
