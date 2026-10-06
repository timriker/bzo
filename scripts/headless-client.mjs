#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Joins the game in a headless Chrome and reports what the client made of it:
// every console error and uncaught exception, an optional screenshot, and an
// optional expression evaluated in the page. Chrome speaks CDP over a WebSocket
// and `ws` is already a dependency, so this needs no browser automation library.
//
//   node scripts/headless-client.mjs --shot /tmp/shot.png
//   node scripts/headless-client.mjs --eval 'document.getElementById("playerName").textContent'
//   node scripts/headless-client.mjs --window 320,240   # ~60fps instead of ~8
//   node scripts/headless-client.mjs --mv "280,15,-280 sw" --drive 20 --steer center
//   node scripts/headless-client.mjs --chat "/flag give headless GM"
//
// It renders through SwiftShader, so it answers "does this draw without
// throwing, and what does it look like" and never "how fast is this". The frame
// *rate* still matters for what it can reach: gameplay is integrated per frame,
// so a probe at 8fps moves a tank two feet a step and steps clean over anything
// that only happens at a player's frame rate. `--window` is the dial -- 320,240
// runs near 60fps, which is where those bugs live. `--drive` holds forward for
// that many seconds (real key events, same as a player pressing W), polling
// /api/players once a second to log where the tank actually went; `--steer
// center` taps A/D between polls to keep it pointed at the map origin. `--chat`
// types chat lines (newline-separated) into the chat box before the drive,
// which is how a probe reaches anything that only a command can set up.
// `--hop 3` taps jump every three seconds instead of sitting still, for a
// target that is in the air on a schedule. `--fire 1` taps the trigger once a
// second of the drive, and half a second into each hop, for a shot fired on the
// move or in the air. `--press KeyC,KeyC` presses those keys once each after
// joining, for a probe that wants a particular view. `--autopilot 30` presses 9 instead and lets the default
// pilot fly for that many seconds, logged the way a drive is.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const url = args.get('url') || 'http://localhost:3000';
const playerName = args.get('name') || 'headless';
// The team to join as, for a probe that has to look like a particular team
// rather than whatever Automatic hands out.
const playerTeam = args.get('team') || '';
const shotPath = args.get('shot') || '';
const evalExpression = args.get('eval') || '';
const settleSeconds = Number(args.get('seconds') || 10);
const driveSeconds = Number(args.get('drive') || 0);
const steerMode = args.get('steer') || 'none';
const fireOnMove = args.get('fire') === '1';
const port = Number(args.get('port') || 9333);
// SwiftShader's cost is per pixel, so the window size is the frame rate. The
// default draws a plausible screenshot at single-digit fps; a small one runs
// near 60 and is the only way this probe reaches a motion bug that depends on
// how far a tank moves in one frame.
const windowSize = args.get('window') || '1280,800';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-headless-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${windowSize}`,
  // SwiftShader is the only GL a headless container has, and recent Chrome
  // refuses to fall back to it without being told to.
  '--enable-unsafe-swiftshader',
  '--use-gl=swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

const devtools = async (endpoint) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}${endpoint}`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('headless chrome never opened its debugging port');
};

await devtools('/json/version');
const target = (await devtools('/json/list')).find((entry) => entry.type === 'page');
const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve) => socket.on('open', resolve));

let nextId = 0;
const pending = new Map();
const problems = [];
socket.on('message', (raw) => {
  const message = JSON.parse(raw);
  if (message.id !== undefined) {
    const settle = pending.get(message.id);
    pending.delete(message.id);
    // Taken out of the map before it runs, and only ever run when it is a
    // callback this script put there itself: the id in a reply correlates it
    // with a request rather than choosing what to call, so a reply naming an id
    // nobody is waiting for is dropped instead of dispatched.
    if (typeof settle === 'function') settle(message);
    return;
  }
  const { method, params } = message;
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails;
    problems.push(`EXCEPTION ${details.exception?.description || details.text}`);
  } else if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
    problems.push(`CONSOLE.${params.type} ${params.args.map((arg) => arg.description ?? arg.value).join(' ')}`);
  } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
    problems.push(`LOG ${params.entry.text}`);
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, (message) => (
    message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)
  ));
  socket.send(JSON.stringify({ id, method, params }));
});

// Wrapped so a probe that throws is reported rather than ending the run.
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => { try { return ${expression}; } catch (error) { return 'ERROR ' + error.message; } })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// A headless window is never the OS's focused window, so plain `.focus()`
// calls from here on are no-ops without this -- the name field happens to get
// through regardless (CDP hands a fresh page initial synthetic focus), but
// anything focused after that first paint, like the chat input, silently does
// not.
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
// Joined as a robot tank (`?bot`), so a probe is counted apart from the people
// playing on the list and in the log -- unless `--human 1` says it is standing
// in for one, which is how the bot fill is tested.
const pageUrl = new URL(url);
if (!args.get('human')) pageUrl.searchParams.set('bot', '');
await send('Page.navigate', { url: pageUrl.href });

// The entry dialog is what a browser that has never been here gets, and it can
// take a while to arrive behind the asset load.
let joined = 'entry dialog never appeared';
for (let second = 0; second < 45; second += 1) {
  await sleep(1000);
  if (await evaluate('document.getElementById("entryDialog")?.style.display') !== 'block') continue;
  // Typed rather than built into the expression. `JSON.stringify` into a string
  // of code is an escape that only mostly works, and `Input.insertText` carries
  // the name as a parameter instead -- which also types it the way a player
  // does, input events and all, rather than assigning past them.
  await evaluate('(() => { const input = document.getElementById("entryInput");'
    + ' input.value = ""; input.focus(); return input === document.activeElement; })()');
  await send('Input.insertText', { text: playerName });
  // Set where the dialog itself keeps the choice (getDialogPlayerTeam reads
  // `dataset.team`), rather than cycling the selector button a guessed number
  // of times -- the offered list depends on the server's team mode.
  if (playerTeam) {
    await evaluate('(() => { const el = document.getElementById("entryTeamSelector");'
      + ` if (el) el.dataset.team = ${JSON.stringify(playerTeam)}; return el?.dataset.team; })()`);
  }
  await evaluate('document.getElementById("entryOkButton").click()');
  joined = `joined as ${playerName}${playerTeam ? ` on ${playerTeam}` : ''}`;
  break;
}
// `code` alone is what input.js reads (`e.code`), so `key` here is cosmetic --
// kept only because a real KeyboardEvent always carries one too.
// The character a letter or digit key types, which handlers that read
// `event.key` rather than `event.code` need.
const keyChar = (code) => {
  const match = /^(?:Key|Digit)(.)$/.exec(code);
  return match ? match[1].toLowerCase() : undefined;
};
const dispatchKey = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: keyChar(code) });
const keyDown = (code) => dispatchKey('rawKeyDown', code);
const keyUp = (code) => dispatchKey('keyUp', code);

const fetchSelf = async () => {
  const { players } = await (await fetch(`${url}/api/players`)).json();
  return players.find((player) => player.name === playerName);
};

// A chat line, typed into the chat box exactly as a player would type it
// rather than called over HTTP -- the commands worth driving this probe with
// are `/mv` and `/flag`, and neither has a REST equivalent.
const sendChat = async (line) => {
  // Focus, text and Enter in one `evaluate`, which is one synchronous tick in
  // the page. Three separate CDP calls cannot be: a headless window has no
  // real OS focus, so whatever the page focused on the first call is gone
  // again before `Input.insertText` arrives, and the text lands nowhere with
  // no error to say so -- the command simply never reaches the server.
  // `chatInput`'s own submit is a plain `keydown` listener on the element
  // (public/client.js), so a synthetic `KeyboardEvent` drives the same path a
  // real Enter does.
  const sent = await evaluate(`(() => {
    const el = document.getElementById('chatInput');
    if (!el) return 'no chatInput';
    el.focus();
    el.value = ${JSON.stringify(line)};
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
    }));
    return el.value === '' ? 'sent' : 'not accepted: ' + el.value;
  })()`);
  if (sent !== 'sent') problems.push(`chat "${line}": ${sent}`);
  await sleep(500);
};

// `/mv` is bzo's own chat command for teleporting a tank, and keeps its own
// option because placing the tank is what most probes want. `--chat` is the
// same path for anything else; both run before the drive, `--mv` first.
const mvArgs = args.get('mv') || '';
const chatLine = args.get('chat') || '';
if ((mvArgs || chatLine) && joined.startsWith('joined')) {
  // The entry dialog closing is not the tank existing -- gameConfig, the
  // world, and the tank itself all still have to arrive before chat is a
  // real gameplay context rather than the dialog's own leftover one.
  await sleep(2000);
  if (mvArgs) await sendChat(`/mv ${mvArgs}`);
  // Newline-separated, so a probe that needs a sequence -- give a flag, look at
  // it, put it down -- is one option rather than one run each.
  for (const line of chatLine.split('\n').map((text) => text.trim()).filter(Boolean)) {
    await sendChat(line);
  }
}

const pressKeys = (args.get('press') || '').split(',').map((code) => code.trim()).filter(Boolean);
if (pressKeys.length && joined.startsWith('joined')) {
  if (!mvArgs && !chatLine) await sleep(2000);
  for (const code of pressKeys) {
    await keyDown(code);
    await sleep(80);
    await keyUp(code);
    await sleep(200);
  }
}

const driveLog = [];
const autopilotSeconds = Number(args.get('autopilot') || 0);
if (autopilotSeconds > 0 && joined.startsWith('joined')) {
  await sleep(2000);
  await keyDown('Digit9');
  await sleep(60);
  await keyUp('Digit9');
  for (let second = 1; second <= Math.ceil(autopilotSeconds); second += 1) {
    await sleep(1000);
    const self = await fetchSelf();
    driveLog.push(self
      ? `t=${second}s x=${self.x.toFixed(2)} y=${self.y.toFixed(2)} z=${self.z.toFixed(2)} azimuth=${self.azimuth.toFixed(2)}`
      : `t=${second}s: not in /api/players`);
  }
}
if (driveSeconds > 0 && joined.startsWith('joined')) {
  await keyDown('KeyW');
  const pollMs = 1000;
  for (let second = 1; second <= Math.ceil(driveSeconds); second += 1) {
    await sleep(pollMs);
    if (fireOnMove) {
      await keyDown('Enter');
      await sleep(60);
      await keyUp('Enter');
    }
    const self = await fetchSelf();
    if (!self) {
      driveLog.push(`t=${second}s: not in /api/players`);
      continue;
    }
    driveLog.push(`t=${second}s x=${self.x.toFixed(2)} y=${self.y.toFixed(2)} z=${self.z.toFixed(2)}`
      + ` azimuth=${self.azimuth.toFixed(2)}`);
    if (steerMode === 'center') {
      // `/api/players` is in upstream's frame: forward at azimuth a is
      // (cos a, sin a), so the heading toward the origin from (x, y) is
      // atan2(-y, -x). A positive turn, `KeyA`, raises it.
      const target = Math.atan2(-self.y, -self.x);
      let diff = target - self.azimuth;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) > 0.15) {
        const turnKey = diff > 0 ? 'KeyA' : 'KeyD';
        await keyDown(turnKey);
        await sleep(120);
        await keyUp(turnKey);
      }
    }
  }
  await keyUp('KeyW');
}

// `--hop <seconds>`: tap jump on that interval for the whole settle, a target
// that is in the air on a schedule -- what a pilot's landing shot is aimed at.
const hopSeconds = Number(args.get('hop') || 0);
if (hopSeconds > 0 && joined.startsWith('joined')) {
  const settleEnd = Date.now() + (settleSeconds * 1000);
  while (Date.now() < settleEnd) {
    await keyDown('Tab');
    await sleep(150);
    await keyUp('Tab');
    if (fireOnMove) {
      await sleep(350);
      await keyDown('Enter');
      await sleep(60);
      await keyUp('Enter');
    }
    await sleep(Math.max(0, Math.min(hopSeconds * 1000 - (fireOnMove ? 560 : 150), settleEnd - Date.now())));
  }
} else {
  await sleep(settleSeconds * 1000);
}

console.log(joined);
if (driveLog.length) console.log(driveLog.join('\n'));
if (evalExpression) console.log(`eval: ${JSON.stringify(await evaluate(evalExpression))}`);
if (shotPath) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotPath, Buffer.from(data, 'base64'));
  console.log(`screenshot: ${shotPath}`);
}
console.log(problems.length ? problems.slice(0, 20).join('\n') : 'no console errors or exceptions');

socket.close();
chrome.kill();
// Chrome is still unlinking its own profile as it goes.
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  // Left in the temp directory rather than failing a run that already reported.
}
