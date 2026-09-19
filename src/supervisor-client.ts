import fs from "node:fs/promises";
import net from "node:net";

export type SupervisorAction = "GET_STATUS" | "UPDATE_AGENT" | "GET_SELF_STATUS" | "UPDATE_SELF";

export interface SupervisorSelfStatus {
  install_dir?: string;
  configured_image?: string | null;
  configured_version?: string | null;
  container_id?: string | null;
  container_state?: string;
  running_image?: string | null;
  running_version?: string | null;
  update?: {
    status?: string;
    previous_version?: string | null;
    target_version?: string | null;
    error?: string | null;
  };
}

export interface SupervisorResponse {
  request_id: string;
  ok: boolean;
  action: SupervisorAction;
  result?: unknown;
  error?: string;
}

export class SupervisorClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(this.socketPath);
      return true;
    } catch {
      return false;
    }
  }

  async updateAgent(requestId: string, version: string): Promise<SupervisorResponse> {
    return this.request({ request_id: requestId, action: "UPDATE_AGENT", version });
  }

  async getSelfStatus(requestId: string): Promise<SupervisorResponse> {
    return this.request({ request_id: requestId, action: "GET_SELF_STATUS" }, Math.min(this.timeoutMs, 5000));
  }

  async updateSelf(requestId: string, version: string): Promise<SupervisorResponse> {
    return this.request({ request_id: requestId, action: "UPDATE_SELF", version });
  }

  private request(payload: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<SupervisorResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      socket.setEncoding("utf8");
      let settled = false;
      let buffer = "";

      const finish = (error?: Error, response?: SupervisorResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };

      const timer = setTimeout(() => {
        finish(new Error(`Supervisor request timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      socket.on("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });

      socket.on("data", chunk => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        try {
          const response = JSON.parse(line) as SupervisorResponse;
          if (!response || response.request_id !== payload.request_id || response.action !== payload.action || typeof response.ok !== "boolean") {
            finish(new Error("Supervisor returned an invalid response"));
            return;
          }
          finish(undefined, response);
        } catch {
          finish(new Error("Supervisor returned invalid JSON"));
        }
      });

      socket.on("error", error => finish(error));
      socket.on("close", () => {
        if (!settled) finish(new Error("Supervisor connection closed before a response was received"));
      });
    });
  }
}
