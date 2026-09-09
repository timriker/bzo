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
//
// It renders through SwiftShader, so it answers "does this draw without
// throwing, and what does it look like" and never "how fast is this".

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
const shotPath = args.get('shot') || '';
const evalExpression = args.get('eval') || '';
const settleSeconds = Number(args.get('seconds') || 10);
const port = Number(args.get('port') || 9333);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-headless-'));
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,800',
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
await send('Page.navigate', { url });

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
  await evaluate('document.getElementById("entryOkButton").click()');
  joined = `joined as ${playerName}`;
  break;
}
await sleep(settleSeconds * 1000);

console.log(joined);
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
