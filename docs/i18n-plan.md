# Internationalization Plan

Issue: #44, open. Overlaps #64 (help subsystem), which cannot be designed
separately -- see "Help Is Documents" below. HUD text sizing came out of this
and is #113.

## Goal

Play bzo in the player's own language, chosen from their browser's
`Accept-Language` header with no setup, overridable in Settings, and translated
from the same gettext catalogs BZFlag already ships.

## What Upstream Does

- Catalogs are gettext `.po` files in `data/l10n/`, one per locale, 16 of them
  including `en_US_l33t`, `en_US_redneck`, and the `xx` untranslated template.
- `BundleMgr::getBundle()` loads one catalog per locale with parent fallback
  (`de_DE` then `de` then default). `Bundle::getLocalString()` looks a string up.
- Locale comes from the BZDB `locale` key, set by the Options menu or `-locale`.
- Coverage is mostly implicit: 22 explicit call sites, plus `HUDuiLabel` and
  `HUDuiList` localizing their own text, so menus and HUD labels are translated
  and nothing else is. Server chat is never translated.
- Completeness is uneven (sk 1010 msgids, ru 986, es 936, fr 357, lt 95) and the
  catalogs have gone largely untouched for years.

## Where bzo Diverges

- No gettext runtime. The `.po` files stay the authoring format so upstream's
  translations import directly, but the server parses them at startup and the
  client is handed plain JSON. bzo has no build step, and adding one for
  catalogs would be the only one in the tree.
- The locale is negotiated server-side from `Accept-Language` instead of read
  from a config key. The browser already states its preference on every request;
  a first-run player should not have to find a menu.
- Flag names and descriptions are localized. Upstream's catalogs already carry
  them ("Rapid Fire" is translated in every locale), and in bzo they are client
  data in `public/flags.mjs` rather than strings from the server.

## Locale Negotiation

Precedence, highest first:

1. The player's stored choice (`localStorage` key `locale`), when it is not
   `auto`. They picked it; nothing should second-guess that.
2. `?lang=` on the URL. Lets a share-view link carry a language and makes any
   locale testable from a browser that will not send the header.
3. `Accept-Language`, matched with `req.acceptsLanguages()` against the locales
   found at startup.
4. `en`.

The server resolves 2-4 while rendering `index.html`, which is already a
per-request template. Two more markers join `bzo-build`:

- `<html lang="en">` becomes the negotiated tag, so screen readers, spellcheck
  and CSS `:lang()` are right from the first byte.
- `<meta name="bzo-locale" content="...">` tells the client what it was served.

The catalog itself is inlined into the page as
`<script type="application/json" id="bzo-l10n">`. It is tens of kilobytes,
it saves a round trip, and it means no frame is ever painted in the wrong
language. `GET /l10n/<locale>.json` serves the same data for switching language
without a reload.

Two cache rules follow and are easy to miss:

- The index response must carry `Vary: Accept-Language` alongside its existing
  `Cache-Control: no-cache`, or a proxy will hand one player's German page to
  the next player. `Vary: User-Agent` is already set elsewhere for a similar
  reason.
- `sw.js` serves `/` network-first, so a negotiated page is normal. Only the
  offline fallback can be in a stale language. That is acceptable and should be
  left alone rather than papered over with a per-locale cache key.

## Catalogs

- Source: `l10n/bzo_<locale>.po`, plus `l10n/bzo.pot` as the template.
- Runtime: the server parses each `.po` at startup into `{ msgid: msgstr }`,
  mtime-checked the way `index.html` already is so editing a catalog under
  `npm run dev` takes effect on reload. Empty `msgstr` entries are dropped, so a
  missing translation falls back to the msgid.
- Locale list is whatever `l10n/` contains. Adding a language is adding a file.
- Parent fallback as upstream has it: `pt_BR` falls back to `pt`, then to the
  msgid.

## Keys

English source strings are the msgids, as upstream. `t('Rapid Fire')`, not
`t('flag.RF.name')`. A missing translation then degrades to readable English
instead of leaking a key into the HUD, and upstream's catalogs drop straight in.

Placeholders are named: `t('Team score limit: {n}', { n })`. Plural forms are
supported by the parser but avoided in the strings themselves -- upstream uses
none, and phrasing around them ("Shots: 3") is cheaper than carrying plural
rules for every locale.

## Tooling

The GNU gettext tools are already installed and do the whole authoring loop, so
no custom extractor is needed:

- `xgettext -L JavaScript --keyword=t` over `public/*.js` and `public/*.mjs`
  regenerates `l10n/bzo.pot`.
- `msgmerge` folds the new template into each existing catalog.
- `msgfmt -c` validates.

One import script, `scripts/l10n-import-bzflag.mjs`, seeds our catalogs from
`$BZFLAG/data/l10n/*.po` by matching msgids. Terminology should follow whatever
upstream already chose for a locale, so this runs before anyone translates
anything new. It is a one-time seeding tool, not a dependency, and po4a has no
part in it: upstream's catalogs are already `.po`, so importing them is msgid
matching and nothing more.

It seeds the UI catalog only, and the reason is worth writing down.

Upstream's in-client help is eight pages in `HelpMenu.cxx` -- Controls,
General, Environment, Flags, Good Flags, Bad Flags, Readouts I and II -- built
from `createLabel()` calls, so every line of it is a gettext string and much of
it is genuinely translated: 64 of the 96 long help strings have German. But
they are keyed by *hard-wrapped English line*:

```text
msgid "BZFlag is a multi-player networked tank battle game.  There are five teams:"
msgid "red, green, blue, purple, and rogues (rogue tanks are black).  Destroying a"
```

Those line breaks were chosen for English at a fixed width, and the German
lines do not reassemble into a German paragraph -- word order moved. There is
no honest automatic path from them into paragraph-keyed markdown. They are a
reference for a human translating our pages, side by side, and nothing more.

What does import one-to-one is everything short: flag names, team names, menu
verbs, control labels (`Fires Shot:`), readout labels. Those are the same
strings in both projects, and they are also most of what a player reads.

`scripts/test-i18n.mjs`, wired into `npm run check` as `check:i18n`:

- every `t()` msgid in the client exists in `l10n/bzo.pot`
- every catalog parses and its msgids are a subset of the template
- no untranslated text nodes remain in `public/index.html`

That last check is what keeps this from decaying the way upstream's catalogs
did: a new untagged string fails `npm run check` rather than quietly shipping.

## Client Runtime

`public/i18n.mjs` owns it: `t(msgid, params)`, `setLocale(locale)`, and one pass
over the DOM at boot for `data-i18n`, `data-i18n-title`, and
`data-i18n-placeholder` attributes in `index.html`. About 178 text nodes today,
but roughly half of them are the help panel and leave with #64.
`setLocale()` fetches `/l10n/<locale>.json`, re-runs the DOM pass, and repaints
the HUD; no reload.

Settings gains one row, matching upstream's Options menu:

```js
{ id: 'languageBtn', label: 'Language', kind: 'choice' }
```

cycling Automatic and the available locales, stored in `localStorage` under
`locale`. Automatic means "follow `Accept-Language`" and is the default.

## Where Each String Lives

The test is not length, it is ownership. A string that belongs to a widget is a
catalog entry, because it is edited with the widget and means nothing away from
it. A string that belongs to a page is a file. The audio dialog's captions are
whole sentences and are still catalog entries; a help paragraph of the same
length is not.

Counting the text nodes in `public/index.html` by dialog:

| Dialog | Nodes | Words | Home |
| --- | --- | --- | --- |
| `helpPanel` | 197 | 863 | files |
| `operatorOverlay` | 33 | 59 | catalog |
| `audioOverlay` | 29 | 104 | catalog |
| `settingsHud` | 21 | 32 | catalog |
| `entryDialog` | 13 | 18 | catalog |
| `viewOverlay` | 11 | 14 | catalog |
| everything else | 8 | 15 | catalog |

So about four fifths of the page's words leave with #64, and what remains
averages two words a node -- which is exactly the shape gettext handles well.

The operator panel is the clearest case for the catalog: 33 nodes, 59 words,
all of them labels (`Set MOTD:`, `Rabbit Chase:`, `No limit`) and choice values
(`Off`, `Score`, `Killer`, `Random`). Choice values are enum labels, not data,
so they translate. Its one long string, `Manual Start (wait for /countdown)`,
shows the rule for command names: they never translate, so the msgid keeps
`/countdown` literal and carries an `#.` comment telling the translator so.

The audio dialog is the case that looks like an exception and is not. Seven of
its 29 nodes are sentences -- "How loud nearby players sound to you.", "Native
browser processing is enabled when supported." -- but each is a caption bound
to one control, written when that control was written. As files they would be
seven files nobody would keep in step.

### Server Text Is a Third Category

Upstream never translates what the server says, and the first draft of this
plan copied that. It is worth reconsidering, because bzo's server and client
ship from one repo in lockstep and the msgids are English source strings.

There are 66 `replyToPlayer()` calls -- every command answer -- and they already
travel with `msgType: 'server'`, which separates a system reply from player
chat on the wire. The client can therefore look any `msgType: 'server'` line up
in its own catalog with no protocol change at all: the text the server sent is
the msgid, and a line with no translation falls through as the English it
already is.

Of the 66: 22 are plain literals and work that way immediately. 25 are template
literals, and those need the server to send `{ msgid, params }` rather than a
finished string, because a language will not put the substitutions in our
order. The remaining 19 are assembled from variables and want looking at one at
a time.

The boundary inside this category matters more than the category:

- Never translate a line that carries player or operator content -- callsigns,
  MOTD, server name, map names. Those ride through as params and are
  substituted after the lookup, never before.
- Player speech goes out through `deliverChatMessage()` with the sender's own
  `msgType` (`action` for `/me`), never `server`. That is the same line the
  boundary already falls on, which is why the wire needs no new field.
- Command names are protocol. `/kill` is `/kill` in every locale; only the
  usage text around it translates.

### Command Reference Belongs in Both

`/commands` prints one line per command in chat; those lines are catalog
entries. The reference that explains what each command does is a help page.
They are different artifacts with different lifetimes, and trying to generate
one from the other is what makes both bad.

## Help Is Documents

Issue #64 wants the help pages split up, searchable, and readable at `/doc/`
without entering the game. It has to be settled here, because the current help
panel is about 190 lines of prose inline in `index.html` and prose is the one
thing that must not go through gettext. Long paragraphs with markup inside them
make terrible msgids: any edit to the English invalidates every translation, and
a translator is working a sentence at a time with no context.

So help is translated as whole files, not as strings:

- `docs/help/en/*.md` -- one file per page (controls, movement, flags,
  teams, chat, commands, XR), which is the split #64 asks for.
- `docs/help/<locale>/*.md` overlays it. A file that does not exist falls back
  to the English one, marked as untranslated in the page list rather than
  silently served as English.
- Express serves `/doc/` from the negotiated locale, browsable outside the game.
  The in-game help panel fetches the same documents, so there is one copy.
- Search is client-side over an index of the current locale's pages, built when
  the catalogs are; a few dozen kilobytes for a locale.

This also retires a duplication that already exists: the controls list lives in
both `README.md` and the help panel, kept in step by
`scripts/check-controls-docs.mjs` and its regex pairs. Once the pages are the
source, README links to them and that checker goes away rather than being
extended to every locale.

### Which Documents

`docs/` is about 9000 lines, and nearly all of it is repo documentation: the
`*-plan.md` files, `AGENTS.md`, `bzw.md`, `list-server.md`, `login.md`,
`tank-model-format.md`. Those are for people working on bzo or running a
server, they belong on GitHub in English, and none of them is a help page.

Only `docs/help/**` is player documentation, and only it is translated. A few
existing files have player-facing halves -- `flags.md` most of all -- and those
get split rather than moved wholesale.

### Markdown, Rendered at Build Time

Markdown is the source format. It diffs a sentence at a time, translators can
work it without knowing our markup, and the same file is readable on GitHub.
HTML source would avoid a renderer but makes every one of those worse.

Nothing renders markdown at runtime. `npm run build:docs` turns
`docs/help/**/*.md` into one artifact per locale, `public/doc/<locale>.json`,
holding each page's HTML fragment, its XR block list, and the search index.
The server reads those at startup and wraps a fragment in a page shell for
`/doc/` the way it already wraps `/list`; the client fetches the bundle whole,
because search needs every page anyway.

The bundles are generated, not committed. `public/doc/` is gitignored, the way
`cache/` and the imported maps already are: derived from files in the tree, and
rebuilt by whoever is running the tree. `server/precompress.cjs` is the same
idea one step further along -- it already runs as a build step inside the image
and its output is likewise never committed.

So `marked` is a devDependency. The runtime dependency list stays `express`,
`express-rate-limit`, `three`, `ws`, and that mostly settles the renderer
question: 250 lines of our own to avoid a dependency that does not ship is a
bad trade, particularly when the lexer is what produces the XR block list.

Three places have to run the generator, and each is a real place:

- **A working tree.** `npm run dev` builds every locale's pages, and rebuilds
  when a page or a catalog changes. nodemon already watches `public/` and
  restarts on any change there, so the same reflex that picks up an edited
  client file picks up an edited help page:

  - `nodemon.json` watches `docs/help/` and `l10n/`, and adds `md` and `po`
    to `ext`
  - it runs `npm run build:docs && node server.js` rather than the server
    alone, so every restart regenerates
  - it ignores `public/doc/`, or the build's own output triggers the restart
    that triggers the build

  bz.rikers.org runs that loop, so it gets fresh docs without anyone
  remembering a step.
- **The image.** `Dockerfile` gains a builder stage that installs the full
  dependency set, copies `docs/`, runs the generator, and copies
  `public/doc/` into the runtime stage. The markdown sources never enter the
  shipped image, which they do not today either.
- **A bare `npm start`.** The generator must be able to say "marked is not
  installed" and exit cleanly rather than failing the boot, and the server must
  serve a missing bundle as an absent help system rather than a crash. Someone
  will `npm ci --omit=dev && npm start`, and that should give them a running
  game with no docs, not a stack trace.

Nothing then needs a staleness check. There is no committed artifact to fall
behind, and a translation that has fallen behind its English is a fuzzy entry
in a catalog rather than a file nobody noticed.

One artifact per locale is the right shape whether or not it is prebuilt: the
help panel, search, and XR all want the whole locale at once, not a page at a
time.

### The Bundles Are Ordinary Assets

Putting the output under `public/` means the rest of the pipeline already
handles it, and the ordering is the only thing to get right.

`precompress.cjs` matches `.json` in `COMPRESSIBLE` and `assetRoots()` walks
`public/`, so the bundles get brotli sidecars with no change to either. Text
like this is where brotli pays best. The constraint is ordering: the generator
runs before `RUN node server/precompress.cjs` in the image, and before the
server boots anywhere else, since `computeClientBuild()` walks the same tree at
module load.

That walk is also what the client build id hashes, so an edited help page moves
the build id, which keys the service worker cache and prompts connected clients
to reload. That is the correct behavior and it is not new -- editing
`styles.css` does exactly the same today -- but help text is the lowest-stakes
content in the tree and this makes it as disruptive to change as client code.
Worth knowing before someone fixes a typo mid-match.

The bundles also belong in the service worker's `ASSET_PATHS`. That list is
specifically the paths that "change only on release and cannot cause a protocol
desync if they lag", and a build-keyed help bundle is exactly that. Adding
`/doc/` makes help available offline and stops it being refetched every
session; leaving it out means network-first, which merely wastes a request.

### Four Consumers, One Source

The same markdown has to serve four readers, and they differ in what they can
render, not in what they say:

| Reader | Form | How it gets there |
| --- | --- | --- |
| GitHub | markdown, as committed | nothing to do; keep the files readable raw |
| `/doc/` | full HTML page | server wraps the prebuilt fragment in a shell |
| Help panel | HTML fragment | same bundle, fetched by the client |
| XR | text blocks on a canvas | same bundle, serialized by the same build |

`/list` gains a `docs` entry in its nav line (`bzo | bzflag | maps | keys`), so
a visitor who came to see what is running can read the documentation without
launching anything. That page is server-rendered per request already, so it
negotiates its own locale the same way `index.html` does -- which means the
*server* needs the catalog too, not just the client. It is parsing the `.po`
files anyway, so this costs nothing but saying so.

Four renderings and one parse is the argument that settles the renderer
question: `marked` exposes its lexer, so the token stream is available without
a second pass. HTML falls out of it for the web readers and a block list falls
out of it for XR, both in one build. A hand-rolled renderer would owe both, and
would now be 250 lines of our own code to avoid a dependency that does not ship
anyway.

### XR Reads Differently

XR is where a documentation system usually stops pretending, so it is worth
being concrete.

Today XR's "Help" is not the help panel at all. It is `XR_HELP_ITEMS` in
`client.js`: eleven hand-written rows of controller bindings, a third copy of
material that also lives in `README.md` and in the help panel, and the regex
checker that guards the other two does not know it exists.

That split is right and should be kept, because the two things are genuinely
different:

- **A cheat sheet** is what a player in a headset actually wants: eleven rows,
  readable at a glance, no scrolling, answered in two seconds. The existing row
  renderer already draws it.
- **A document** is 800 words at 1.25 m on a 1024x1200 canvas. That is a bad
  read no matter how it is drawn, but it should be possible rather than absent.

So XR gets both. The cheat sheet stays a row screen. Documents get a second
screen kind in `XRMenuRenderer`: word-wrapped text blocks from the lexer token
list, paged with the stick, headings and list items distinguished by size and
indent rather than by markup. No new parser, no DOM -- immersive sessions on a
standalone headset have no `dom-overlay` to fall back on.

### Controls Are Data, Not Prose

The cheat sheet, `docs/controls.md` and the help panel's controls list are three
copies of one table, and `scripts/check-controls-docs.mjs` exists only because
they drift. Translating them would make it three copies per locale.

Controls are structured -- action, keyboard, gamepad, XR controller -- so they
should be a table in code that the three renderings are generated from. Only
the action names are translatable strings; `W/S`, `Tab` and "either trigger"
are not, in any locale. That retires the checker rather than extending it, and
it is the one piece of help that should *not* be a markdown file.

### Translating Prose

po4a is an authoring tool, never a runtime one. It belongs beside `xgettext`
and `msgmerge`: it runs on somebody's machine when the English changes, and the
server never hears of it. The question is not runtime versus dev, it is whether
it belongs in `build:docs`, and it does not -- that would make an apt package a
prerequisite for `npm run dev` and for the image's builder stage, which is a
far larger imposition than a devDependency.

What po4a does is worth copying even if the program is not used. It turns a
markdown file into a `.po` keyed by paragraph, so:

- a translator works in the same format and the same tool as the UI strings
- an untranslated paragraph falls back to English by itself, with no
  per-file staleness bookkeeping
- editing one English paragraph marks that paragraph fuzzy and leaves the rest
  of the page translated

That last property is the one whole-file translation cannot have at any price,
and it is why this is the right model.

The build can do it without po4a. `build:docs` already walks `marked`'s token
stream to emit HTML and XR blocks; emitting each text block as a msgid is the
same walk, and applying a translation is a lookup on the way past. Code fences
and inline code are skipped, table cells are extracted individually. The `.po`
reader this plan already needs for the UI catalog is the same reader.

So:

- `l10n/doc_<locale>.po` are the translations, committed, one per locale.
- `npm run build:docs -- --extract` regenerates `l10n/doc.pot` from the English
  pages; `msgmerge` folds it into each catalog, exactly as for UI strings.
- Nothing generated is committed, and no drift hash is needed: a stale
  paragraph is a fuzzy entry, which is a thing gettext tools already show.
- `docs/help/<locale>/` does not exist. There is one set of English pages and a
  catalog per language.

po4a stays a reasonable fallback if our extractor turns out to mis-handle
something, and adopting it later changes only where the `.pot` comes from.

## Asking for Translations

Soliciting translations means a contributor has to be able to finish one
without asking anyone anything, so the path has to be written down and short:

- what to edit -- `l10n/bzo_<locale>.po` for the interface,
  `l10n/doc_<locale>.po` for the help pages, and nothing else
- how to start a language that does not exist yet -- `msginit`, one command
- how to see it -- `npm run dev`, then `?lang=<locale>`, with no build step to
  understand and nothing to install beyond what the repo already needs
- what not to touch -- command names, flag abbreviations, callsigns, anything
  inside `{braces}`

When the work lands, this plan becomes `docs/i18n.md`, following the pairs the
tree already has (`login-plan.md` and `login.md`, `list-server-plan.md` and
`list-server.md`), and that page is where the above lives.

## Right to Left

No locale we would ship is RTL. Upstream has 16 and none of them is Arabic,
Hebrew or Persian, so this is about not building a corner to paint ourselves
into, not about work to do now.

The DOM half is cheap and worth doing immediately:

- The server already computes the locale for `<html lang>`; stamping `dir`
  beside it is the same line.
- `styles.css` has 40 physical `left`/`right` declarations and no logical ones.
  Converting them to `inline-start`/`inline-end` as they are touched costs
  nothing and is a small improvement on its own terms.
- Chat input and the callsign field want `dir="auto"` now, regardless of UI
  language. A player typing Arabic should see Arabic behave, even when
  everything around it is English. That is one attribute and it is the single
  most likely RTL encounter we will actually have.

The canvas half is where RTL costs real work, and it is worth naming the three
problems separately because they are not the same problem:

- **Layout is physical.** 14 `textAlign = 'left'`/`'right'` calls plus
  x-coordinate arithmetic. Only chrome mirrors; the radar, the world and
  anything tied to game space must not. A radar that flips with the UI
  language is a bug, not a translation.
- **Bidi runs are fine until they are mixed.** `fillText()` applies the Unicode
  bidi algorithm within a string, so Arabic renders shaped and reordered
  correctly on its own. What misbehaves is one string holding an RTL label, an
  ASCII callsign and a number, and canvas has no `<bdi>` or
  `unicode-bidi: isolate` to fence it with. Two defences: draw label and value
  as separate `fillText()` calls -- the scoreboard and XR menu largely do
  already -- and wrap embedded foreign runs in U+2068/U+2069, which the bidi
  algorithm honours in plain text.
- **Truncation is already correct.** `fitText()` cuts from the logical end, so
  an RTL string loses its logical tail and the ellipsis lands on the visual
  left, which is what a reader expects.

So: `dir` and `dir="auto"` now, logical properties opportunistically, canvas
mirroring deferred until a real RTL catalog exists. The list above is here so
nobody has to rediscover it.

## Not Localized

- Player speech: chat, `/say`, `/me`. Relayed verbatim to everyone.
- Callsigns, server name, MOTD, map names -- operator and player content, even
  when it appears inside a translated sentence.
- Command names. `/kill` is `/kill` in every locale.
- Callsigns, server name, MOTD, map names -- operator and player content.
- Flag abbreviations (`RF`, `GM`). They are protocol, shown on the flag itself
  and in radar; the name and description beside them are translated.

## Order of Work

1. **Negotiation and runtime.** `i18n.mjs`, the `.po` reader, `/l10n/:locale
   .json`, the inlined catalog, `<html lang>`, `Vary`, `?lang=`, the Settings
   row. Ships with `en` and `es`, the latter seeded from upstream, so the
   machinery is provable before any bulk tagging and the result has a
   reviewer.
2. **Help pages out of `index.html`** (#64). Split into `docs/help/en/*.md`,
   add `build:docs`, serve `/doc/` from the bundle, link it from `/list`'s nav,
   point the help panel at the same bundle, add search, give `Dockerfile` its
   builder stage before its precompress step, add `/doc/` to the service
   worker's `ASSET_PATHS`, move the controls table into code and generate its
   three renderings from it, retire `check-controls-docs.mjs`. Doing this
   before tagging markup means the help prose never enters a catalog in the
   first place, and what is left of `index.html` is chrome labels.
3. **Declarative surfaces.** `settings.js`, `flags.mjs`, `teams.mjs`, and the
   `index.html` attributes. This is where upstream's import pays for itself --
   menu verbs, team names and flag names are the strings it already has.
4. **Runtime strings**, a file at a time: `client.js` (~200), `input.js`,
   `hud.js`, `voice.js`, `render.js`.
5. **Server replies.** Translate `msgType: 'server'` on receipt, which needs no
   server change, then convert the 25 interpolated `replyToPlayer()` calls to
   `{ msgid, params }`.
6. **The check**, once enough is tagged for it to pass: `check:i18n` in
   `npm run check`.
7. **XR.** Tag `xr-menu.js` and the canvas-drawn labels in `client.js`, then
   add the document screen so `/doc/` pages are readable in a headset.

## HUD Text Size

Issue #113. Sizes are literals today -- `13px` in the degree bar, `58/38/34/28px`
on the XR menu's fixed texture -- and bzo runs on phones, desktops, headsets
and a Jetson, so this is a device problem that i18n only adds to. Upstream
derives its scoreboard font from the viewport and offers `scorefontsize` in the
options menu, which is the shape to copy.

The i18n input is one line of it: full-width scripts fit about half as many
characters per pixel, so a CJK locale wants a larger base rather than more
truncation. Nothing else here waits on #113, and #113 does not wait on this.

## Settled

- **Fonts are a non-issue.** A browser that sends `zh`, `ja` or `ko` in
  `Accept-Language` runs on a system that ships CJK fonts -- Noto on Android
  and ChromeOS, PingFang and Hiragino on Apple, Yu Gothic, Microsoft YaHei and
  Malgun Gothic on Windows -- and canvas uses the same per-glyph fallback chain
  the DOM does, so `13px monospace` resolves CJK like anything else. Tofu is a
  bare container's problem, not a player's, and a webfont would cost megabytes
  to fix a problem we do not have.
- **Translated help pages are solicited.** We may never receive any, and that
  costs nothing: paragraph-level fallback means a page with two translated
  paragraphs is a page with two translated paragraphs, not a broken one. So
  ask, and take whatever arrives.
- **Ship `en`, `es`, `en_US_l33t` and `en_US_redneck`, and grow from there.**
  The locale list is whatever `l10n/` holds, so adding a language is adding a
  file and no code changes to make room for it. Four is enough to prove
  negotiation, the Settings override, and fallback, without presenting a menu
  of half-finished languages. The joke locales are already translated upstream
  and are the cheapest possible test that switching works, since a reviewer who
  speaks no second language can still see whether the menus changed. The rest
  arrive as people contribute them.
- **Spanish is the first real locale.** Upstream's `es` catalog is its largest
  at 936 msgids, and it has a reviewer here, which no other language does. It
  is the locale the machinery gets proved against.
- **An edited help page moves the client build id, and that is fine.**
  `computeClientBuild()` walks `public/`, so a changed bundle changes the build
  and connected clients reload -- the same as editing `styles.css`. Anyone
  editing a page wants to look at it anyway, so the reload is the thing they
  were about to do by hand. No special case in the walk.

## Open Questions

None. #113 carries the HUD sizing work, and everything else here is decided.
