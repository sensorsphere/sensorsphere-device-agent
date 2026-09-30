# Changelog

## 1.9.2 - 2026-09-30

- Use the complete ESPHome entity registry for realtime subscriptions so the Entities view matches Discovery.
- Increase the Device Agent discovery timeout range to support longer discovery runs.

## 1.0.0 - 2026-09-09

- Initial SensorSphere Device Agent.
- Outbound authenticated WebSocket connection to SensorSphere.
- HELLO and heartbeat lifecycle with automatic reconnect/backoff.
- Generic typed provider registry.
- Initial Yeelight LAN provider.
- Yeelight power, brightness, RGB, color-temperature and state operations.
- Device Registry identity based target resolution.
- Docker and Docker Compose deployment.
