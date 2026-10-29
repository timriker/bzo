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
  data in `public/js/flags.mjs` rather than strings from the server.

## Locale Negotiation

Precedence, highest first:

1. The player's choice in Settings, the `bzo_lang` cookie. They picked it;
   nothing should second-guess that. A cookie rather than local storage so
   every page the server renders -- `/help`, `/list`, the game's first paint
   -- follows it, not only the game.
2. `?lang=` on the URL. Lets a share-view link carry a language and makes any
   locale testable from a browser that will not send the header.
3. `Accept-Language`, matched with `req.acceptsLanguages()` against the locales
   found at startup.
4. `en`.

The server resolves all four while rendering `index.html`, which is already a
per-request template, and hands the client what 2-4 alone pick as `browser`,
which is what Automatic means. Two more markers join `bzo-build`:

- `<html lang="en">` becomes the negotiated tag and its `dir`, so screen
  readers, spellcheck and CSS `:lang()` are right from the first byte.
- `<script type="application/json" id="bzo-l10n">` carries the catalog:
  `{ locale, locales, messages }`, the locale being what the client was
  served. It is tens of kilobytes, it saves a round trip, and it means no
  frame is ever painted in the wrong language.

`GET /l10n/<locale>.json` serves the same object for switching language
without a reload.

Two cache rules follow and are easy to miss:

- Every negotiated response carries `Vary: Accept-Language, Cookie` beside its
  `Cache-Control`, or a proxy will hand one player's German page to the next
  player. `Vary: User-Agent` is already set elsewhere for a similar
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

- `xgettext -L JavaScript --keyword=t --keyword=N_` over `public/js/`
  regenerates `l10n/bzo.pot`. `N_()` marks a msgid looked up later, as the
  Settings rows' labels are. The `data-i18n` markup in `index.html` is
  gathered by the same script, since xgettext cannot read HTML.
- `msgmerge` folds the new template into each existing catalog.
- `msgfmt --check-format` validates.

`npm run l10n:update` runs all three.

One import script, `npm run l10n:import-bzflag -- <locale>...`, seeds our
catalogs from `$BZFLAG/data/l10n/*.po` (default `$HOME/bzflag`) by matching
msgids. Terminology should follow whatever
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

`public/js/i18n.mjs` owns it: `t(msgid, params)`, `setLocale(locale)`, and one
pass over the DOM at boot for `data-i18n`, `data-i18n-title`,
`data-i18n-placeholder` and `data-i18n-aria-label` attributes in `index.html`.
About 178 text nodes today, but roughly half of them are the help panel and
leave with #64.
`setLocale()` fetches `/l10n/<locale>.json`, re-runs the DOM pass, and repaints
the HUD; no reload. The pass rewrites only text that still says what it last
wrote: text script has since changed -- the mic button's state, Apply turned
Restart -- is its owner's to repaint on `onLocaleChange`.

Settings gains one row, matching upstream's Options menu:

```js
{ id: 'languageBtn', label: 'Language', kind: 'choice' }
```

cycling Automatic and the available locales. Automatic, the default, means
"follow the browser" and is no cookie at all; choosing the language the
browser already asks for clears the cookie too, so a choice that only repeats
the browser does not pin the game once the browser's setting moves on. A
choice an older client left in `localStorage` is moved to the cookie once.

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

There are about 200 `replyToPlayer()` calls -- every command answer -- and
they already travel with `msgType: 'server'`, which separates a system reply
from player chat on the wire. The client can therefore look any
`msgType: 'server'` line up in its own catalog with no protocol change at all:
the text the server sent is the msgid, and a line with no translation falls
through as the English it already is.

Plain literals work that way immediately. Template literals need the server
to send `{ msgid, params }` rather than a finished string, because a language
will not put the substitutions in our order. Lines assembled from variables
want looking at one at a time.

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

Issue #64 wanted the help split into pages, searchable, and readable without
entering the game. It had to be settled here, because prose is the one thing
that must not go through gettext as strings: long paragraphs with markup in
them make terrible msgids, and a translator working a sentence at a time has no
context.

- `docs/help/*.md` are the pages, one file each: controls, flags, scoreboard,
  voice, about. `server/help-docs.cjs` lists them in order.
- `/help` is all of them on one page, `/help/<page>` one alone, both in the
  negotiated language. `/list`'s nav links it, so a visitor can read it without
  launching anything.
- The in-game panel fetches `/help.json` the first time it opens and shows a
  page at a time, with a button for each and a search over all of them
  (`public/js/help.js`). A link between pages stays in the panel.
- `llms-full.txt` is the same pages as one Markdown file.

That retired `scripts/check-controls-docs.mjs`: the panel no longer has a copy
of the controls to drift from `docs/help/controls.md`.

### Which Documents

The rest of `docs/` is repo documentation -- the `*-plan.md` files, `bzw.md`,
`list-server.md`, `login.md` -- for people working on bzo or running a server.
It belongs on GitHub in English and none of it is a help page. Only
`docs/help/` is player documentation, and only it is translated.

### Rendered at Request Time

Markdown is the source format. It diffs a sentence at a time, translators can
work it without knowing our markup, and the same file is readable on GitHub.

`server/discovery.cjs` already rendered `docs/controls.md` for `/help` with a
small renderer of its own, so the pages go through it too: read when their
mtime moves, rendered per request, as the `.po` catalogs are. No build step, no
generated artifact, no devDependency, nothing for the image to do but copy
`docs/help/`. An edited page shows on the next load without moving the client
build id.

A line that is only `<!-- name -->` is a marker for what a page cannot hold:
`flags.md`'s `<!-- flags -->` is the flag table on `/help`, and in the panel
the place the client builds its live list, which knows the world's ricochet
rule.

### XR Reads Differently

XR is where a documentation system usually stops pretending, so it is worth
being concrete.

XR's "Help" is not the help panel at all. It is `XR_HELP_ITEMS` in
`client.js`: eleven hand-written rows of controller bindings, a second copy of
what `docs/help/controls.md` says.

That split is right and should be kept, because the two things are genuinely
different:

- **A cheat sheet** is what a player in a headset actually wants: eleven rows,
  readable at a glance, no scrolling, answered in two seconds. The existing row
  renderer already draws it.
- **A document** is 800 words at 1.25 m on a 1024x1200 canvas. That is a bad
  read no matter how it is drawn, but it should be possible rather than absent.

So XR gets both. The cheat sheet stays a row screen. Documents get a second
screen kind in `XRMenuRenderer`: word-wrapped text blocks from the same walk
the renderer makes, paged with the stick, headings and list items
distinguished by size and indent rather than by markup. No new parser, no DOM
-- immersive sessions on a standalone headset have no `dom-overlay` to fall
back on.

### Controls Are Data, Not Prose

The cheat sheet and `docs/help/controls.md` are two copies of one table, and
translating them would make it two copies per locale.

Controls are structured -- action, keyboard, gamepad, XR controller -- so they
should be a table in code that the three renderings are generated from. Only
the action names are translatable strings; `W/S`, `Tab` and "either trigger"
are not, in any locale. It is the one piece of help that should *not* be a
markdown file, and it is not built yet.

### What Is Still Written Twice

Issue #64 asked for split pages, search, reading outside the game and room
for languages, and all four are built. What is left is help that exists both as
markdown and as HTML or code:

- **Discord** is HTML in `helpPage()`, not a page. It belongs in `about.md`,
  with a marker for the account-link sentence that only some servers offer.
- **The XR cheat sheet.** `XR_HELP_ITEMS` repeats the "XR controllers" table
  in `controls.md`. Rather than a controls table in code (below), the rows can
  be read from that markdown table, so the page stays the one source and its
  cells are already doc-catalog entries.
- **The tagline.** "A free 3D tank game in the browser that plays with BZFlag"
  is in `index.html`, `about.md` and `GAME_DESCRIPTION`.

Issue #64 suggested `/doc/`; `/help` is the address, reachable from `/list`
and from the game, and needs no alias.

### Translating Prose

Pages are translated a paragraph at a time, as po4a would, without po4a:

- the renderer hands each block -- heading, paragraph, list item, table cell --
  to a `translate` function before rendering it, and `npm run l10n:update`
  extracts `l10n/doc.pot` by running the same walk with a collecting one, so
  the two cannot disagree about where a paragraph ends
- `l10n/doc_<locale>.po` holds the translations, one per interface locale,
  merged with fuzzy matching on, so editing an English paragraph marks that
  paragraph fuzzy and leaves the rest of the page translated
- an untranslated or fuzzy paragraph is the English one; `<html lang>` on
  `/help` stays `en` until a locale's doc catalog has anything in it
- heading anchors stay English, so a link to `controls.md#hunting` works in
  every language

## Pages the Server Renders

`/list` and `/help` negotiate the reader's language as the game page does,
send `Vary: Accept-Language`, and translate with `l10n.translator(locale)` --
a `t` like the client's, so `l10n-update` extracts their strings with
everything else. Server names, maps, callsigns and addresses are data and
stay as they are. `/list`'s browser script reads its strings from a JSON
block the page embeds, built from the script's own `t('...')` calls
(`l10n.scriptMsgids`). The game's summary heads both pages and the game
page's link preview in the reader's language; llms.txt, the sitemap and
robots.txt stay English for the machines that read them.

## Asking for Translations

Soliciting translations means a contributor has to be able to finish one
without asking anyone anything, so the path has to be written down and short:

- what to edit -- `l10n/bzo_<locale>.po` for the interface,
  `l10n/doc_<locale>.po` for the help pages, and nothing else
- how to start a language that does not exist yet -- copy `l10n/bzo.pot` to
  `l10n/bzo_<locale>.po`, set its `Language:`, and run `npm run l10n:update`,
  which makes the `doc_` catalog beside it. Not `msginit`: for an English
  locale it copies every msgid into the msgstr and the catalog looks finished
- how to see it -- `npm run dev`, then `?lang=<locale>`, with no build step to
  understand and nothing to install beyond what the repo already needs
- what not to touch -- command names, flag abbreviations, callsigns, anything
  inside `{braces}`

## Reviewing

Every catalog but English was machine-written, so each says so and says where
it is least sure, in the catalog itself, where a translator is already looking
and where gettext keeps it across every merge:

- a catalog nobody fluent has read has `X-Review:` in its header; the reviewer
  deletes the field when they have read it all
- an entry with a doubt has a translator comment, `# review: <why>`, above it;
  the reviewer fixes the entry and deletes the comment
- `npm run l10n:review` prints a line per locale: translated, fuzzy and
  flagged counts, and whether it is reviewed. Naming locales
  (`npm run l10n:review -- fr ja`) lists each flagged entry with its note

An issue would go stale the first time an English string moved; the comment
moves with the entry. Untranslated and fuzzy entries need no comment, since
both already read as English and the report counts them.

When the work lands, this plan becomes `docs/i18n.md`, following the pairs the
tree already has (`login-plan.md` and `login.md`, `list-server-plan.md` and
`list-server.md`), and that page is where the above lives.

## Right to Left

No locale we would ship is RTL. Upstream has 16 and none of them is Arabic,
Hebrew or Persian, so this is about not building a corner to paint ourselves
into, not about work to do now.

The DOM half is cheap, and most of it is done:

- `<html dir>` is stamped beside `lang`, from `textDirection()` in
  `public/js/i18n.mjs`, and set again when the language changes.
- Every free-text field -- chat, callsign, motto, server title, MOTD, the
  recording name, help search, the XR keyboard field -- has `dir="auto"`. A
  player typing Arabic sees Arabic behave even when everything around it is
  English, which is the most likely RTL encounter we will actually have.
- Each coloured run in a chat line is `unicode-bidi: isolate`, so a
  right-to-left callsign cannot reorder the words beside it.
- Left: `styles.css` has about 45 physical `left`/`right` declarations and no
  logical ones. Converting them to `inline-start`/`inline-end` as they are
  touched costs nothing and is a small improvement on its own terms.

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
- Flag abbreviations (`RF`, `GM`). They are protocol, shown on the flag itself
  and in radar. They are made from the English name, so wherever a flag is
  explained -- the help pages, the flag list -- the English name stays beside
  the abbreviation to say where it comes from, followed by the translated name
  and description: `RF -- Rapid Fire -- Disparo rápido -- ...`. Where space is
  short, as in a HUD alert, the translated name and the abbreviation are
  enough.

## Order of Work

1. **Negotiation and runtime.** Built: `public/js/i18n.mjs`,
   `server/l10n.cjs`, `/l10n/:locale.json`, the inlined catalog,
   `<html lang dir>`, `Vary`, `?lang=`, the Language row, and
   `scripts/test-i18n.mjs`. Tagged so far: the Settings rows and values and
   the entry dialog. Ships `es`, `en_US_l33t` and `en_US_redneck` seeded from
   upstream; the Spanish upstream lacked is new and wants review.
2. **Help pages out of `index.html`** (#64). Built: `docs/help/*.md`,
   `server/help-docs.cjs`, `/help`, `/help/<page>`, `/help.json`, the panel's
   page buttons and search, the `/list` nav link, `l10n/doc.pot` and a
   `doc_<locale>.po` per locale, all empty so far; `check-controls-docs.mjs`
   is retired. Left: the controls table in code (see "Controls Are Data, Not
   Prose"), which waits for XR.
3. **Declarative surfaces.** Built: flag names and help, team names and the
   scoreboard's colour words, the voice channels and their hints, the
   observer camera labels (`{who}` placed per language, the callsign keeping
   its colour), and the inspect panel's World button. `l10n-update` lists the
   flag and team tables' strings with a note on each. The flag list is
   `flagHelpGroups()` in `public/js/flags.mjs`, rendered by
   `server/help-docs.cjs` for `/help`, the panel and llms-full.txt alike, in
   the form "Not Localized" below gives.
4. **Runtime strings.** Built: about 450 strings across `client.js`,
   `index.html`, `input.js`, `hud.js`, `voice.js`, `radar.js`,
   `inspect-panel.mjs` and `install.js` -- the loading screen, HUD alerts,
   the chat notices the client writes (whole sentences, the callsign keeping
   its colour wherever a language puts it), the operator, audio and view
   dialogs, and voice errors (English in the log, translated on screen).
   Left: `list-page.js`, a plain script on the server-rendered `/list` page
   that cannot import the runtime; the "Default microphone" option, whose
   text code reads back; and XR (step 7).
5. **Server replies.** Built. The server sends English as it always has --
   a BZFlag client, the log, a replay and the Discord bridge read only
   `text` -- and beside it `msgid` and `params` (`localized` in
   `public/js/i18n.mjs`; `replyToPlayer(player, msgid, params)`), which the
   client translates with the callsigns and numbers put back untouched. A
   param that is itself `{ msgid }` -- a team, on/off -- is translated too.
   A server line with no msgid is looked up whole. `l10n-update` extracts
   `replyToPlayer`'s and `localized`'s literals from the server. Left as
   English: data listings (`/playerlist`, ban lists, `/help` lines), the
   lines the client parses back (`/flag show`), upstream-shaped refusals,
   and errors built inside `server/commands.cjs` and the config validator,
   whose return shapes the tests pin.
6. **The check**, once enough is tagged for it to pass: `check:i18n` in
   `npm run check`.
7. **XR.** Tag `xr-menu.js` and the canvas-drawn labels in `client.js`, then
   add the document screen so the help pages are readable in a headset.

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
- **Chinese, Japanese and Korean ship too** as `zh_CN`, `zh_TW`, `ja` and
  `ko`, which upstream never had. Chinese is two catalogs, each in its own
  region's vocabulary rather than a character conversion of the other, and
  `TAG_ALIASES` in `server/l10n.cjs` sends `zh-HK`, `zh-MO` and any `zh-Hant`
  tag to Traditional, `zh-SG` and `zh-Hans` to Simplified, and a bare `zh` to
  Simplified.
- **Every upstream catalog ships.** `npm run l10n:import-bzflag` seeded all
  of them; `xx` is upstream's untranslated template and is not a language.
  Klingon comes in as `tlh`, its ISO code, because upstream's `kg` is Kongo's
  and a Kongo browser would be handed Klingon. Each names itself in its own
  language, overriding the English names some upstream catalogs carry.
  Upstream's catalogs are ASCII only, so Czech, Slovak and Lithuanian lost
  their diacritics and Russian was transliterated into Latin; bzo renders
  through the browser and every catalog is UTF-8 in its own script. Every
  string the interface and the help pages have so far is translated in every
  locale, machine-written from upstream's terms where they fit, and wants a
  native speaker's review.
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
