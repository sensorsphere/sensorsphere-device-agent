#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${REPOSITORY:-sensorsphere/sensorsphere-device-agent}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com}"
VERSION="${VERSION:-latest}"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/sensorsphere-device-agent}"
IMAGE="${DEVICE_AGENT_IMAGE:-ghcr.io/sensorsphere/sensorsphere-device-agent}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for command_name in curl docker mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

if [[ "$VERSION" == "latest" ]]; then
  SOURCE_REF="master"
  IMAGE_TAG="latest"
elif [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  SOURCE_REF="v${VERSION}"
  IMAGE_TAG="$VERSION"
else
  fail "VERSION must be 'latest' or a semantic version such as 1.0.1"
fi

PREEXISTING_INSTALL=false
if [[ -d "$INSTALL_DIR" ]]; then
  if [[ -f "$INSTALL_DIR/.env" || -f "$INSTALL_DIR/docker-compose.yml" || -d "$INSTALL_DIR/data" ]]; then
    PREEXISTING_INSTALL=true
  fi
fi

ensure_install_dir() {
  if mkdir -p "$INSTALL_DIR/data" 2>/dev/null; then
    return
  fi

  command -v sudo >/dev/null 2>&1 || fail "Cannot create $INSTALL_DIR and sudo is unavailable"
  sudo mkdir -p "$INSTALL_DIR/data"
  sudo chown -R "$(id -u):$(id -g)" "$INSTALL_DIR"
}

ensure_install_dir

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

printf 'Installing SensorSphere Device Agent\n'
printf '  version:      %s\n' "$VERSION"
printf '  source ref:   %s\n' "$SOURCE_REF"
printf '  install dir:  %s\n' "$INSTALL_DIR"
printf '  image:        %s:%s\n' "$IMAGE" "$IMAGE_TAG"

curl -fsSL \
  "${RAW_BASE_URL}/${REPOSITORY}/${SOURCE_REF}/docker-compose.yml" \
  -o "$TMP_DIR/docker-compose.yml"

curl -fsSL \
  "${RAW_BASE_URL}/${REPOSITORY}/${SOURCE_REF}/.env.example" \
  -o "$TMP_DIR/.env.example"

cp "$TMP_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
cp "$TMP_DIR/.env.example" "$INSTALL_DIR/.env.example"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  if [[ "$PREEXISTING_INSTALL" == "true" ]]; then
    fail "Existing installation detected but $INSTALL_DIR/.env is missing. Refusing to create a replacement .env automatically."
  fi

  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

  INSTALL_PUID="${PUID:-$(id -u)}"
  INSTALL_PGID="${PGID:-$(id -g)}"

  {
    printf '\n# Runtime UID/GID selected by scripts/install.sh\n'
    printf 'PUID=%s\n' "$INSTALL_PUID"
    printf 'PGID=%s\n' "$INSTALL_PGID"
  } >> "$INSTALL_DIR/.env"

  printf 'Created new %s/.env from .env.example with PUID=%s PGID=%s\n' \
    "$INSTALL_DIR" "$INSTALL_PUID" "$INSTALL_PGID"
else
  ENV_BACKUP="$INSTALL_DIR/.env.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$INSTALL_DIR/.env" "$ENV_BACKUP"
  printf 'Preserving existing %s/.env\n' "$INSTALL_DIR"
  printf 'Backup created: %s\n' "$ENV_BACKUP"

  SENSORSPHERE_URL_BEFORE="$(sed -n 's/^SENSORSPHERE_URL=//p' "$INSTALL_DIR/.env" | tail -1)"
  SENSORSPHERE_TOKEN_BEFORE="$(sed -n 's/^SENSORSPHERE_DEVICE_AGENT_TOKEN=//p' "$INSTALL_DIR/.env" | tail -1)"

  if ! grep -q '^PUID=' "$INSTALL_DIR/.env"; then
    printf '\nPUID=%s\n' "${PUID:-$(id -u)}" >> "$INSTALL_DIR/.env"
  fi

  if ! grep -q '^PGID=' "$INSTALL_DIR/.env"; then
    printf 'PGID=%s\n' "${PGID:-$(id -g)}" >> "$INSTALL_DIR/.env"
  fi
fi

IMAGE_VALUE="${IMAGE}:${IMAGE_TAG}"

if grep -q '^DEVICE_AGENT_IMAGE=' "$INSTALL_DIR/.env"; then
  sed -i "s|^DEVICE_AGENT_IMAGE=.*|DEVICE_AGENT_IMAGE=${IMAGE_VALUE}|" "$INSTALL_DIR/.env"
else
  printf '\n# Image version selected by scripts/install.sh\nDEVICE_AGENT_IMAGE=%s\n' \
    "$IMAGE_VALUE" >> "$INSTALL_DIR/.env"
fi

if [[ -n "${ENV_BACKUP:-}" ]]; then
  SENSORSPHERE_URL_AFTER="$(sed -n 's/^SENSORSPHERE_URL=//p' "$INSTALL_DIR/.env" | tail -1)"
  SENSORSPHERE_TOKEN_AFTER="$(sed -n 's/^SENSORSPHERE_DEVICE_AGENT_TOKEN=//p' "$INSTALL_DIR/.env" | tail -1)"

  if [[ "$SENSORSPHERE_URL_AFTER" != "$SENSORSPHERE_URL_BEFORE" || "$SENSORSPHERE_TOKEN_AFTER" != "$SENSORSPHERE_TOKEN_BEFORE" ]]; then
    cp -p "$ENV_BACKUP" "$INSTALL_DIR/.env"
    fail "Protected SensorSphere settings changed unexpectedly. Original .env restored from backup."
  fi
fi

INSTALL_PUID="$(grep '^PUID=' "$INSTALL_DIR/.env" | tail -1 | cut -d= -f2-)"
INSTALL_PGID="$(grep '^PGID=' "$INSTALL_DIR/.env" | tail -1 | cut -d= -f2-)"

PUID="$INSTALL_PUID" \
PGID="$INSTALL_PGID" \
DEVICE_AGENT_IMAGE="$IMAGE_VALUE" \
  docker compose \
    --env-file "$INSTALL_DIR/.env" \
    -f "$INSTALL_DIR/docker-compose.yml" \
    config -q

read_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$INSTALL_DIR/.env" | tail -1
}

SENSORSPHERE_URL_VALUE="$(read_env_value SENSORSPHERE_URL)"
SENSORSPHERE_TOKEN_VALUE="$(read_env_value SENSORSPHERE_DEVICE_AGENT_TOKEN)"

CONFIGURED=true
if [[ -z "$SENSORSPHERE_URL_VALUE" || "$SENSORSPHERE_URL_VALUE" == "http://my_sensorsphere_base_url:8080" ]]; then
  CONFIGURED=false
fi
if [[ -z "$SENSORSPHERE_TOKEN_VALUE" || "$SENSORSPHERE_TOKEN_VALUE" == "ssda_replace_me" ]]; then
  CONFIGURED=false
fi

if [[ "$CONFIGURED" == "true" ]]; then
  printf '\nUpdating SensorSphere Device Agent container...\n'
  (
    cd "$INSTALL_DIR"
    docker compose --env-file .env pull
    docker compose --env-file .env up -d
  )

  cat <<EOF2

SensorSphere Device Agent is running.
  image: ${IMAGE_VALUE}

Check status with:
  cd ${INSTALL_DIR}
  docker compose --env-file .env ps

Follow logs with:
  docker compose --env-file .env logs -f device-agent

EOF2
else
  cat <<EOF2

Installation files are ready.

Edit the required SensorSphere settings:
  ${INSTALL_DIR}/.env

At minimum configure:
  SENSORSPHERE_URL
  SENSORSPHERE_DEVICE_AGENT_TOKEN

Optional identification:
  AGENT_NAME
  AGENT_LABELS

Then rerun the installer to pull and start the selected image, or start manually with:
  cd ${INSTALL_DIR}
  docker compose --env-file .env pull
  docker compose --env-file .env up -d

EOF2
fi
