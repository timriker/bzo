// The autopilot's router off the main thread (`createAsyncRouter`): the
// world as the page last sent it, and each route asked for, answered in turn.

import { createRouter } from './autopilot.mjs';

let world = null;
const router = createRouter(() => world);

self.onmessage = ({ data }) => {
  if (data.type === 'world') {
    world = data.world;
    return;
  }
  if (data.type === 'route') {
    self.postMessage({ id: data.id, nodes: world ? router(data.from, data.to, data.options) : null });
  }
};
