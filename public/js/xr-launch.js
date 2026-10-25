/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// xr-launch.js - Asks for the immersive session at the first possible moment.
//
// Loaded ahead of client.js so it runs on its own small module graph rather
// than waiting for three. A headset grants an app launched from its icon the
// user activation `requestSession` needs, but only briefly, and the client
// takes seconds to become ready to render.

import { preflightHeadsetLaunch } from './webxr.js';

preflightHeadsetLaunch();
