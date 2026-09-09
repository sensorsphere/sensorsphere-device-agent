import { DeviceAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { ProviderRegistry } from "./providers/registry.js";
import { YeelightProvider } from "./providers/yeelight.js";

try {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const providers = new ProviderRegistry();
  providers.register(new YeelightProvider(config.yeelightRequestTimeoutMs));

  const agent = new DeviceAgent(config, providers, logger);

  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, stopping Device Agent");
    agent.stop();
  });

  process.on("SIGINT", () => {
    logger.info("SIGINT received, stopping Device Agent");
    agent.stop();
  });

  agent.start();
} catch (error) {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: "SensorSphere Device Agent startup failed",
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
}
