import net from "node:net";
import type { CommandMessage, DeviceIdentity, Provider, ProviderCommandResult } from "../protocol.js";

interface YeelightResponse {
  id?: number;
  result?: unknown[];
  error?: {
    code?: number;
    message?: string;
  };
}

function resolveIp(identities: DeviceIdentity[]): string {
  const ips = identities.filter(identity => identity.identityType.toUpperCase() === "IP");
  if (ips.length === 0) throw new Error("Yeelight target has no IP identity");

  return [...ips].sort((left, right) => {
    const leftLan = (left.labelCode || left.label || left.source || "").toUpperCase() === "LAN";
    const rightLan = (right.labelCode || right.label || right.source || "").toUpperCase() === "LAN";
    if (leftLan !== rightLan) return leftLan ? -1 : 1;
    if (Boolean(left.isPrimary) !== Boolean(right.isPrimary)) return left.isPrimary ? -1 : 1;
    return (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
  })[0]!.value;
}

function requireNumber(parameters: Record<string, unknown>, key: string): number {
  const value = parameters[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function parseRgb(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return value;
  }
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return Number.parseInt(value.slice(1), 16);
  }
  throw new Error("color must be a #RRGGBB string or integer 0..16777215");
}

export class YeelightProvider implements Provider {
  readonly provider = "YEELIGHT";
  readonly actions = [
    "GET_STATE",
    "POWER_ON",
    "POWER_OFF",
    "SET_BRIGHTNESS",
    "SET_COLOR",
    "SET_COLOR_TEMPERATURE"
  ];

  private nextId = 1;

  constructor(private readonly timeoutMs: number) {}

  async execute(command: CommandMessage): Promise<ProviderCommandResult> {
    const ip = resolveIp(command.target?.identities ?? []);
    const parameters = command.parameters ?? {};

    if (command.action === "GET_STATE") {
      const state = await this.getState(ip);
      return { result: state, state };
    }

    if (command.action === "POWER_ON") {
      await this.call(ip, "set_power", ["on", "smooth", 300]);
    } else if (command.action === "POWER_OFF") {
      await this.call(ip, "set_power", ["off", "smooth", 300]);
    } else if (command.action === "SET_BRIGHTNESS") {
      const brightness = Math.round(requireNumber(parameters, "brightness"));
      if (brightness < 1 || brightness > 100) throw new Error("brightness must be between 1 and 100");
      await this.call(ip, "set_bright", [brightness, "smooth", 300]);
    } else if (command.action === "SET_COLOR") {
      const rgb = parseRgb(parameters.color ?? parameters.rgb);
      await this.call(ip, "set_rgb", [rgb, "smooth", 300]);
    } else if (command.action === "SET_COLOR_TEMPERATURE") {
      const kelvin = Math.round(requireNumber(parameters, "colorTemperature"));
      if (kelvin < 1700 || kelvin > 6500) {
        throw new Error("colorTemperature must be between 1700 and 6500 K");
      }
      await this.call(ip, "set_ct_abx", [kelvin, "smooth", 300]);
    } else {
      throw new Error(`Unsupported Yeelight action ${command.action}`);
    }

    const state = await this.getState(ip);
    return { result: { ok: true }, state };
  }

  private async getState(ip: string): Promise<Record<string, unknown>> {
    const response = await this.call(ip, "get_prop", ["power", "bright", "rgb", "ct", "hue", "sat"]);
    const values = response.result ?? [];
    return {
      power: values[0] === "on",
      brightness: Number(values[1] ?? 0),
      rgb: Number(values[2] ?? 0),
      colorTemperature: Number(values[3] ?? 0),
      hue: Number(values[4] ?? 0),
      saturation: Number(values[5] ?? 0)
    };
  }

  private call(ip: string, method: string, params: unknown[]): Promise<YeelightResponse> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\r\n`;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: ip, port: 55443 });
      let buffer = "";
      let settled = false;

      const finish = (error?: Error, response?: YeelightResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(response ?? {});
      };

      const timer = setTimeout(() => finish(new Error(`Yeelight request timeout to ${ip}:55443`)), this.timeoutMs);

      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(payload));
      socket.on("data", chunk => {
        buffer += chunk;
        while (buffer.includes("\r\n")) {
          const index = buffer.indexOf("\r\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!line.trim()) continue;

          try {
            const response = JSON.parse(line) as YeelightResponse;
            if (response.id !== id) continue;
            if (response.error) {
              finish(new Error(`Yeelight error ${response.error.code ?? ""}: ${response.error.message ?? "unknown error"}`));
              return;
            }
            finish(undefined, response);
            return;
          } catch {
            // Ignore unsolicited/non-JSON lines and continue waiting for our response.
          }
        }
      });
      socket.once("error", error => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new Error(`Yeelight connection closed by ${ip}:55443`));
      });
    });
  }
}
