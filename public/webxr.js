/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// WebXR Manager for VR/AR support (Quest 2, Viture Luma Ultra, etc.)

import { isInstalledApp } from './install.js';
import { isHandheldUA, isHeadsetBrowserUA } from './headset.mjs';

export function isHeadsetBrowser() {
  return isHeadsetBrowserUA(navigator.userAgent);
}

// Only Settings offers VR Mode on a handheld: the one-tap HUD button would sit
// under a thumb during play, and Cardboard support is not a headset. A desktop
// reports support only when a runtime is attached, so it counts as having one.
export function isHeadsetDevice() {
  return isHeadsetBrowser() || !isHandheldUA(navigator.userAgent);
}

// Quest treats the app-icon launch itself as the user activation requestSession
// demands, so an installed app can open immersive mode with no 2D landing page.
export function isHeadsetAppLaunch() {
  return isInstalledApp() && isHeadsetBrowser();
}

const XR_SESSION_FEATURES = { optionalFeatures: ['hand-tracking', 'local-floor'] };

// An app launched from its own icon is meant to be able to open an immersive
// session with no gesture of its own, but the headset does not necessarily hand
// the activation over at navigation: asked at 0.5s into the load, Quest reports
// `navigator.userActivation.hasBeenActive` still false. So ask once
// immediately, from a module that depends on almost nothing, and then again on
// each signal that could plausibly carry the grant, until one lands or the
// launch window closes. `startXRSession` adopts whichever session results.
export const XR_LAUNCH_SESSION_EVENT = 'webxrlaunchsession';
const LAUNCH_RETRY_EVENTS = ['load', 'focus', 'pageshow'];
const LAUNCH_WINDOW_MS = 15000;

let pendingLaunchSession = null;
let launchAttemptInFlight = false;
let launchSessionTaken = false;
let stopLaunchRetries = null;
let launchReport = 'skipped';

function describeActivation() {
  const activation = navigator.userActivation;
  return `${activation?.isActive}/${activation?.hasBeenActive}`;
}

function attemptLaunchSession(reason) {
  if (xrSession || launchAttemptInFlight || launchSessionTaken || pendingLaunchSession) return;
  launchAttemptInFlight = true;
  const activation = describeActivation();
  const attempt = navigator.xr.requestSession('immersive-vr', XR_SESSION_FEATURES)
    .then((session) => {
      launchReport = `granted on ${reason} (activation ${activation})`;
      debugLog('Launch session ' + launchReport);
      session.addEventListener('end', () => {
        pendingLaunchSession = null;
      }, { once: true });
      return session;
    })
    .catch((error) => {
      launchReport = `refused on ${reason} (activation ${activation}): ${error?.message || error}`;
      debugLog('Launch session ' + launchReport);
      return null;
    });

  pendingLaunchSession = attempt;
  void attempt.then((session) => {
    launchAttemptInFlight = false;
    if (!session) {
      // A promise that resolves to nothing must not read as a session in hand.
      pendingLaunchSession = null;
      return;
    }
    stopLaunchRetries?.();
    window.dispatchEvent(new window.CustomEvent(XR_LAUNCH_SESSION_EVENT));
  });
}

export function preflightHeadsetLaunch() {
  if (!navigator.xr || !isHeadsetAppLaunch()) return;

  const listener = (event) => attemptLaunchSession(event.type);
  const consumeLaunch = () => attemptLaunchSession('launchQueue');
  stopLaunchRetries = () => {
    stopLaunchRetries = null;
    for (const type of LAUNCH_RETRY_EVENTS) window.removeEventListener(type, listener);
    document.removeEventListener('visibilitychange', listener);
  };

  for (const type of LAUNCH_RETRY_EVENTS) window.addEventListener(type, listener);
  document.addEventListener('visibilitychange', listener);
  // The Launch Handler API reports the launch itself, which is the moment the
  // activation is meant to exist.
  window.launchQueue?.setConsumer?.(consumeLaunch);
  window.setTimeout(() => stopLaunchRetries?.(), LAUNCH_WINDOW_MS);

  attemptLaunchSession('load start');
}

async function takePendingLaunchSession() {
  if (!pendingLaunchSession) return null;
  const session = await pendingLaunchSession;
  pendingLaunchSession = null;
  if (session) {
    launchSessionTaken = true;
    stopLaunchRetries?.();
  }
  return session;
}

// Focusing a DOM text field during a session raises the headset's own keyboard
// where the runtime offers one, which is the only text entry an immersive
// session has short of a paired hardware keyboard.
export function isSystemKeyboardSupported() {
  return Boolean(xrSession?.isSystemKeyboardSupported);
}

let xrSession = null;
let xrSupported = false;
let xrEnabled = false;
let xrMode = null; // 'immersive-vr' or 'immersive-ar'
let xrInputSources = new Map(); // Map of controller input source ID -> controller state
let xrSessionLifecycle = null;
let xrStartPromise = null;
let xrEndPromise = null;

export const xrState = {
  enabled: false,
  isSupported: false,
  headPose: null, // { position: THREE.Vector3, quaternion: THREE.Quaternion }
  controllers: new Map(), // input source ID -> { pose, grip, select }
  frameCounter: 0,
};

export function getXRStateSnapshot() {
  return {
    enabled: Boolean(xrEnabled),
    isSupported: Boolean(xrSupported || xrState.isSupported),
    mode: xrMode,
    headPose: xrState.headPose,
    frameCounter: xrState.frameCounter,
  };
}

// Send debug message through app-wide logger in client.js
export function debugLog(message) {
  if (typeof window !== 'undefined' && typeof window.gameDebugLog === 'function') {
    window.gameDebugLog(message, 'WebXR');
  }
}

// Check if WebXR is available
async function checkXRSupport() {
  debugLog('Checking XR support... navigator.xr=' + (navigator.xr ? 'YES' : 'NO'));
  if (!navigator.xr) {
    debugLog('navigator.xr not available - WebXR not supported');
    return 'none';
  }

  try {
    // Try immersive-vr
    const vrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    if (vrSupported) {
      debugLog('immersive-vr (VR) supported');
      xrMode = 'immersive-vr';
      xrSupported = true;
      xrState.isSupported = true;
      return 'vr';
    }

    // Fall back to immersive-ar
    const arSupported = await navigator.xr.isSessionSupported('immersive-ar');
    if (arSupported) {
      debugLog('immersive-ar (AR) supported');
      xrMode = 'immersive-ar';
      xrSupported = true;
      xrState.isSupported = true;
      return 'ar';
    }

    debugLog('Neither immersive-ar nor immersive-vr supported');
    xrSupported = false;
    xrState.isSupported = false;
    return 'none';
  } catch (err) {
    debugLog('Failed to check support: ' + err.message);
    console.error('[WebXR] Full error:', err);
    return 'none';
  }
}

// Request and create XR session
async function requestXRSession(renderer, animationCallback) {
  debugLog('Requesting XR session, supported: ' + xrSupported);
  if (!xrSupported) {
    debugLog('WebXR not supported on this device');
    return false;
  }

  if (!renderer) {
    debugLog('ERROR: renderer is null or undefined');
    return false;
  }

  if (xrSession || xrStartPromise) {
    debugLog('XR session request ignored because a session is already active or starting');
    return Boolean(xrSession);
  }

  if (xrEndPromise) {
    await xrEndPromise;
  }

  const startPromise = startXRSession(renderer, animationCallback);
  xrStartPromise = startPromise;

  try {
    return await startPromise;
  } finally {
    if (xrStartPromise === startPromise) {
      xrStartPromise = null;
    }
  }
}

// The cadence to ask the runtime for. A Quest 2 offers 60/72/80/90/120 and,
// asked for nothing, reports `frameRate=0` -- it has picked one and is not
// saying which. That matters beyond curiosity: whatever it picked is the rate
// its compositor runs at, and a compositor at 90 or 120 reprojects a client
// delivering 30 three or four times over, on the same chip, in time that lands
// in `outside` where nothing can see it. 72 is the headset's own native rate
// and the one the fastest frames already reach.
//
// `?xrRate=90` overrides, because which rate is best here is a measurement
// rather than a guess, and test.html is where measurements are chosen from.
const XR_PREFERRED_FRAME_RATE = 72;

function readXRFrameRatePreference() {
  const raw = Number(new URLSearchParams(window.location.search).get('xrRate'));
  return Number.isFinite(raw) && raw > 0 ? raw : XR_PREFERRED_FRAME_RATE;
}

export function chooseTargetFrameRate(supported, preferred = XR_PREFERRED_FRAME_RATE) {
  const rates = Array.from(supported || []).filter((rate) => Number.isFinite(rate) && rate > 0);
  if (rates.length === 0) return null;
  if (rates.includes(preferred)) return preferred;
  // Nothing exactly right: the nearest, and the lower of two equally near, since
  // a rate the client cannot reach is worse than one it can.
  return rates.reduce((best, rate) => {
    const better = Math.abs(rate - preferred) - Math.abs(best - preferred);
    return better < 0 || (better === 0 && rate < best) ? rate : best;
  });
}

// How long to wait for the runtime to answer before saying it did not.
const XR_FRAME_RATE_REPORT_MS = 3000;

// Ask for a cadence and say what came back.
//
// **Never awaited, and never on the way in.** On a Quest, asked before the
// renderer had handed the session its layer, this promise simply never settled:
// the session was created, the startup awaited an answer that never came, and
// every later press of the button was refused with "already in progress". A
// measurement may report late, or not at all, but it may not decide whether the
// session starts. Hence the timeout as well -- silence is itself a result, and
// the line has to arrive either way.
//
// Both properties it reads are optional in the spec, so both may read unknown.
function applyTargetFrameRate(session) {
  const rates = session.supportedFrameRates;
  const supported = rates ? Array.from(rates).join('/') : 'unknown';
  const target = chooseTargetFrameRate(rates, readXRFrameRatePreference());

  if (target === null || typeof session.updateTargetFrameRate !== 'function') {
    debugLog(`session.frameRate=${session.frameRate ?? 'unknown'} supported=${supported} target=none`);
    return;
  }

  let answered = false;
  const report = (outcome) => {
    if (answered) return;
    answered = true;
    debugLog(
      `session.frameRate=${session.frameRate ?? 'unknown'}`
      + ` supported=${supported} target=${target} ${outcome}`
    );
  };

  window.setTimeout(() => report('no answer'), XR_FRAME_RATE_REPORT_MS);
  try {
    Promise.resolve(session.updateTargetFrameRate(target)).then(
      () => report('accepted'),
      (error) => report(`refused: ${error?.message || error}`),
    );
  } catch (error) {
    report(`refused: ${error?.message || error}`);
  }
}

async function startXRSession(renderer, animationCallback) {
  let session = null;

  try {
    session = await takePendingLaunchSession();
    if (session) {
      debugLog('Adopting the session requested at launch');
      xrMode = 'immersive-vr';
    } else {
      debugLog('About to call navigator.xr.requestSession with mode: ' + xrMode);
      session = await navigator.xr.requestSession(xrMode, XR_SESSION_FEATURES);
    }

    debugLog('XR session (mode=' + xrMode + ') created successfully');
    xrSession = session;
    xrSessionLifecycle = createXRSessionLifecycle(session, renderer);

    // Configure renderer for XR
    debugLog('Configuring renderer for XR...');
    renderer.xr.enabled = true;
    await renderer.xr.setSession(session);

    if (xrSessionLifecycle?.session !== session || xrSessionLifecycle.ended) {
      throw new Error('XR session ended before renderer setup completed');
    }

    xrEnabled = true;
    xrState.enabled = true;
    announceSessionChange();

    // Once the session is live and nothing is waiting on it.
    applyTargetFrameRate(session);

    // Set up the XR animation loop
    if (animationCallback) {
      debugLog('Setting XR animation loop...');
      renderer.xr.setAnimationLoop(animationCallback);
    }

    debugLog('XR session started successfully');
    return true;
  } catch (err) {
    debugLog('ERROR: Failed to create XR session: ' + err.message);
    if (session && xrSessionLifecycle?.session === session) {
      await endXRSession(session, { requestEnd: true, restoreLoop: false });
    } else {
      resetXRState();
    }
    return false;
  }
}

function createXRSessionLifecycle(session, renderer) {
  const lifecycle = {
    session,
    renderer,
    ended: false,
    endRequested: false,
    inputSourcesChangeHandler: null,
    visibilityChangeHandler: null,
    endHandler: null,
  };

  lifecycle.inputSourcesChangeHandler = event => {
    if (xrSessionLifecycle !== lifecycle) {
      return;
    }

    event.removed?.forEach(inputSource => {
      removeXRInputSource(inputSource);
    });
    event.added?.forEach(inputSource => {
      addXRInputSource(inputSource);
    });
  };

  lifecycle.visibilityChangeHandler = () => {
    if (xrSessionLifecycle !== lifecycle) {
      return;
    }

    if (session.visibilityState !== 'visible') {
      xrState.headPose = null;
      resetXRControllerStates();
      xrState.controllers.clear();
    }
  };

  lifecycle.endHandler = () => {
    if (xrSessionLifecycle !== lifecycle) {
      return;
    }

    lifecycle.ended = true;
    debugLog('XR session ended');
    void endXRSession(session, { requestEnd: false, restoreLoop: true });
  };

  session.addEventListener('inputsourceschange', lifecycle.inputSourcesChangeHandler);
  session.addEventListener('visibilitychange', lifecycle.visibilityChangeHandler);
  session.addEventListener('end', lifecycle.endHandler);
  setupXRInput(session);

  return lifecycle;
}

async function endXRSession(session = xrSession, { requestEnd = true, restoreLoop = false } = {}) {
  if (xrEndPromise) {
    return await xrEndPromise;
  }

  const lifecycle = xrSessionLifecycle?.session === session ? xrSessionLifecycle : null;
  if (lifecycle && !requestEnd) {
    lifecycle.ended = true;
  }

  const endPromise = Promise.resolve().then(async () => {
    if (requestEnd && lifecycle && !lifecycle.ended && !lifecycle.endRequested) {
      lifecycle.endRequested = true;
      try {
        await session.end();
      } catch (err) {
        debugLog('XR session end request failed: ' + err.message);
      }
    }

    cleanupXRSession(lifecycle, session);
    if (restoreLoop) {
      restoreNormalAnimationLoop();
    }
  });

  xrEndPromise = endPromise;
  try {
    await endPromise;
  } finally {
    if (xrEndPromise === endPromise) {
      xrEndPromise = null;
    }
  }
}

function cleanupXRSession(lifecycle, session) {
  if (lifecycle) {
    session.removeEventListener('inputsourceschange', lifecycle.inputSourcesChangeHandler);
    session.removeEventListener('visibilitychange', lifecycle.visibilityChangeHandler);
    session.removeEventListener('end', lifecycle.endHandler);

    if (typeof lifecycle.renderer?.setAnimationLoop === 'function') {
      lifecycle.renderer.setAnimationLoop(null);
    } else if (lifecycle.renderer?.xr) {
      lifecycle.renderer.xr.setAnimationLoop(null);
    }
  }

  if (!lifecycle || xrSessionLifecycle === lifecycle) {
    xrSession = null;
    xrSessionLifecycle = null;
    resetXRState();
  }
}

// A headset is a whole input surface arriving or leaving, and the things that
// answer to it -- the anaglyph row, the mouse steering row, the XR menu -- live
// in the client rather than here. One event carries the fact to all of them.
function announceSessionChange() {
  window.dispatchEvent(new window.CustomEvent('webxrsessionchange', {
    detail: { enabled: xrState.enabled, mode: xrMode },
  }));
}

function resetXRState() {
  xrEnabled = false;
  xrState.enabled = false;
  xrState.headPose = null;
  xrState.frameCounter = 0;
  xrInputSources.clear();
  xrState.controllers.clear();
  announceSessionChange();
}

// Store reference to reset animation loop
let normalAnimationCallback = null;

export function setNormalAnimationLoop(renderer, callback) {
  if (!renderer || typeof callback !== 'function') {
    normalAnimationCallback = null;
    return;
  }
  normalAnimationCallback = { renderer, callback };
}

// Restore normal animation loop after exiting XR
export function restoreNormalAnimationLoop() {
  if (normalAnimationCallback) {
    const { renderer, callback } = normalAnimationCallback;
    if (!renderer) {
      return;
    }
    if (typeof renderer.setAnimationLoop === 'function') {
      renderer.setAnimationLoop(callback);
    } else if (renderer.xr) {
      renderer.xr.setAnimationLoop(null); // Clear XR loop
      // Resume normal RAF when the renderer has no unified animation-loop API.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback);
      }
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
    }
  }
}

function createXRControllerState(inputSource) {
  return {
    inputSource,
    gamepad: null,
    thumbstick: { x: 0, y: 0 },
    trigger: 0,
    triggerPressed: false,
    grip: 0,
    buttonA: false,
    buttonB: false,
    buttonGrip: false,
    buttonThumbstick: false,
  };
}

function addXRInputSource(inputSource) {
  const handedness = inputSource?.handedness;
  if (!handedness) {
    return;
  }

  const controller = xrInputSources.get(handedness) || createXRControllerState(inputSource);
  controller.inputSource = inputSource;
  xrInputSources.set(handedness, controller);
}

function removeXRInputSource(inputSource) {
  const handedness = inputSource?.handedness;
  if (!handedness) {
    return;
  }

  const controller = xrInputSources.get(handedness);
  if (!controller || controller.inputSource === inputSource) {
    xrInputSources.delete(handedness);
    xrState.controllers.delete(handedness);
  }
}

function resetXRControllerState(controller) {
  controller.gamepad = null;
  controller.thumbstick.x = 0;
  controller.thumbstick.y = 0;
  controller.trigger = 0;
  controller.triggerPressed = false;
  controller.grip = 0;
  controller.buttonA = false;
  controller.buttonB = false;
  controller.buttonGrip = false;
  controller.buttonThumbstick = false;
}

function resetXRControllerStates() {
  xrInputSources.forEach(resetXRControllerState);
  xrState.controllers.forEach(resetXRControllerState);
}

function readThumbstickAxes(axes = [], preferredPair = [0, 1]) {
  const pairs = [preferredPair, [0, 1], [2, 3]];
  for (const [xIndex, yIndex] of pairs) {
    const xValue = axes[xIndex];
    const yValue = axes[yIndex];
    const hasX = Number.isFinite(xValue);
    const hasY = Number.isFinite(yValue);
    if (hasX || hasY) {
      return {
        x: hasX ? xValue : 0,
        y: hasY ? yValue : 0,
      };
    }
  }

  return { x: 0, y: 0 };
}

// Setup XR input (controllers)
function setupXRInput(session = xrSession) {
  if (!session) {
    return;
  }

  for (const inputSource of session.inputSources || []) {
    addXRInputSource(inputSource);
  }
}

// Update XR controller input each frame
export function updateXRControllerInput() {
  if (!xrSession || !xrEnabled) {
    return;
  }

  // The system keyboard and the headset's own menus report visible-blurred, and
  // neither should leave a stick or trigger driving the tank behind them.
  if (xrSession.visibilityState !== 'visible') {
    resetXRControllerStates();
    xrState.controllers.clear();
    return;
  }

  const frameCounter = xrState.frameCounter || 0;
  xrState.frameCounter = frameCounter + 1;
  const activeHandedness = new Set();
  xrState.controllers.clear();

  for (const inputSource of xrSession.inputSources || []) {
    const handedness = inputSource.handedness; // 'left' or 'right'
    if (!handedness) {
      continue;
    }
    activeHandedness.add(handedness);

    if (!xrInputSources.has(handedness)) {
      addXRInputSource(inputSource);
    }

    const controller = xrInputSources.get(handedness);
    resetXRControllerState(controller);
    controller.inputSource = inputSource;
    controller.gamepad = inputSource.gamepad;

    // Get thumbstick and trigger values from gamepad
    if (inputSource.gamepad) {
      const axes = inputSource.gamepad.axes || [];
      const buttons = inputSource.gamepad.buttons || [];

      if (buttons[0]) {
        controller.trigger = buttons[0].value;
        controller.triggerPressed = buttons[0].pressed || false;
      }
      if (buttons[1]) {
        controller.grip = buttons[1].value;
        controller.buttonGrip = buttons[1].pressed || false;
      }
      if (buttons[4]) {
        controller.buttonA = buttons[4].pressed || false;
      }
      if (buttons[5]) {
        controller.buttonB = buttons[5].pressed || false;
      }
      if (buttons[3]) {
        controller.buttonThumbstick = buttons[3].pressed || false;
      }

      // Left controller: thumbstick for movement (axes 0, 1)
      if (handedness === 'left') {
        const stick = readThumbstickAxes(axes, [0, 1]);
        controller.thumbstick.x = stick.x;
        controller.thumbstick.y = stick.y;
        if (frameCounter % 60 === 0) {
          debugLog(`Left: axes.length=${axes.length}, [0]=${axes[0]?.toFixed(2)}, [1]=${axes[1]?.toFixed(2)}`);
        }
      }

      // Right controller: thumbstick for rotation (axes 2, 3) and buttons for actions
      if (handedness === 'right') {
        const stick = readThumbstickAxes(axes, [2, 3]);
        controller.thumbstick.x = stick.x;
        controller.thumbstick.y = stick.y;

        if (frameCounter % 60 === 0) {
          debugLog(`Right: axes[2]=${axes[2]?.toFixed(2)}, axes[3]=${axes[3]?.toFixed(2)}, A=${controller.buttonA}, B=${controller.buttonB}, btnCount=${buttons.length}`);
        }
      }
    }

    xrState.controllers.set(handedness, controller);
  }

  for (const handedness of xrInputSources.keys()) {
    if (!activeHandedness.has(handedness)) {
      xrInputSources.delete(handedness);
    }
  }
}


// Get controller input for game
export function getXRControllerInput() {
  const input = {
    leftThumbstick: { x: 0, y: 0 },
    rightThumbstick: { x: 0, y: 0 },
    leftThumbstickPressed: false,
    rightThumbstickPressed: false,
    leftTrigger: 0,
    rightTrigger: 0,
    leftGrip: 0,
    rightGrip: 0,
    buttonA: false,
    buttonB: false,
    buttonGrip: false,
  };

  if (xrState.controllers.get('left')) {
    const leftController = xrState.controllers.get('left');
    input.leftThumbstick = { ...leftController.thumbstick };
    input.leftThumbstickPressed = leftController.buttonThumbstick || false;
    input.leftTrigger = leftController.trigger || 0;
    input.leftGrip = leftController.grip || 0;
    input.buttonA = input.buttonA || leftController.buttonA || false;
    input.buttonB = input.buttonB || leftController.buttonB || false;
    input.buttonGrip = input.buttonGrip || leftController.buttonGrip || false;
  }

  if (xrState.controllers.get('right')) {
    const rightController = xrState.controllers.get('right');
    input.rightThumbstick = { ...rightController.thumbstick };
    input.rightTrigger = rightController.trigger || 0;
    input.rightGrip = rightController.grip || 0;
    input.buttonA = input.buttonA || rightController.buttonA || false;
    input.buttonB = input.buttonB || rightController.buttonB || false;
    input.buttonGrip = input.buttonGrip || rightController.buttonGrip || false;
    input.rightThumbstickPressed = rightController.buttonThumbstick || false;
  }

  return input;
}

// Export API
export async function initXR() {
  // Settle the first request before reporting: it is the one attempt whose
  // outcome predates the debug channel.
  if (pendingLaunchSession) await pendingLaunchSession;
  debugLog('Launch session: ' + launchReport);
  const mode = await checkXRSupport();
  // A granted launch session is proof enough, whatever the support probe said.
  if (pendingLaunchSession) {
    xrMode = 'immersive-vr';
    xrSupported = true;
    xrState.isSupported = true;
    return 'vr';
  }
  return mode;
}

export async function toggleXRSession(renderer, animationCallback) {
  debugLog('toggleXRSession called, currently enabled: ' + xrEnabled);
  if (xrStartPromise) {
    debugLog('XR session start already in progress');
    return await xrStartPromise;
  }

  if (xrSession || xrEnabled || xrEndPromise) {
    debugLog('Ending XR session...');
    await endXRSession(xrSession, { requestEnd: true, restoreLoop: true });
    return false;
  } else {
    debugLog('Starting XR session...');
    return await requestXRSession(renderer, animationCallback);
  }
}

export function isXREnabled() {
  return getXRStateSnapshot().enabled;
}
