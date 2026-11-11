# Chat Translation Plan

Issue #205. Players who share no language should still be able to talk. This
is the plan for translating what players type in chat into each reader's own
language.
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

## Automatic, With the Original a Tap Away

No Settings row: wherever the browser can translate, chat in another
language arrives in the reader's own, as bzo implements the best variant
rather than offering a choice. Translation can be wrong, so the reader is
never left with only the machine's guess:

- a translated line is marked, and its **Show original** button -- a tap or
  click on the mark -- puts the words as written back in its place, and again
  turns the translation back
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
  Where `'Translator' in self` is false, chat shows as written, as today
- each language pair is a one-time download, which must start from a user
  gesture: the first line needing a pack not yet on the device is shown as
  written, with a **Translate** button that is that gesture, and a progress
  line while it loads; every line after it, in that language, is translated
  without asking
- packs are believed to be English-centred, so Spanish to Thai passes through
  English: two downloads, and errors compound. Players reading English get
  the best of it

One translator per source language is created once and kept for the session.

## An English Copy for BZFlag Clients

A BZFlag client draws ASCII, and bzo folds chat to it on the way
(`toBzfsChatText`): accented Latin survives, but a line in Cyrillic, Greek or
CJK folds to nothing and is not sent at all, so those players never see it.

Where the writer's browser has the API, a line it detects as not English goes
out with an English copy beside it (`en`, the same length limits, through the
same bad-word filter as the line itself). The server sends a BZFlag client the
English copy, folded; everyone else still gets the line as written, and bzo
readers translate that into their own language rather than from the copy.
Without the API on the writer's side, a native client gets the fold, as
today. The writer's words stay theirs: the copy only reaches readers who
could not read the original at all.

## Matrix and Discord

Neither gives a bot a way to translate in a reader's client, and bzo does not
translate on the server (below), so the bridges carry the line as written.
Lines coming the other way, from Matrix or Discord into the game, reach bzo
readers as chat and are translated like any other.

## A Server Fallback, Later

For browsers without the API, a server can offer translation, configured by
its operator in `server.json` and off unless configured:

- **LibreTranslate**, self-hosted, AGPL like bzo; fair quality, its own
  process or host, never inside the game server's
- **an AI model** (an API key), best with slang and typos, at a cost per line

Either way the text leaves the reader's device, so this one is a choice: a
Settings row, off by default, saying that the server translates, unlike the
automatic on-device kind. The server translates each line once per target
language and caches it, rate-limits per player, and never translates for a
BZFlag native client, whose wire is ASCII.

## Not Covered

- Voice. Speech-to-text and back is another plan.
- Translating what a player sends for other bzo readers or for the bridges:
  only BZFlag clients get the English copy above.

## Built

Steps 1 to 3, in `public/js/chat-translate.mjs`: incoming chat, team chat,
direct messages and lines from Matrix and Discord are translated on the
device, with **Show original** and **Translate** on the line (and the
translation, with no button, on the XR panel); callsigns, `@names`,
`/commands`, links and flag abbreviations are held out; and a line not in
English is sent with an English copy (`en`) that a BZFlag client, and a
proxied bzfs, read in its place. Tested against stand-ins for the APIs
(`scripts/test-chat-translate.mjs`), not yet in Chrome itself.

## Order of Work

1. Translation of incoming chat lines where the browser has the API, with
   **Show original** on each and **Translate** for a pack not yet
   downloaded.
2. The hold-outs: callsigns, mentions, commands and flag abbreviations kept
   out of the translated text.
3. The English copy for BZFlag clients: sent beside a line not in English,
   filtered as the line is, and given to native clients folded.
4. Confirm on-device behaviour offline, and test Android Chrome and a Quest.
5. The server fallback, if players on other browsers ask for it.
