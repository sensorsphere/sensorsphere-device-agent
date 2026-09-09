# SensorSphere Device Agent

Remote outbound-only agent used by SensorSphere to discover and control devices on networks that are not directly reachable from the SensorSphere server.

Version: **1.0.0**

## Architecture

The agent opens an outbound WebSocket to SensorSphere:

```text
SensorSphere API <===== WebSocket ===== sensorsphere-device-agent ---> local devices
```

No inbound port is required on the device-agent host.

## V1 provider

`YEELIGHT`

Implemented actions:

- `GET_STATE`
- `POWER_ON`
- `POWER_OFF`
- `SET_BRIGHTNESS`
- `SET_COLOR`
- `SET_COLOR_TEMPERATURE`

The provider resolves the target from Device Registry identities sent in the SensorSphere `COMMAND` message. It currently requires an `IP` identity.

## Configuration

```sh
cp .env.example .env
```

Required:

- `SENSORSPHERE_URL`
- `SENSORSPHERE_DEVICE_AGENT_TOKEN`

Recommended:

- `AGENT_NAME`
- `AGENT_LABELS`

## Run with Docker

```sh
docker compose up -d
docker compose logs -f device-agent
```

## Local development

```sh
npm ci
npm test
npm run dev
```

## WebSocket protocol

Agent -> SensorSphere:

- `HELLO`
- `HEARTBEAT`
- `COMMAND_RESULT`
- `DEVICE_STATE`

SensorSphere -> Agent:

- `HELLO_ACK`
- `HEARTBEAT_ACK`
- `COMMAND`

The protocol is intentionally typed. The agent does not expose arbitrary shell execution.
