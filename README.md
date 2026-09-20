# SensorSphere Device Agent

Remote outbound-only agent used by SensorSphere to discover and control devices on networks that are not directly reachable from the SensorSphere server.

Version: **1.8.2**

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

## Recommended deployment lifecycle

For hosts managed by SensorSphere, install one **Supervisor Agent** per host first. The Supervisor owns local Docker lifecycle operations for Device and Monitor Agents through a Unix socket; it does not expose a network management port.

For a new Device Agent installation, the repository installer remains the simplest bootstrap method:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/master/scripts/install.sh | VERSION=1.8.2 bash
```

On first install, edit `~/sensorsphere-device-agent/.env` and configure `SENSORSPHERE_URL` and `SENSORSPHERE_DEVICE_AGENT_TOKEN`, then rerun the same installer. Existing `.env` values are preserved during upgrades.

Once a compatible Device Agent can reach the local Supervisor socket, later Device Agent updates should normally be requested from SensorSphere. For legacy Device Agents that predate Supervisor support, install the Supervisor first, perform one manual Device Agent upgrade with `scripts/install.sh`, then use SensorSphere-managed updates thereafter.

Quick verification:

```sh
cd ~/sensorsphere-device-agent
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=100 device-agent
test -S /run/sensorsphere-supervisor-agent/supervisor.sock && echo "Supervisor socket OK"
```

## Docker distribution

Published multi-architecture images are available from GitHub Container Registry:

```text
ghcr.io/sensorsphere/sensorsphere-device-agent:<version>
ghcr.io/sensorsphere/sensorsphere-device-agent:latest
```

Supported image platforms:

- `linux/amd64`
- `linux/arm64`
- `linux/arm/v7`

The recommended deployment method does not require cloning this repository. Run the installer on the target machine:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/master/scripts/install.sh | bash
```

To install a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/master/scripts/install.sh | VERSION=1.0.5 bash
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

The production Compose service uses Linux host networking. This is intentional: LAN discovery providers such as Yeelight rely on local UDP multicast/broadcast traffic that is not reliably delivered through Docker bridge networking. The agent exposes no listening application port, so host networking does not publish an additional SensorSphere service port.

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


## Yeelight discovery

When the `YEELIGHT` provider is available, SensorSphere can ask the Device Agent to discover Yeelight devices on the agent's local network. The agent sends the standard Yeelight LAN `M-SEARCH` UDP multicast request to `239.255.255.250:1982`, collects unicast responses for the requested discovery window, and returns normalized device metadata to SensorSphere over the existing outbound WebSocket.

The Device Agent must run on the same local network segment as the Yeelight devices for multicast discovery. Routed TCP connectivity to port `55443` is sufficient for control but does not make multicast discovery cross routers. The supplied Docker Compose file therefore uses `network_mode: host` so the container participates directly in the host network stack.

Discovery requires Yeelight LAN Control to be enabled on the bulbs. No inbound SensorSphere port is opened on the Device Agent host.


## Actions on discovered devices

SensorSphere can execute provider-specific actions on devices found by discovery before import. Yeelight supports `SET_NAME`, which sends the LAN `set_name` command to the discovered IP.

## Yeelight discovery actions

Discovery results support `SET_NAME`, `POWER_ON`, and `POWER_OFF` so an operator can rename or visually identify a discovered bulb before importing it into Device Registry. Registered Yeelight devices also expose `SET_NAME` through Device Control.


### Stable discovery identities

Yeelight discovery reports the native Yeelight `id` and, when available in the local Linux ARP cache, the device MAC address. SensorSphere uses these stable identities to match discovery results with Device Registry entries; the DHCP-assigned IP address is not used as the registration key.

Actions executed on a discovered Yeelight return the refreshed state of that bulb. SensorSphere can therefore update only the affected discovery row after `SET_NAME`, `POWER_ON`, or `POWER_OFF` without rerunning a full multicast scan.

## Yeelight richer control

Registered Yeelight devices support power, brightness, RGB, color temperature, HSV, toggle, configurable smooth transitions, Set default, and device naming through SensorSphere Device Control.


## ESPHome provider foundation

The `ESPHOME` provider uses the ESPHome Native API on its standard TCP port 6053. The initial provider supports `GET_STATE`, `POWER_ON`, `POWER_OFF`, and `TOGGLE` for `light` and `switch` entities.

A Device Registry entry must provide an `IP`, `FQDN`, or `HOSTNAME` identity. If the ESPHome node exposes more than one controllable light/switch entity, also add an `ESPHOME_ENTITY` identity in the form `light:<object_id>` or `switch:<object_id>`. When exactly one light/switch entity exists, the provider selects it automatically.

For Native API encryption, configure `ESPHOME_NOISE_PSK` on the Device Agent. V1 uses one optional PSK per Device Agent, which is suitable for installations that share an ESPHome API encryption key across devices. Leave it empty for unencrypted Native API endpoints.

ESPHome discovery uses mDNS/DNS-SD `_esphomelib._tcp` advertisements on the local LAN. The Device Agent must therefore run with host networking and on a segment where ESPHome mDNS is visible. Discovery reports the node name, IP/hostname, API port, MAC address, board, ESPHome firmware version, and advertised light/switch entities when the Native API connection can be opened with the configured PSK.

The discovery implementation queries mDNS directly with `multicast-dns` on every active non-loopback IPv4 interface and deduplicates responses. This avoids relying on higher-level Bonjour browsing behavior on multi-homed hosts and keeps discovery fully self-contained in Node.js.

ESPHome Native API control prefers the registered `IP` identity over `FQDN`/`HOSTNAME` so `.local` names discovered by mDNS do not require resolver support inside the Device Agent container.

- ESPHome entity enumeration (`LIST_ENTITIES`) reports each controllable light/switch and its latest boolean power state when available without failing when an initial state has not yet arrived. Device Control can address any listed entity per command while `ESPHOME_ENTITY` remains the persisted default. `POWER_ON`/`POWER_OFF` use the command acknowledgement to establish state; `TOGGLE` requires a known boolean state.


### ESPHome realtime state foundation

ESPHome devices assigned to this Device Agent are synchronized by SensorSphere over the existing agent WebSocket. The provider keeps a persistent Native API connection per registered ESPHome device, subscribes to light/switch telemetry, reconnects automatically, and publishes state changes back to SensorSphere as `DEVICE_STATE` messages.

The realtime stream is the source of truth for entity state. Control commands no longer overwrite the aggregate realtime device state. Changes made outside SensorSphere, including from the ESPHome Web UI, are reflected through Native API telemetry.

## ESPHome realtime entity model

ESPHome realtime subscriptions now publish a generic entity model for light, switch, sensor, binary_sensor, text_sensor, number and select entities. Each entity carries its current value, unit when advertised, raw metadata, observation timestamp and whether SensorSphere currently exposes control actions for it.

### 1.0.21

- Device Control WebSocket reconnects after failed HTTP handshakes (including transient 502/503 responses), network errors, and abnormal closes using a single exponential-backoff timer.


## Host system information

The agent reports the host operating system, OS version and processor architecture to SensorSphere. Docker Compose mounts `/etc/os-release` read-only at `/host/etc/os-release` so the reported OS is the host OS rather than the container image.


## Proxmox VE and Backup Server discovery

The optional `PROXMOX` provider discovers Proxmox VE inventory and Proxmox Backup Server instances from the Device Agent network location. It is enabled when `PROXMOX_ENDPOINTS_JSON` contains at least one PVE or PBS endpoint, so SensorSphere does not need direct connectivity to remote Proxmox networks.

Configure one or more endpoints in the Device Agent `.env` as a single JSON array. Each `id` is a stable technical scope used to build provider identities and should remain unchanged after devices are imported. Use `product: "PVE"` (default) for port 8006 endpoints. A PVE endpoint automatically inspects its storage configuration and reports any referenced Proxmox Backup Server, so a separate PBS endpoint is not required for basic PBS discovery. An explicit `product: "PBS"` endpoint on port 8007 remains optional when authenticated PBS enrichment (version, node status and uptime) is desired. API token secrets stay local to the Device Agent and are never advertised as provider capabilities or returned in discovery results.

```sh
PROXMOX_ENDPOINTS_JSON=[{"id":"home-pve","url":"https://pve-1.example.net:8006","tokenId":"sensorsphere@pve!discovery","tokenSecret":"replace_me","verifyTls":true}]
PROXMOX_REQUEST_TIMEOUT_MS=5000
```

TLS certificate verification is enabled by default. Set `verifyTls` to `false` only for an explicitly trusted endpoint using a certificate that cannot be verified by the Device Agent.

The provider reads the cluster-wide PVE resource inventory and reports:

- `PVE_NODE` with a stable id such as `home-pve:node:pve-1`
- `PVE_VM` with a stable id such as `home-pve:qemu:101`
- `PVE_LXC` with a stable id such as `home-pve:lxc:120`
- `PBS_SERVER` discovered automatically from PVE storage configuration with an id such as `home-pve:pbs:auto:pbs.example.net:8007`, or `home-pbs:pbs` for an explicit authenticated PBS endpoint

VM and LXC records include `parentProviderId` pointing to their PVE node. For each PVE endpoint the provider also reads `/storage`; entries of type `pbs` are converted into `PBS_SERVER` records without requiring PBS credentials. If the same server is also configured explicitly as a `PBS` endpoint, the explicit authenticated record wins and the PVE-derived record is suppressed. Explicit PBS endpoints use `PBSAPIToken` authentication. Proxmox Device Control actions remain outside the discovery provider.


## Supervisor Agent integration

Device Agent 1.3.0 can relay typed update requests from SensorSphere to a local `sensorsphere-supervisor-agent` over a Unix socket. The Device Agent never receives Docker daemon access.

By default the shared socket is `/run/sensorsphere-supervisor-agent/supervisor.sock`. When the socket is available, the Device Agent reports `agentUpdate.supported=true` and a `supervisor` object in its `HELLO`, including the Supervisor version, container state, self-update support, and current self-update status. For `AGENT_UPDATE_REQUEST`, the agent sends an `ACCEPTED` result before forwarding the request because a successful Device Agent update normally recreates the Device Agent container; SensorSphere verifies completion from the version in the next `HELLO`.

For `SUPERVISOR_UPDATE_REQUEST`, the Device Agent relays `UPDATE_SELF` to Supervisor Agent 0.3.0 or newer, polls `GET_SELF_STATUS` while the Supervisor is recreated, and returns `SUPERVISOR_UPDATE_RESULT=SUCCESS` only after the target Supervisor version is running. The Device Agent never receives Docker daemon access.
