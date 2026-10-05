# Battlezone Online

Battlezone Online is a real-time multiplayer tank game built with Node.js,
WebSockets, and Three.js.

## Try it

<https://bz.rikers.org/list> lists the public bzo servers, and the BZFlag
servers any of them proxies. Click a row to enter that game.

## Release contents

Each tagged release publishes:

- a GitHub release with notes generated from [CHANGELOG.md](CHANGELOG.md)
- a source tarball
- a versioned Ubuntu 26.04 image at `ghcr.io/timriker/bzo:<version>-ubuntu26.04`
- a moving `ubuntu26.04` tag
- `ghcr.io/timriker/bzo:<version>` and `ghcr.io/timriker/bzo:latest`, both
  using Ubuntu 26.04

Every published image contains `linux/amd64` and `linux/arm64` variants. Release
tags use stable `vX.Y.Z` SemVer only; prerelease and build-metadata tags are not
published. Ubuntu 26.04 images use the pinned Node.js `24.19.0` runtime.

Docker images are built on Ubuntu 26.04 with pinned Node.js `24.19.0`, and CI
runs on Ubuntu 26.04 with the same Node.

## Install and run a server

A Docker image from GitHub Container Registry, or a source tarball or git
checkout. Docker is the better install and update path for most people.

[docs/installation.md](docs/installation.md) covers both, plus configuration,
running behind a reverse proxy, listing your server, proxying BZFlag servers,
and updating.

`/list`'s **Launch** links open a BZFlag server in an installed BZFlag client;
[docs/bzflag-links.md](docs/bzflag-links.md) sets up `bzflag://` on Linux,
Windows and macOS.

## Flags

bzo carries every flag BZFlag has. `WA` Wide Angle spawns, sticks and shakes off
like any bad flag, but does nothing: it widens the field of view, and in VR the
headset owns the projection.

[docs/flags.md](docs/flags.md) has the rest, including why.

## Changelog and release notes

- Human-readable history is kept in [CHANGELOG.md](CHANGELOG.md)
- Tagged GitHub releases use the matching changelog section as release notes

## Controls

[docs/controls.md](docs/controls.md) has every control: the keyboard and
mouse, the on-screen touch controls, gamepads, and the XR controllers. In the
game, `/` or `?` shows the keyboard's.

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
responsibilities -- see
[docs/installation.md](docs/installation.md#behind-a-reverse-proxy).

Use the [WebXR validation checklist](docs/webxr-validation.md) when checking a
new browser, headset, or deployment. WebGPU rendering is outside the scope of
this checklist.

## Development checks

```bash
npm run check
```

This runs the syntax and lint checks, a server boot check, and the test
suites.

CI also runs these checks on pushes and pull requests.

## Release process

Commit everything first, and leave nothing behind: a tag names a tree, so an
edit still sitting in the working directory when the tag goes out is not in the
release -- the version says one thing and the box says another, and nobody can
reproduce it from the tag. That includes work somebody else left uncommitted:
review it, say what it is, and commit it, rather than tagging around it. `git
status` is clean before preparing a release and clean again once the tag is
pushed; anything still pending at the end means the release went out without it.

Release tags are stable `vX.Y.Z` SemVer only -- prereleases and build metadata
are not published.

Prepare a release locally:

```bash
npm run release:prepare -- 1.0.1
```

That updates:

- `package.json`
- `package-lock.json`
- `public/version.mjs`
- `CHANGELOG.md`

All four go in the release commit. `public/version.mjs` is the one easy to
leave behind, and a tag without it ships a client reporting the version before
it.

Then edit the new changelog section so it contains the real user-visible changes.

Validate locally:

```bash
npm run check
npm run release:check -- v1.0.1
npm run release:check:increment -- v1.0.1
```

Then commit, tag, and push:

```bash
git add package.json package-lock.json public/version.mjs CHANGELOG.md
git commit -m "Release v1.0.1 - short description. Closes #1"
git tag v1.0.1
git push
git push origin v1.0.1
```

The subject describes the release rather than labelling it: the version is
already in the tag, `package.json` and `CHANGELOG.md`, and `git log --oneline`
is the one view where the subject is all there is. Name the change in a few
words and reference the issue with a real closing keyword where the release
finishes it, since a bare `(#NN)` only links.

The release workflow will:

1. verify that the stable tag is newer than the previous release and points to `main`
2. install dependencies and run lint, validation, audit, and CodeQL checks
3. fail if `package.json` does not match the pushed tag
4. fail if [CHANGELOG.md](CHANGELOG.md) does not contain a matching
   non-placeholder section
5. build and smoke-test Ubuntu 26.04 images with pinned Node.js `24.19.0` for
   `linux/amd64` and `linux/arm64`
6. promote the verified versioned and moving Docker tags to GHCR
7. publish a GitHub release and attach a source tarball

**A release that fails its workflow is left alone.** bzo is in development and
not every tag produces artifacts. Fix the cause and move to the next version --
do not delete or move a published tag, and do not backfill a GitHub release for
one that never built. [CHANGELOG.md](CHANGELOG.md) is the record either way, and
it already carries the section for the version that failed.

`public/version.mjs` is written by `scripts/prepare-release.mjs` and verified
against the tag by `scripts/check-release.mjs`. Do not edit it by hand, and do
not reintroduce a hardcoded client version string elsewhere.

## Bundled assets and licensing

The code is AGPLv3. The assets are not all the same story.

bzo ships models, textures, sounds and maps from several places: some are the
BZFlag project's, used under its licence; some were made for bzo; some arrived
with a contribution. A file does not inherit the repository's licence by
sitting in it, and an asset whose origin nobody recorded is a question left for
whoever asks next.

What is expected of anything added here:

- say where it came from, and under what terms, in the pull request
- prefer terms compatible with AGPLv3 distribution
- a header saying a file was exported by some tool is not a grant of anything,
  and neither is a note that the author did not look into it

Not every asset already in the tree meets that bar. Some predate the
expectation and some arrived with a contribution that was worth taking on its
own merits, and the intent is to reach clear, recorded licensing for every one
of them rather than to pretend it is already done. If you know the provenance
of something here, or you are the author of it, please say so in an issue --
that is the cheapest way this gets finished.

Maps are the same question in a different shape: a map downloaded from a
server, or saved out by a client, carries no grant with it. See
[docs/bzw.md](docs/bzw.md) for the map format itself.

## AGPL source availability

This project is licensed under the GNU Affero General Public License v3.0.

Network users can access the source code from the running app via `/source`, or
directly at:

- <https://github.com/timriker/bzo>
