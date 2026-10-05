# Icons

bzo uses two distinct icon marks, on two distinct channels. Both are green:
BZFlag's own marks are red and its forums are blue, so the colour is what tells
a bzo icon from a BZFlag one at a glance.

## Browser mark — the simple tank

`public/favicon.svg` and `public/favicon.ico` carry a plain top-down tank drawn
in a 32-unit box: two grey treads, a green hull, a round turret and a barrel. It
stays legible at 16 px, which is what a browser tab, a bookmark and a history
entry need. Browsers pick these up through `<link rel="icon">`.

`favicon.ico` holds 16×16, 32×32 and 48×48 entries and exists for the implicit
`GET /favicon.ico` that clients issue when they ignore the link tags.

## Installed-app mark — the BZFlag icon

`public/icons/` carries the application icon: an octagon with a green-to-white
gradient behind a dark top-down tank. Only the web app manifest references
these, so they appear on a launcher, a home screen or a headset app library, and
never in a browser tab. Nothing but icons lives in that directory, so the files
are named for the manifest role they fill and carry no prefix.

| File | Purpose |
|---|---|
| `any-1024.png` | master |
| `any-512.png`, `any-192.png` | manifest `purpose: "any"` |
| `maskable-512.png`, `maskable-192.png` | manifest `purpose: "maskable"`, everywhere but a headset |
| `tile-1024.png`, `tile-512.png`, `tile-192.png` | every manifest entry a headset browser is served |
| `apple-touch-icon-180.png` | iOS home screen |

### Provenance

The master derives from the `ic10` (1024×1024) entry of `Xcode/BZFlag.icns` in
the [BZFlag](https://github.com/BZFlag-Dev/bzflag) source tree, which is the
highest-resolution copy upstream ships — `MSVC/bzflag.ico` stops at 256×256. The
vector original is `misc/art/bzicon-red.svg`. The artwork is rotated 120° round
the colour wheel, which carries upstream's red to green and leaves everything
else, the greys and the white highlight included, where it was. Artwork is from
the BZFlag project and used here under its license.

### Why the maskable pair is padded

Android composites `purpose: "maskable"` icons under an OEM-chosen shape and
guarantees only a centred circle of 80% diameter. The BZFlag octagon's flat
edges run to all four borders of the canvas, so cropping it unmodified shears
off the flats. The maskable files scale the art to 72% and centre it on opaque
`#000000`, matching the manifest's `background_color`, so the whole octagon
survives any mask.

### Why a headset gets a different set entirely

The Meta Quest app library does not composite. It letterboxes whichever icon it
picks into roughly 75% of the tile, fills the rest, and draws a shadow under the
result -- so padding inside the file is padding the launcher then pads again,
and any corner the artwork does not cover reads as part of the mark. The padded
pair lands there at about half the tile inside a black ring; corners filled
white instead draw a white one; art enlarged past the octagon's corners fills
the tile but loses the silhouette a phone still needs.

The two demands are opposite and the manifest has one slot for them, so the
manifest -- already generated per request, to name the app after its host --
branches on the user agent. `server/headset.cjs` decides, sharing its
patterns with the client copy the XR controls use, and the response carries
`Vary: User-Agent` so a shared cache cannot hand one device the other's icons.
A headset is served `tile-*.png` for every entry, whatever `purpose`
says, because which one a launcher reads is not documented and not worth
guessing; everything else is served the pair above.

The tile files are the mark at full size with the octagon's cut corners filled
white, which is the colour the launcher fills around them. Nothing a manifest
can say removes the frame itself; only a packaged app, whose Android adaptive
icon the launcher composites, fills a headset tile the way a native app does.

`server.log` records both halves of an install as `[INSTALL]` lines -- the
manifest fetch with the browser that asked, then the icon it settled on -- which
is the only way to see what a launcher actually took.

A launcher captures the icon when the app is installed, so testing any of this
means installing again -- and means the icon a browser has already cached is the
one it will hand the launcher. Icons are served `no-cache` and the manifest
appends each file's timestamp to its URL for that reason; nothing else in
`public/` needs either.

iOS applies its own rounded-rectangle mask and renders transparency as black, so
`apple-touch-icon-180.png` is pre-flattened onto black and left square.

### Regenerating

The PNGs are committed as source; there is no build step and no image
dependency. To rebuild them, extract `ic10` from `BZFlag.icns`, rotate its hue
120° to make `any-1024.png`, and derive the rest from that with a Lanczos
downscale: the 72% inset on black for the maskable pair, a composite onto white
for the tile set, and a composite onto black for the iOS icon.
