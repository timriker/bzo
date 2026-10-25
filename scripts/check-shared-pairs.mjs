/*
 * Verifies each public/<name>.mjs and server/<name>.cjs pair still agrees.
 * The convention is hand-maintained, so nothing otherwise stops the copies
 * drifting -- and a drifted pair means the client and server disagree about
 * geometry, which surfaces as position corrections rather than an error.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Each pair is written by hand on both sides, so it is compared by exported
// shape: the server loads every other shared module from public/js directly.
const HAND_WRITTEN = ['shots', 'teams', 'player-ids'];

let failed = false;
const fail = (msg) => { console.error(msg); failed = true; };

for (const name of HAND_WRITTEN) {
  const client = await import(`../public/js/${name}.mjs`);
  const server = require(`../server/${name}.cjs`);

  for (const key of Object.keys(client)) {
    if (!(key in server)) {
      // The pairs are deliberately asymmetric: each side carries the helpers
      // only it needs. Shared names are what must agree.
      continue;
    }
    const a = client[key];
    const b = server[key];
    if (typeof a !== typeof b) {
      fail(`${name}: ${key} is ${typeof a} on the client, ${typeof b} on the server`);
    } else if (typeof a === 'function' && a.length !== b.length) {
      // This is the check that catches a parameter added to only one copy.
      fail(`${name}: ${key} takes ${a.length} args on the client, ${b.length} on the server`);
    } else if (typeof a === 'number' && a !== b) {
      fail(`${name}: ${key} is ${a} on the client, ${b} on the server`);
    }
  }
}

if (failed) process.exit(1);
console.log('shared client/server pairs are in sync');
