# Battlezone Online

Battlezone Online is a real-time multiplayer tank game built with Node.js, WebSockets, and Three.js.

## Try it

Two public test servers, both usually up:

- <https://bz.rikers.org> — development, running whatever is current
- <https://orin-bzo.rikers.org> — the `linux/arm64` Docker image, updated nightly

Neither is a stable deployment, so expect either to be restarting or ahead of the
latest release.

## What users can install

There are two supported ways to run the game:

1. Docker image from GitHub Container Registry
2. Source release tarball or git checkout

For most users, Docker is the best install and update path.

## Release contents

Each tagged release publishes:

- a GitHub release with notes generated from [CHANGELOG.md](CHANGELOG.md)
- a source tarball
- a versioned Ubuntu 26.04 image at `ghcr.io/timriker/bzo:<version>-ubuntu26.04`
- a moving `ubuntu26.04` tag
- `ghcr.io/timriker/bzo:<version>` and `ghcr.io/timriker/bzo:latest`, both using Ubuntu 26.04

Every published image contains `linux/amd64` and `linux/arm64` variants. Release
tags use stable `vX.Y.Z` SemVer only; prerelease and build-metadata tags are not
published. Ubuntu 26.04 images use the pinned Node.js `24.19.0` runtime.

Docker images are built on Ubuntu 26.04 with pinned Node.js `24.19.0`.
Runtime compatibility is validated in CI on Node.js `18.19.1` and `24.19.0`.

## Install with Docker

### Quick start with docker compose

Use [compose.yml](compose.yml):

```bash
docker compose up -d
```

This starts the server on port 3000 and stores runtime config in `./data/server.json`.

On first start, the server copies [example-server.json](example-server.json) to the configured runtime path if no config exists.

Naming update: this project now uses `compose.yml`, `server.json`, and
`example-server.json` only.

Then open:

- `http://localhost:3000`

The image is multi-arch (`linux/amd64` and `linux/arm64`), so Docker will pull the
correct variant for your host by default.

If you need to force an architecture, set `platform` in compose:

```yaml
services:
  bzo:
    image: ghcr.io/timriker/bzo:latest
    platform: linux/amd64 # or linux/arm64
    volumes:
      - ./data:/data
```

### Direct docker run

```bash
docker run -d \
  --name bzo \
  -p 3000:3000 \
  -v bzo-data:/data \
  ghcr.io/timriker/bzo:latest
```

The image defaults to `SERVER_CONFIG_PATH=/data/server.json`.

To force a specific architecture when running directly:

```bash
docker run -d \
  --name bzo \
  --platform linux/amd64 \
  -p 3000:3000 \
  -v bzo-data:/data \
  ghcr.io/timriker/bzo:latest
```

Use `--platform linux/arm64` on ARM hosts if you want to pin that explicitly.

### Docker data persistence

- Persist server settings and runtime config by mounting `/data` (already done in
  `compose.yml`).
- `SERVER_CONFIG_PATH` defaults to `/data/server.json`.
- The container runs as UID/GID `1000:1000`; for bind mounts, ensure the host
  `./data` directory is writable by that user (for example `chown -R 1000:1000 ./data`).

### Persisting custom maps (optional)

Built-in maps ship inside the image at `/app/maps`.

Runtime map uploads and operator-managed custom maps are stored in a writable
runtime maps directory that defaults to `$(dirname $SERVER_CONFIG_PATH)/maps`.
With the default Docker settings, this is `/data/maps`, which is already
persisted by the existing `./data:/data` volume.

No extra volume is required for operator uploads to persist across restarts.

If you want to override the runtime map directory, set `MAPS_PATH`:

```yaml
services:
  bzo:
    image: ghcr.io/timriker/bzo:latest
    environment:
      SERVER_CONFIG_PATH: /data/server.json
      MAPS_PATH: /data/maps
    volumes:
      - ./data:/data
```

You can still provide static read-only maps in the image path, but uploaded maps
should go to the runtime directory.

## Install from source

### Prerequisites

- Node.js 18.19.1 or Node.js 24.19.0
- npm

### Setup

```bash
npm install
```

If `server.json` does not exist, the server will create it from [example-server.json](example-server.json) on first start.

### Run

Production:

```bash
npm start
```

Development:

```bash
npm run dev
```

Then open:

- `http://localhost:3000`

## Configuration

Runtime configuration lives in `server.json` by default.

You can override the path with:

```bash
SERVER_CONFIG_PATH=/path/to/server.json npm start
```

See [example-server.json](example-server.json) for the supported shape.

## Flags

bzo carries every flag BZFlag has except one. `WA` Wide Angle is **not
implemented and will not be**: it widens the field of view, which is one camera
value on a flat screen but belongs to the headset runtime in VR, where the
runtime sets it from the device's optics and a client that overrode it would
either be ignored or make people ill. A flag that is a real penalty in a browser
and does nothing in VR is worse than an absent one, because it looks like it
works and the player cannot tell. No acceptable XR answer was found, and keeping
VR honest matters more than carrying the flag.

So on a bzo server:

- **`WA` is never spawned.** It is not in the pool a superflag slot draws from.
- **A `zoneflag WA` in a map is ignored.** The zone keeps everything else it
  declares, the `WA` count is dropped, and the skipped type is named once in the
  server log at load, so a map written for BZFlag loads and plays with nothing
  silently lost.
- **The in-game help does not list it.**

Everything else is there: the four team flags and forty-one superflags. See
[docs/flags.md](docs/flags.md) for how the flag system works and where bzo's
flags deliberately differ from BZFlag's.

## Updating

### Source installs

There is no built-in self-update path for source installs.

To update, download a newer release or pull newer source, then run:

```bash
npm install
```

### Docker installs

Docker is the recommended update path.

Manual update:

```bash
docker compose pull
docker compose up -d
```

or:

```bash
docker pull ghcr.io/timriker/bzo:latest
```

If you want automatic container updates, use your preferred container update manager. That is not built into the game itself.

## Changelog and release notes

- Human-readable history is kept in [CHANGELOG.md](CHANGELOG.md)
- Tagged GitHub releases use the matching changelog section as release notes

## Controls

- `W` / `S` or `Up` / `Down` — move forward/backward
- `A` / `D` or `Left` / `Right` — turn left/right
- `Enter` — shoot
- `Tab` — jump
- `Space` — drop flag
- `Q` — self-destruct
- `P` — pause/resume
- `N` — open chat (or click the `Send` button)
- `Enter` — send chat (while chat input is focused, or click `Send` again)
- `Esc` — exit chat input or leave mouse steering
- `1` / `2` / `3` / `4` / `5` — switch chat tab (`All` / `Chat` / `Server` / `Misc` / `Debug`)
- `[` / `]` — previous/next chat tab
- `.` — reply to last direct-message sender
- `,` — message nemesis target
- `Page Up` / `Page Down` — scroll chat history
- `End` — jump chat to newest message
- `M` — toggle mouse steering
- `C` — cycle camera mode
- `O` — toggle operator panel
- `F` — toggle fullscreen
- `` ` `` — toggle debug HUD
- `=` or `+` or `Numpad +` — zoom radar out (increase range)
- `-` or `Numpad -` — zoom radar in (decrease range)
- `\` — reset radar zoom to the default medium range (0.5x shot-distance)
- `Settings -> Radar: ...` — cycle Short/Medium/Long radar presets
- `B` — toggle the voice microphone
- `Settings -> Audio Settings` — set the game, voice, and microphone levels, and choose the voice channel: All, Nearby, or Team
- `/` or `?` — show/hide help panel

- `I` or right-click — identify the tank in your sights, and lock a Guided
  Missile onto it. On the on-screen controls it is the `◎` button, in VR either
  thumbstick press, and on a gamepad either shoulder

### Mouse steering

`M` turns it on and off, and nothing else does: the keys never take it away
behind your back. With it on, the mouse sits in the targeting box and both
surfaces drive at once -- hold a drive key and it owns that axis, let go and the
mouse has it back -- so you can steer with the mouse while holding `W`, or turn
with `A`/`D` while the mouse sets the speed.

Left click shoots wherever the cursor is, whether mouse steering is on or not,
unless the click lands on the chat panel or a button. The setting is unavailable
with no mouse attached, in VR, and while the on-screen controls are up, since
those steer instead; a click that misses one of their buttons does nothing
rather than firing.

### Observer

As an Observer you have no tank. Drive and turn fly the camera instead, `Tab`
climbs and `Space` descends, and the camera rests at the eye height of a tank on
the ground. Pausing and self-destruct do nothing.

- `Enter` or `C` — step through everything: in each view, the leader first, then
  every player, then on to the next view. The views are Free, Track, Follow,
  Driving with, and Flag where a map has team flags
- `I` or right-click — in the Free view, watch the tank in your sights
- Click a scoreboard row to watch that player; click the marked row again to go
  back to following the leader

## WebXR

The VR mode uses native WebXR and requires a browser and headset that support
`immersive-vr`. For local validation, open the game at `http://localhost:3000`.
For remote access, terminate TLS at the reverse proxy and open the game over
`https://`; the client automatically uses `wss://` for its WebSocket connection
when the page is served over HTTPS.

A headset browser launching the installed app tries to enter VR with no 2D
landing page. `xr-launch.js` asks for the session before the rest of the client
loads, and keeps asking on each signal that could carry the user activation an
immersive session needs -- window load, focus, page show, visibility change, and
the Launch Handler -- with the renderer picking up whichever session results.
Where none of them lands, and everywhere else, VR Mode starts from the button.

A saved name joins immediately, and without one the XR menu opens on a Join
screen carrying the same name, team, and tank choices as the 2D entry dialog, so
nothing waits on a screen the player cannot see.

Typing in XR uses the headset's own system keyboard, raised when the Name or
MOTD row takes focus. Quest Browser 26.1 and later provide one; a headset that
does not marks those rows Desktop only, and the player can still join under the
name the server assigns. Each time the keyboard opens it starts a fresh edit, so
the first key replaces the whole field rather than appending to it.

The one-tap VR button beside the settings gear is shown only on a device with a
headset, because Chrome on Android reports `immersive-vr` support on any phone
through Cardboard; VR Mode stays in the Settings menu there.

If the deployment sets a restrictive `Permissions-Policy` header, allow
`xr-spatial-tracking=(self)`. The Node.js server does not terminate TLS itself,
so HTTPS and the corresponding WebSocket proxy configuration are deployment
responsibilities.

Apache's `mod_proxy` sends `X-Forwarded-For`, `X-Forwarded-Host` and
`X-Forwarded-Server` on its own, but **not** `X-Forwarded-Proto` or
`X-Forwarded-Port`. Add them in the HTTPS vhost, with `mod_headers` enabled, or
the server logs every connection as plain HTTP:

```apache
RequestHeader set X-Forwarded-Proto "https"
RequestHeader set X-Forwarded-Port  "443"
# mod_proxy appends to X-Forwarded-For, so pin it to the real peer rather than
# letting a client prepend an address of its choosing.
RequestHeader set X-Forwarded-For   "expr=%{REMOTE_ADDR}"
```

`set` rather than `add`, so a header a client sent cannot survive the hop.

Use the [WebXR validation checklist](docs/webxr-validation.md) when checking a
new browser, headset, or deployment. WebGPU rendering is outside the scope of
this checklist.

## Development checks

```bash
npm run check
```

This runs syntax and lint checks.

CI also runs these checks on pushes and pull requests.

## Release process

Prepare a release locally:

```bash
npm run release:prepare -- 1.0.1
```

That updates:

- `package.json`
- `package-lock.json`
- `CHANGELOG.md`

Then edit the new changelog section so it contains the real user-visible changes.

Validate locally:

```bash
npm run check
npm run release:check -- v1.0.1
npm run release:check:increment -- v1.0.1
```

Then commit, tag, and push:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release v1.0.1"
git tag v1.0.1
git push
git push origin v1.0.1
```

The release workflow will:

1. verify that the stable tag is newer than the previous release and points to `main`
2. install dependencies and run lint, validation, audit, and CodeQL checks
3. fail if `package.json` does not match the pushed tag
4. fail if [CHANGELOG.md](CHANGELOG.md) does not contain a matching non-placeholder section
5. build and smoke-test Ubuntu 26.04 images with pinned Node.js `24.19.0` for `linux/amd64` and `linux/arm64`
6. promote the verified versioned and moving Docker tags to GHCR
7. publish a GitHub release and attach a source tarball

## AGPL source availability

This project is licensed under the GNU Affero General Public License v3.0.

Network users can access the source code from the running app via `/source`, or directly at:

- <https://github.com/timriker/bzo>
