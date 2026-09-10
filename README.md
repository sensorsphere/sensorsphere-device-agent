# SensorSphere Device Agent

Remote outbound-only agent used by SensorSphere to discover and control devices on networks that are not directly reachable from the SensorSphere server.

Version: **1.0.3**

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

## Docker distribution

Published multi-architecture images are available from GitHub Container Registry:

```text
ghcr.io/sensorsphere/sensorsphere-device-agent:<version>
ghcr.io/sensorsphere/sensorsphere-device-agent:latest
```

Supported image platforms:

- `linux/amd64`
- `linux/arm64`

The recommended deployment method does not require cloning this repository. Run the installer on the target machine:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/master/scripts/install.sh | bash
```

To install a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/master/scripts/install.sh | VERSION=1.0.3 bash
```

By default the installer creates:

```text
~/sensorsphere-device-agent/
├── docker-compose.yml
├── .env
├── .env.example
└── data/
```

It preserves an existing `.env` during upgrades, configures the runtime `PUID`/`PGID`, and updates `DEVICE_AGENT_IMAGE` to the selected GHCR image tag.

Edit the generated `.env` and configure at least:

```sh
SENSORSPHERE_URL=http://my_sensorsphere_base_url:8080
SENSORSPHERE_DEVICE_AGENT_TOKEN=ssda_replace_me
```

Recommended identification settings:

```sh
AGENT_NAME=device-agent-home
AGENT_LABELS=site-home,lan-main
```

For a first installation, edit the generated `.env`, then rerun the installer. Once the required SensorSphere URL and token are configured, the installer automatically pulls the selected image and runs `docker compose up -d`. You can also start it manually:

```sh
cd ~/sensorsphere-device-agent
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Check status and follow logs:

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs -f device-agent
```

To update an existing installation, rerun the installer with `VERSION=latest` or a specific release. The existing `.env` is preserved, `DEVICE_AGENT_IMAGE` is updated to the selected tag, and the installer automatically pulls and recreates the service with `docker compose up -d`.

The runtime version reported to SensorSphere is read from the `VERSION` file shipped in the image, so the reported agent version follows the published image release.

## Run from a repository checkout

```sh
cp .env.example .env
docker compose --env-file .env pull
docker compose --env-file .env up -d
docker compose --env-file .env logs -f device-agent
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
