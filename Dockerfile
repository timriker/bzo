# Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
# Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
# Source: https://github.com/timriker/bzo
# See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html

# Node is Ubuntu's own `nodejs`, the one a server running bzo from source on
# Ubuntu 26.04 already has. npm comes along only in this stage, to install the
# dependencies; the image itself carries Node alone.
FROM ubuntu:26.04 AS deps

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs npm \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

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

ARG APP_UID=1000
ARG APP_GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules

COPY public ./public
COPY maps ./maps
COPY replays ./replays
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

EXPOSE 3000 5153/udp 5154/tcp 5154/udp
VOLUME ["/data"]

CMD ["node", "server.js"]
