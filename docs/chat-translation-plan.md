# Chat Translation Plan

Players who share no language should still be able to talk. This is the plan
for translating what players type in chat into each reader's own language.
The interface and help pages are docs/i18n-plan.md; this is the part no
catalog can cover, since nobody writes the text in advance.

## What Is Translated

- Player chat, team chat and direct messages, as each reader receives them,
  into that reader's interface language (`getLocale()` in
  `public/js/i18n.mjs`).
- Nothing the reader wrote themselves, and nothing already in their language.
- Never callsigns, `/commands`, flag abbreviations or anything else the
  catalogs also leave alone (docs/i18n-plan.md, "Not Localized"). A callsign
  that starts the line, a `@mention` and a `/word` are held out of the text
  sent for translation and put back after.
- Not server lines: those are catalog strings (docs/i18n-plan.md, step 5),
  translated exactly, not guessed at.

## Opt-In, Per Reader

A Settings row, **Translate chat**, off by default. Translation can be wrong,
and a reader should choose to see a machine's guess rather than what the
player wrote. With it on:

- a translated line is marked, and tapping or clicking it shows the original
- lines shorter than a few words are left alone: `gg`, `lol` and `nice` are
  understood everywhere and are exactly where language detection fails
- a line that could not be translated -- no model, an unknown language --
  shows as written, with no error

## The Browser First

Chrome's built-in `Translator` and `LanguageDetector` APIs translate a string
on the device. They are present in the Chrome this server runs (156): every
pair of our languages reports as downloadable, Klingon and unknown codes as
unavailable.

```js
const [{ detectedLanguage }] = await (await LanguageDetector.create()).detect(line);
const translator = await Translator.create({ sourceLanguage: detectedLanguage, targetLanguage: getLocale() });
const text = await translator.translate(line);
```

Why it comes first:

- nothing leaves the device -- Chrome documents these as on-device; to be
  confirmed by translating offline once a pack is downloaded
- no cost, no key, and no work on the game server, which shares its process
  with the game loop

What it costs:

- Chrome and Edge on desktop, as far as is known; Firefox and Safari offer no
  such API to a page, and Android Chrome and the Quest browser are untested.
  The row is shown only where `'Translator' in self`
- each language pair is a one-time download, which must start from a user
  gesture -- turning the row on is that gesture, and a progress line shows
  while it loads
- packs are believed to be English-centred, so Spanish to Thai passes through
  English: two downloads, and errors compound. Players reading English get
  the best of it

One translator per source language is created once and kept for the session.

## A Server Fallback, Later

For browsers without the API, a server can offer translation, configured by
its operator in `server.json` and off unless configured:

- **LibreTranslate**, self-hosted, AGPL like bzo; fair quality, its own
  process or host, never inside the game server's
- **an AI model** (an API key), best with slang and typos, at a cost per line

Either way the text leaves the reader's device, so the Settings row says so
when it is the server translating, and it is a separate choice from the
on-device one. The server translates each line once per target language and
caches it, rate-limits per player, and never translates for a BZFlag native
client, whose wire is ASCII.

## Not Covered

- Voice. Speech-to-text and back is another plan.
- Translating what a player sends before it goes out. Readers choose; the
  writer's words stay theirs.
- Chat bridged to Discord (docs/discord.md), which Discord's own clients can
  translate.

## Order of Work

1. The Settings row, shown where the browser has the API, and translation of
   incoming chat lines with the original on tap.
2. The hold-outs: callsigns, mentions, commands and flag abbreviations kept
   out of the translated text.
3. Confirm on-device behaviour offline, and test Android Chrome and a Quest.
4. The server fallback, if players on other browsers ask for it.
