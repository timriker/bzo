/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A headset's own browser, as opposed to a device that merely has a headset
// available to it. The client uses this to decide what XR controls to offer;
// the server uses it to decide which app icon a launcher will be given, since
// a headset library and a phone launcher want opposite artwork.
const HEADSET_BROWSER_PATTERN = /OculusBrowser|Quest|Pico|Wolvic|Vive/i;

// Chrome on Android reports immersive-vr support on any phone, because it can
// render to a Cardboard viewer, so a handheld counts as headset-less.
const HANDHELD_PATTERN = /Android|webOS|iPhone|iPad|iPod|Mobile/i;

export function isHeadsetBrowserUA(userAgent) {
  return HEADSET_BROWSER_PATTERN.test(userAgent || '');
}

export function isHandheldUA(userAgent) {
  return HANDHELD_PATTERN.test(userAgent || '');
}
