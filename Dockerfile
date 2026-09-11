# Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
# Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
# Source: https://github.com/timriker/bzo
# See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html

FROM ubuntu:26.04

# PORT and LISTEN are deliberately absent. Both are read from the environment
# first and `server.json` second, so setting either here would make the matching
# key in the operator's mounted `/data/server.json` permanently inert -- and
# that file is exactly where someone would go to change it. Unset, the defaults
# are port 3000 on every interface, which is what a container needs anyway, and
# `docker run -e PORT=... -e LISTEN=...` still overrides the file.
ENV NODE_ENV=production \
  SERVER_CONFIG_PATH=/data/server.json \
    DEBIAN_FRONTEND=noninteractive

ARG NODE_VERSION=24.19.0
ARG NODE_SHA256_AMD64=f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4
ARG NODE_SHA256_ARM64=d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f
ARG APP_UID=1000
ARG APP_GID=1000

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl libstdc++6; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch="x64"; node_checksum="$NODE_SHA256_AMD64" ;; \
      arm64) node_arch="arm64"; node_checksum="$NODE_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz"; \
    curl --fail --silent --show-error --location --retry 3 \
      --output "/tmp/${node_archive}" \
      "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"; \
    echo "${node_checksum}  /tmp/${node_archive}" | sha256sum --check --strict; \
    tar --extract --gzip --file "/tmp/${node_archive}" \
      --strip-components=1 --directory /usr/local; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    rm -f "/tmp/${node_archive}"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY public ./public
COPY maps ./maps
COPY server ./server
COPY example-server.json ./example-server.json
COPY server.js ./server.js
COPY LICENSE ./LICENSE
COPY README.md ./README.md
COPY CHANGELOG.md ./CHANGELOG.md

# Build the brotli sidecars into the image. The server builds any that are
# missing at boot, so this is not required -- but doing it here means a
# container needs nothing writable at runtime and the first player to arrive
# never waits for the compression. The directory is created and handed over
# either way, so a container that does have to build them can.
RUN node server/precompress.cjs

RUN mkdir -p /data /app/cache/br && chown -R "$APP_UID:$APP_GID" /app /data

USER ${APP_UID}:${APP_GID}

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
