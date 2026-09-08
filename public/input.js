/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// input.js
// Handles keyboard, mouse, and touch input for the game.
// Exports: setupInputHandlers, virtualInput, keys

import { getXRControllerInput, xrState } from './webxr.js';
import { focusFirstDialogControl, getVisibleDialogRoot, handleDialogControllerInput, handleDialogKeydown, hideDialog, showDialog } from './menus.js';
import { initSettingsMenu } from './settings.js';
import { INPUT_CONTEXT, InputContextManager } from './input-context.mjs';

// Shared virtual input state exposed to the game loop.
export let virtualInput = { forward: 0, turn: 0, fire: false, jump: false, drop: false, identify: false };

// Keep each input source separate so one source cannot leave stale values in
// the shared state when another source starts or stops reporting input.
const touchInput = { forward: 0, turn: 0, fire: false, jump: false, drop: false, identify: false };
const gamepadInput = { forward: 0, turn: 0, fire: false, jump: false, drop: false, identify: false };
const xrInputState = { forward: 0, turn: 0, fire: false, jump: false, drop: false, identify: false };

// Right Mouse carries `identify` (ActionBinding.cxx:97). The mouse is not one of
// the three sources above -- it coexists with them rather than replacing one --
// so it is held separately and folded in, which is what lets a right click work
// with a gamepad plugged in.
let pointerIdentify = false;

// Keyboard input state
export const keys = {};

// Gamepad state
let gamepadConnected = false;
let gamepadIndex = -1;
let gamepadInfo = null;
let lastGamepadButtonState = { fire: false, jump: false, drop: false };
let gamepadFrameCounter = 0;
let gamepadListenersAttached = false;
let inputHandlersAttached = false;
let lifecycleListenersAttached = false;
let resetTouchState = () => {};
const gameplayInputResetHandlers = new Set();
let gamepadGameplayArmed = true;
let xrGameplayArmed = true;

function resetInputValues(inputState) {
  inputState.forward = 0;
  inputState.turn = 0;
  inputState.fire = false;
  inputState.jump = false;
  inputState.drop = false;
  inputState.identify = false;
}

function syncVirtualInput() {
  const source = xrState.enabled
    ? xrInputState
    : gamepadConnected
      ? gamepadInput
      : touchInput;
  virtualInput.forward = source.forward;
  virtualInput.turn = source.turn;
  virtualInput.fire = source.fire;
  virtualInput.jump = source.jump;
  virtualInput.drop = source.drop;
  virtualInput.identify = source.identify || pointerIdentify;
}

// Held, not an edge: a guided missile will lock while it is down, and the
// observer's roaming target already makes its own edge out of the hold.
export function setPointerIdentify(pressed) {
  pointerIdentify = Boolean(pressed);
  syncVirtualInput();
}

function resetGamepadInput() {
  resetInputValues(gamepadInput);
  lastGamepadButtonState = { fire: false, jump: false, drop: false };
  gamepadFrameCounter = 0;
  syncVirtualInput();
}

function resetXRInput() {
  resetInputValues(xrInputState);
  syncVirtualInput();
}

function clearKeyboardInput() {
  Object.keys(keys).forEach((code) => {
    keys[code] = false;
  });
}

function clearTransientInput() {
  clearKeyboardInput();
  pointerIdentify = false;
  resetInputValues(touchInput);
  resetGamepadInput();
  resetXRInput();
  resetTouchState();
  syncVirtualInput();
  gameplayInputResetHandlers.forEach((handler) => handler());
}

const inputContextManager = new InputContextManager({
  resetGameplayInput: clearTransientInput,
});

export function isGameplayInputActive() {
  return inputContextManager.isGameplayActive();
}

// A context that has a menu in front of the game. Every dialog bzo has, flat or
// in a headset, is one of these two: the same fact that stops move, fire and
// jump reaching the tank is what decides the tank should be paused.
export function isMenuContextActive() {
  const context = inputContextManager.getContext();
  return context === INPUT_CONTEXT.DIALOG || context === INPUT_CONTEXT.ENTRY;
}

export function setInputContext(context) {
  const changed = inputContextManager.setContext(context);
  if (changed) {
    gamepadGameplayArmed = false;
    xrGameplayArmed = false;
    hudContext.syncAutoPause();
  }
  return changed;
}

export function registerGameplayInputReset(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('Gameplay input reset handler must be a function');
  }
  gameplayInputResetHandlers.add(handler);
  return () => gameplayInputResetHandlers.delete(handler);
}

export function setGameplayKeyState(code, pressed) {
  if (pressed && !isGameplayInputActive()) return false;
  keys[code] = Boolean(pressed);
  return true;
}

function setupInputLifecycleListeners() {
  if (lifecycleListenersAttached) return;

  window.addEventListener('blur', clearTransientInput);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTransientInput();
  });
  lifecycleListenersAttached = true;
}

// Gamepad detection and event listeners
function setupGamepadListeners() {
  if (gamepadListenersAttached) return;

  // Listen for gamepad connections
  window.addEventListener('gamepadconnected', (e) => {
    console.log('[Gamepad] Connected:', e.gamepad.id);
    console.log('[Gamepad] Mapping:', e.gamepad.mapping);
    gamepadConnected = true;
    gamepadIndex = e.gamepad.index;
    gamepadInfo = {
      id: e.gamepad.id,
      buttons: e.gamepad.buttons.length,
      axes: e.gamepad.axes.length,
      mapping: e.gamepad.mapping,
    };
    resetGamepadInput();
    console.log('[Gamepad] Info:', gamepadInfo);
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    console.log('[Gamepad] Disconnected:', e.gamepad.id);
    if (e.gamepad.index === gamepadIndex) {
      gamepadConnected = false;
      gamepadIndex = -1;
      gamepadInfo = null;
      resetGamepadInput();
    }
  });

  // Initial check for already-connected gamepads
  const gamepads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i]) {
      console.log('[Gamepad] Found at startup:', gamepads[i].id);
      console.log('[Gamepad] Mapping:', gamepads[i].mapping);
      gamepadConnected = true;
      gamepadIndex = gamepads[i].index;
      gamepadInfo = {
        id: gamepads[i].id,
        buttons: gamepads[i].buttons.length,
        axes: gamepads[i].axes.length,
        mapping: gamepads[i].mapping,
      };
      console.log('[Gamepad] Info:', gamepadInfo);
      break;
    }
  }

  gamepadListenersAttached = true;
}

// Update virtualInput from gamepad state (called each frame)
export function updateVirtualInputFromGamepad() {
  if (!gamepadConnected || gamepadIndex < 0) return;

  if (typeof navigator.getGamepads !== 'function') {
    gamepadConnected = false;
    gamepadIndex = -1;
    gamepadInfo = null;
    resetGamepadInput();
    return;
  }

  const gamepads = navigator.getGamepads();
  const gamepad = gamepads[gamepadIndex];
  if (!gamepad) {
    gamepadConnected = false;
    gamepadIndex = -1;
    gamepadInfo = null;
    resetGamepadInput();
    return;
  }

  const axes = gamepad.axes;
  const buttons = gamepad.buttons;

  if (!isGameplayInputActive()) {
    handleDialogControllerInput({
      horizontal: axes[0] || 0,
      vertical: axes[1] || 0,
      activate: Boolean(buttons[0]?.pressed || buttons[7]?.pressed),
      back: Boolean(buttons[1]?.pressed || buttons[6]?.pressed),
    }, { dismissDialog: dismissVisibleDialog });
    resetInputValues(gamepadInput);
    syncVirtualInput();
    return;
  }

  if (!gamepadGameplayArmed) {
    const axesNeutral = Math.abs(axes[0] || 0) < 0.2 && Math.abs(axes[1] || 0) < 0.2;
    const buttonsNeutral = !buttons.some((button) => button?.pressed);
    if (!axesNeutral || !buttonsNeutral) {
      resetInputValues(gamepadInput);
      syncVirtualInput();
      return;
    }
    gamepadGameplayArmed = true;
  }

  // Apply deadzone to prevent drift
  const deadzone = 0.2;
  function applyDeadzone(value) {
    if (!Number.isFinite(value)) return 0;
    if (Math.abs(value) < deadzone) {
      return 0;
    }
    // Scale the remaining range to 0-1 for smoother control
    const sign = value > 0 ? 1 : -1;
    return sign * ((Math.abs(value) - deadzone) / (1 - deadzone));
  }

  // Standard gamepad mapping (most USB controllers and iOS MFi controllers):
  // Axes 0: Left stick X (turn left/right)
  // Axes 1: Left stick Y (forward/backward)
  // Axes 2: Right stick X (unused)
  // Axes 3: Right stick Y (unused)
  // Buttons 4/5: Shoulders (identify)
  // Button 0: A/X (fire)
  // Button 1: B/Circle (jump)
  // Button 2: X/Square (drop flag)
  // Button 6: Left trigger (alternative jump)
  // Button 7: Right trigger (alternative fire)

  if (axes.length >= 2) {
    // Left stick Y-axis: forward/backward (inverted because -1 is up)
    const axisY = axes[1];
    const axisX = axes[0];

    gamepadInput.forward = -applyDeadzone(axisY);
    gamepadInput.turn = -applyDeadzone(axisX);
  } else {
    // No axes available, reset to 0
    gamepadInput.forward = 0;
    gamepadInput.turn = 0;
  }

  // Fire button: A button (0) or right trigger (7)
  const firePressed = Boolean(
    (buttons[0] && buttons[0].pressed) ||
    (buttons[7] && buttons[7].pressed)
  );
  gamepadInput.fire = firePressed;

  // Jump button: B button (1) or left trigger (6)
  const jumpPressed = Boolean(
    (buttons[1] && buttons[1].pressed) ||
    (buttons[6] && buttons[6].pressed)
  );
  gamepadInput.jump = jumpPressed;

  // Drop button: X/Square (2). A already fires here, so drop takes the spare
  // face button rather than the primary one it uses in XR.
  const dropPressed = Boolean(buttons[2] && buttons[2].pressed);
  gamepadInput.drop = dropPressed;

  // Identify: either shoulder (4/5), the only pair left once the face buttons
  // and triggers are spent.
  gamepadInput.identify = Boolean(buttons[4]?.pressed || buttons[5]?.pressed);

  // Track button state changes
  lastGamepadButtonState.fire = firePressed;
  lastGamepadButtonState.jump = jumpPressed;
  lastGamepadButtonState.drop = dropPressed;
  syncVirtualInput();

  // Debug logging every 120 frames (every 2 seconds at 60fps)
  gamepadFrameCounter++;
  if (gamepadFrameCounter % 120 === 0) {
    // Log active axes and buttons
    const activeAxes = [];
    for (let i = 0; i < axes.length; i++) {
      if (Math.abs(axes[i]) > 0.01) {
        activeAxes.push(`Axis${i}=${axes[i].toFixed(2)}`);
      }
    }
    const activeButtons = [];
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i].pressed) {
        activeButtons.push(`Btn${i}`);
      }
    }
    if (activeAxes.length > 0 || activeButtons.length > 0) {
      console.log('[Gamepad] Active:', activeAxes.join(', '), activeButtons.join(', '));
      console.log('[Gamepad] virtualInput:', `forward=${gamepadInput.forward.toFixed(2)}, turn=${gamepadInput.turn.toFixed(2)}, fire=${gamepadInput.fire}, jump=${gamepadInput.jump}`);
    }
  }
}

// Get gamepad connection status
export function isGamepadConnected() {
  return gamepadConnected;
}

// Get gamepad info
export function getGamepadInfo() {
  return gamepadInfo;
}

// Setup all input event listeners
export function setupInputHandlers() {
  if (inputHandlersAttached) return;
  inputHandlersAttached = true;

  // Setup gamepad detection
  setupGamepadListeners();
  setupInputLifecycleListeners();

  // Touch/virtual joystick
  const joystick = document.getElementById('joystick');
  const knob = document.getElementById('joystickKnob');
  const fireBtn = document.getElementById('fireBtn');
  const jumpBtn = document.getElementById('jumpBtn');
  const dropBtn = document.getElementById('dropBtn');
  const identifyBtn = document.getElementById('identifyBtn');
  let joystickActive = false;
  let joystickTouchId = null;
  let joystickCenter = { x: 0, y: 0 };
  let setFirePressed = () => {};
  let setJumpPressed = () => {};
  function setJoystick(x, y) {
    const mag = Math.sqrt(x * x + y * y);
    if (mag > 1) { x /= mag; y /= mag; }
    touchInput.forward = -y;
    touchInput.turn = -x;
    syncVirtualInput();
    if (knob) knob.style.transform = `translate(${x * 35}px, ${y * 35}px)`;
  }
  function handleJoystickStart(e) {
    if (!isGameplayInputActive()) return;
    if (e.touches && e.touches.length > 0) {
      for (let i = 0; i < e.touches.length; i++) {
        const touch = e.touches[i];
        const rect = joystick.getBoundingClientRect();
        if (
          touch.clientX >= rect.left && touch.clientX <= rect.right &&
          touch.clientY >= rect.top && touch.clientY <= rect.bottom
        ) {
          joystickActive = true;
          joystickTouchId = touch.identifier;
          joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          handleJoystickMove(e);
          e.preventDefault();
          break;
        }
      }
    } else {
      joystickActive = true;
      joystickTouchId = null;
      const rect = joystick.getBoundingClientRect();
      joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      handleJoystickMove(e);
      e.preventDefault();
    }
  }
  function handleJoystickMove(e) {
    if (!isGameplayInputActive() || !joystickActive) return;
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      let found = false;
      for (let i = 0; i < e.touches.length; i++) {
        const touch = e.touches[i];
        if (touch.identifier === joystickTouchId) {
          clientX = touch.clientX;
          clientY = touch.clientY;
          found = true;
          break;
        }
      }
      if (!found) return;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const dx = clientX - joystickCenter.x;
    const dy = clientY - joystickCenter.y;
    setJoystick(dx / 60, dy / 60);
    e.preventDefault();
  }
  function handleJoystickEnd(e) {
    if (e.changedTouches && e.changedTouches.length > 0) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === joystickTouchId) {
          joystickActive = false;
          joystickTouchId = null;
          setJoystick(0, 0);
          e.preventDefault();
          break;
        }
      }
    } else {
      joystickActive = false;
      joystickTouchId = null;
      setJoystick(0, 0);
      e.preventDefault();
    }
  }
  resetTouchState = () => {
    joystickActive = false;
    joystickTouchId = null;
    setJoystick(0, 0);
    touchInput.fire = false;
    touchInput.jump = false;
    setFirePressed(false);
    setJumpPressed(false);
    syncVirtualInput();
  };
  if (joystick) {
    joystick.addEventListener('touchstart', handleJoystickStart);
    joystick.addEventListener('touchmove', handleJoystickMove);
    joystick.addEventListener('touchend', handleJoystickEnd);
    joystick.addEventListener('touchcancel', handleJoystickEnd);
    joystick.addEventListener('mousedown', handleJoystickStart);
    window.addEventListener('mousemove', handleJoystickMove);
    window.addEventListener('mouseup', handleJoystickEnd);
  }
  if (fireBtn) {
    setFirePressed = (pressed) => {
      if (pressed) fireBtn.classList.add('pressed');
      else fireBtn.classList.remove('pressed');
    };
    fireBtn.addEventListener('touchstart', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.fire = true; syncVirtualInput(); setFirePressed(true); });
    fireBtn.addEventListener('touchend', e => { e.preventDefault(); touchInput.fire = false; syncVirtualInput(); setFirePressed(false); });
    fireBtn.addEventListener('mousedown', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.fire = true; syncVirtualInput(); setFirePressed(true); });
    fireBtn.addEventListener('mouseup', e => { e.preventDefault(); touchInput.fire = false; syncVirtualInput(); setFirePressed(false); });
    fireBtn.addEventListener('mouseleave', () => { touchInput.fire = false; syncVirtualInput(); setFirePressed(false); });
    fireBtn.addEventListener('touchcancel', () => { touchInput.fire = false; syncVirtualInput(); setFirePressed(false); });
  }
  if (jumpBtn) {
    setJumpPressed = (pressed) => {
      if (pressed) jumpBtn.classList.add('pressed');
      else jumpBtn.classList.remove('pressed');
    };
    jumpBtn.addEventListener('touchstart', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.jump = true; syncVirtualInput(); setJumpPressed(true); });
    jumpBtn.addEventListener('touchend', e => { e.preventDefault(); touchInput.jump = false; syncVirtualInput(); setJumpPressed(false); });
    jumpBtn.addEventListener('mousedown', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.jump = true; syncVirtualInput(); setJumpPressed(true); });
    jumpBtn.addEventListener('mouseup', e => { e.preventDefault(); touchInput.jump = false; syncVirtualInput(); setJumpPressed(false); });
    jumpBtn.addEventListener('mouseleave', () => { touchInput.jump = false; syncVirtualInput(); setJumpPressed(false); });
    jumpBtn.addEventListener('touchcancel', () => { touchInput.jump = false; syncVirtualInput(); setJumpPressed(false); });
  }
  if (dropBtn) {
    const setDropPressed = (pressed) => {
      if (pressed) dropBtn.classList.add('pressed');
      else dropBtn.classList.remove('pressed');
    };
    dropBtn.addEventListener('touchstart', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.drop = true; syncVirtualInput(); setDropPressed(true); });
    dropBtn.addEventListener('touchend', e => { e.preventDefault(); touchInput.drop = false; syncVirtualInput(); setDropPressed(false); });
    dropBtn.addEventListener('mousedown', e => { e.preventDefault(); if (!isGameplayInputActive()) return; touchInput.drop = true; syncVirtualInput(); setDropPressed(true); });
    dropBtn.addEventListener('mouseup', e => { e.preventDefault(); touchInput.drop = false; syncVirtualInput(); setDropPressed(false); });
    dropBtn.addEventListener('mouseleave', () => { touchInput.drop = false; syncVirtualInput(); setDropPressed(false); });
    dropBtn.addEventListener('touchcancel', () => { touchInput.drop = false; syncVirtualInput(); setDropPressed(false); });
  }
  if (identifyBtn) {
    const setIdentifyPressed = (pressed) => {
      if (pressed) identifyBtn.classList.add('pressed');
      else identifyBtn.classList.remove('pressed');
    };
    const holdIdentify = (pressed) => { touchInput.identify = pressed; syncVirtualInput(); setIdentifyPressed(pressed); };
    identifyBtn.addEventListener('touchstart', e => { e.preventDefault(); if (!isGameplayInputActive()) return; holdIdentify(true); });
    identifyBtn.addEventListener('touchend', e => { e.preventDefault(); holdIdentify(false); });
    identifyBtn.addEventListener('mousedown', e => { e.preventDefault(); if (!isGameplayInputActive()) return; holdIdentify(true); });
    identifyBtn.addEventListener('mouseup', e => { e.preventDefault(); holdIdentify(false); });
    identifyBtn.addEventListener('mouseleave', () => holdIdentify(false));
    identifyBtn.addEventListener('touchcancel', () => holdIdentify(false));
  }

}

export function updateVirtualInputFromXR() {
  if (!xrState.enabled) {
    resetXRInput();
    return;
  }

  const controllerInput = getXRControllerInput();
  const leftThumbstick = controllerInput.leftThumbstick || { x: 0, y: 0 };
  const rightThumbstick = controllerInput.rightThumbstick || { x: 0, y: 0 };

  if (!isGameplayInputActive()) {
    const navigationStick = Math.abs(rightThumbstick.y || 0) >= Math.abs(leftThumbstick.y || 0)
      ? rightThumbstick
      : leftThumbstick;
    handleDialogControllerInput({
      horizontal: navigationStick.x || 0,
      vertical: navigationStick.y || 0,
      activate: controllerInput.leftTrigger > 0.5 || controllerInput.rightTrigger > 0.5 || controllerInput.buttonA,
      back: controllerInput.buttonB || controllerInput.buttonGrip,
    }, { dismissDialog: dismissVisibleDialog });
    resetInputValues(xrInputState);
    syncVirtualInput();
    return;
  }


  if (!xrGameplayArmed) {
    const sticksNeutral = Math.abs(leftThumbstick.x || 0) < 0.15 &&
      Math.abs(leftThumbstick.y || 0) < 0.15 &&
      Math.abs(rightThumbstick.x || 0) < 0.15 &&
      Math.abs(rightThumbstick.y || 0) < 0.15;
    const buttonsNeutral = controllerInput.rightTrigger <= 0.5 &&
      controllerInput.leftTrigger <= 0.5 &&
      !controllerInput.buttonA &&
      !controllerInput.buttonB &&
      !controllerInput.buttonGrip;
    if (!sticksNeutral || !buttonsNeutral) {
      resetInputValues(xrInputState);
      syncVirtualInput();
      return;
    }
    xrGameplayArmed = true;
  }

  const deadzone = 0.15;
  const applyDeadzone = (value) => {
    if (!Number.isFinite(value) || Math.abs(value) < deadzone) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * ((Math.abs(value) - deadzone) / (1 - deadzone));
  };

  const leftX = applyDeadzone(leftThumbstick.x || 0);
  const leftY = applyDeadzone(leftThumbstick.y || 0);
  const rightX = applyDeadzone(rightThumbstick.x || 0);
  const rightY = applyDeadzone(rightThumbstick.y || 0);

  // Right-stick-primary locomotion for Quest ergonomics.
  const forwardAxis = Math.abs(rightY) > 0 ? rightY : leftY;
  const newForward = -forwardAxis;
  xrInputState.forward = newForward;

  // Prefer right-stick X for turning, with left-stick X fallback.
  xrInputState.turn = -(Math.abs(rightX) > 0 ? rightX : leftX);

  // Either trigger: fire. The primary face button is the drop-flag key here,
  // matching the keyboard, so firing is the trigger alone.
  xrInputState.fire = controllerInput.leftTrigger > 0.5 || controllerInput.rightTrigger > 0.5;

  // Side grip button: jump. Nothing else claims it, so grip carries this alone.
  xrInputState.jump = controllerInput.buttonGrip;

  // A button: drop the carried flag
  xrInputState.drop = controllerInput.buttonA;

  // Pressing a thumbstick: identify, which picks the roaming target for an
  // observer and will lock a guided missile for a tank. The stick is under a
  // thumb that is already steering, so it gets pressed by accident -- which is
  // why the harmless action is the one behind it, and the menu moved to B.
  // Merged across both controllers by getXRControllerInput, so either hand
  // works.
  xrInputState.identify = Boolean(
    controllerInput.leftThumbstickPressed || controllerInput.rightThumbstickPressed
  );
  syncVirtualInput();
}

// --- HUD & Orientation helpers ---

export const latestOrientation = {
  alpha: null,
  beta: null,
  gamma: null,
  status: '',
};

const defaultHudContext = {
  isMobile: false,
  // Roaming replaces the player's camera modes: a first/third/overview cycle
  // does nothing for an observer, which has no tank to look at.
  isObserver: () => false,
  cycleObserverView: () => {},
  getObserverViewLabel: () => '',
  showMessage: () => {},
  updateHudButtons: () => {},
  toggleDebugHud: () => {},
  updateDebugDisplay: () => {},
  getDebugEnabled: () => false,
  setDebugEnabled: () => {},
  getDebugState: () => ({}),
  getCameraMode: () => 'first-person',
  setCameraMode: () => {},
  getMouseControlEnabled: () => false,
  setMouseControlEnabled: () => {},
  getVirtualControlsEnabled: () => false,
  setVirtualControlsEnabled: () => {},
  resetMouseSteering: () => {},
  pushChatMessage: () => {},
  updateChatWindow: () => {},
  sendToServer: () => {},
  cycleRadarZoom: () => {},
  getScene: () => null,
  toggleEntryDialog: () => {},
  getChatInput: () => null,
  handleGameplayKeydown: () => false,
  syncAutoPause: () => {},
};

let hudContext = { ...defaultHudContext };

const domRefs = {
  operatorOverlay: null,
  virtualControlsBtn: null,
  controlsOverlay: null,
  mouseBtn: null,
  fullscreenBtn: null,
  debugBtn: null,
  cameraBtn: null,
  helpBtn: null,
  playerOptionsBtn: null,
  settingsBtn: null,
  settingsHud: null,
  audioBtn: null,
  audioOverlay: null,
  helpPanel: null,
  closeSettingsBtn: null,
  closeSettingsTitleBtn: null,
  closeHelpBtn: null,
  operatorBtn: null,
  closeOperatorBtn: null,
  closeAudioBtn: null,
  wireframeBtn: null,
  playerLabelEl: null,
  voicePermissionBtn: null,
  voiceMicrophoneBtn: null,
};

let wireframeEnabled = false;
let keyboardListenerAttached = false;
let orientationDebugInitialized = false;
let settingsMenu = null;
const XR_SETTINGS_EXCLUDED_IDS = new Set([
  'xrBtn',
  'closeSettingsHud',
]);

function isEditableElement(element) {
  return Boolean(element && (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable
  ));
}

function isOperatorPanelVisible() {
  if (!domRefs.operatorOverlay) return false;
  return window.getComputedStyle(domRefs.operatorOverlay).display !== 'none';
}

function callOptionalHudCallback(names, ...args) {
  for (const name of names) {
    if (typeof hudContext[name] !== 'function') continue;
    hudContext[name](...args);
    return true;
  }
  return false;
}

// Every key gameplay consumes, by `event.code`, so the browser can be told to
// keep its hands off while the game has the keyboard.
//
// Some of these have a default that actively breaks play: Tab walks focus onto
// the HUD buttons, where Space then presses one instead of firing; Firefox
// opens quick find on / and swallows everything after it; the arrows and the
// Page keys scroll. The rest have no default worth naming today -- which is
// exactly what quick find looked like until someone played in Firefox.
const GAMEPLAY_OWNED_KEYS = new Set([
  // Drive and turn
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  // Fire, jump, self-destruct, pause. Enter would otherwise press whichever HUD
  // button holds focus, and the space bar is claimed though nothing is bound to
  // it yet: it is upstream's drop-flag key, and unclaimed it presses buttons.
  'Enter', 'Space', 'Tab', 'KeyQ', 'KeyP',
  // Chat and its tabs
  'KeyN', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'BracketLeft', 'BracketRight', 'Period', 'Comma',
  'PageUp', 'PageDown', 'End',
  // View, HUD, radar, help
  'KeyM', 'KeyC', 'KeyO', 'KeyF', 'Backquote', 'KeyB', 'KeyI',
  'Slash', 'Backslash', 'Minus', 'Equal', 'NumpadAdd', 'NumpadSubtract',
  // Not a binding: Firefox opens its link quick-find on an apostrophe and eats
  // the keyboard until dismissed, which from inside a tank looks like a freeze.
  'Quote',
]);

// A browser or OS shortcut is never ours: Ctrl+W, Cmd+Q, Alt+Left and the rest
// pass straight through, whatever key they are built on.
function isGameplayOwnedKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return GAMEPLAY_OWNED_KEYS.has(event.code);
}

function isMobileBrowser() {
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  const isIpad = (
    navigator.platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1
  ) || /iPad/.test(ua);
  return Boolean(isIpad);
}

export const isMobile = isMobileBrowser();

// A mouse is a capability, not a platform. `isMobile` is a user-agent guess and
// a phone with a mouse paired to it steers exactly as a desktop does, so the
// question is put to the browser instead: `any-pointer: fine` is its word for
// "something here points precisely". The query is live, so plugging a mouse into
// a phone lights the row up without a reload -- the same reason `available()` is
// re-read on every refresh rather than sampled once.
const finePointerQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(any-pointer: fine)')
  : null;

// A mouse that has actually moved is proof no media query can outrank, and the
// query does get it wrong: headless Chrome has no input devices attached and
// answers `false` on a machine with a mouse on the desk. A false negative would
// take steering away with nothing to override it, so a real mouse event latches
// the answer on for good. `pointerType` is what separates a mouse from a finger
// here -- a touch produces mouse events too, but never a mouse pointer.
let sawMousePointer = false;

function hasFinePointer() {
  return sawMousePointer || (finePointerQuery ? finePointerQuery.matches : true);
}

function watchForMousePointer() {
  const noteMousePointer = (event) => {
    if (event.pointerType !== 'mouse' || sawMousePointer) return;
    sawMousePointer = true;
    window.removeEventListener('pointermove', noteMousePointer);
    window.removeEventListener('pointerdown', noteMousePointer);
    refreshHudButtons();
  };
  window.addEventListener('pointermove', noteMousePointer, { passive: true });
  window.addEventListener('pointerdown', noteMousePointer, { passive: true });
}

// Whether the mouse can steer here at all, which is a different question from
// whether the player has asked it to. The stored preference survives a context
// that cannot honour it and comes back when the context does.
export function isMouseSteeringAvailable() {
  if (xrState.enabled) return false;
  if (hudContext.getVirtualControlsEnabled()) return false;
  return hasFinePointer();
}

// Why the row is dead, for the title and for the player who presses M anyway.
export function mouseSteeringUnavailableReason() {
  if (xrState.enabled) return 'Mouse steering is unavailable in VR: there is no cursor to read';
  if (hudContext.getVirtualControlsEnabled()) return 'Virtual controls steer instead of the mouse';
  return 'Mouse steering needs a mouse attached';
}

function setupMobileOrientationDebug() {
  if (orientationDebugInitialized) return;
  orientationDebugInitialized = true;
  if (!hudContext.isMobile) {
    latestOrientation.status = 'Desktop device';
    return;
  }
  function handleOrientation(event) {
    const { alpha, beta, gamma } = event;
    latestOrientation.alpha = alpha;
    latestOrientation.beta = beta;
    latestOrientation.gamma = gamma;
    latestOrientation.status = 'OK';
  }

  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(permissionState => {
        if (permissionState === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation);
          latestOrientation.status = 'Permission granted';
        } else {
          latestOrientation.status = 'Permission denied';
        }
      })
      .catch(err => {
        latestOrientation.status = `Permission error: ${err}`;
      });
  } else {
    window.addEventListener('deviceorientation', handleOrientation);
    latestOrientation.status = 'Listener attached';
  }
}

function stopPropagationForHud(ids, preventDefault = true) {
  ids.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    ['click', 'mousedown', 'mouseup'].forEach((evt) => {
      element.addEventListener(evt, (e) => {
        e.stopPropagation();
        if (preventDefault) e.preventDefault();
      });
    });
  });
}

// Every HUD button re-read from the state that owns it. Exported because the
// client has the same job to do from its own events -- a headset arriving, the
// debug HUD toggling -- and a second copy of the argument list is a second
// chance for the mouse row's gate to be left out of one of them.
export function refreshHudButtons() {
  if (typeof hudContext.updateHudButtons !== 'function') return;
  const mouseAvailable = isMouseSteeringAvailable();
  hudContext.updateHudButtons({
    mouseBtn: domRefs.mouseBtn,
    mouseControlEnabled: hudContext.getMouseControlEnabled() && mouseAvailable,
    mouseAvailable,
    mouseUnavailableTitle: mouseSteeringUnavailableReason(),
    debugBtn: domRefs.debugBtn,
    debugEnabled: hudContext.getDebugEnabled(),
    fullscreenBtn: domRefs.fullscreenBtn,
    cameraBtn: domRefs.cameraBtn,
    cameraMode: hudContext.isObserver() ? hudContext.getObserverViewLabel() : hudContext.getCameraMode(),
  });
  settingsMenu?.refresh();
}

// Left and right on a settings row, for the flat menu and the XR panel alike.
// Up and down are what move between rows, so nothing here walks off the row it
// was given.
//
//   choice   left steps back, right steps forward
//   toggle   either direction flips it -- an on/off row is a two-item choice,
//            and a two-item list cycles the same way whichever way it is pushed
//   submenu  right opens it; the row already reads "Open >"
//   action   neither; it is Enter, a trigger or a tap
//
// Returns whether the row took the press.
export function adjustSettingsMenuRow(id, direction) {
  const item = settingsMenu?.items.find((candidate) => candidate.id === id);
  if (!item || item.button.disabled) return false;

  if (item.kind === 'choice') {
    if (item.id === 'cameraBtn') {
      cycleCameraMode(direction);
      return true;
    }
    if (item.id === 'radarZoomBtn') {
      hudContext.cycleRadarZoom(direction);
      return true;
    }
    return false;
  }

  if (item.kind === 'toggle') {
    item.button.click();
    return true;
  }

  if (item.kind === 'submenu') {
    if (direction > 0) item.button.click();
    return true;
  }

  return false;
}

function getSettingsMenuValue(id, item) {
  if (id === 'cameraBtn') {
    return hudContext.isObserver()
      ? hudContext.getObserverViewLabel()
      : cameraModeLabel(hudContext.getCameraMode());
  }
  if (id === 'radarZoomBtn') {
    const match = item.button.title.match(/Radar range preset:\s*(.+)/i);
    return match?.[1] || 'Medium';
  }
  if (id === 'fullscreenBtn') return document.fullscreenElement ? 'On' : 'Off';
  if (id === 'wireframeBtn') return wireframeEnabled ? 'On' : 'Off';
  if (id === 'installBtn') {
    const state = item.button.dataset.installState;
    if (state === 'installed') return 'Installed';
    return state === 'available' ? 'Install' : 'Browser menu';
  }
  if (id === 'xrBtn') {
    if (item.button.disabled) return 'Unavailable';
    return /exit/i.test(item.button.title) ? 'Exit VR' : 'Enter VR';
  }
  if (item.kind === 'toggle') {
    if (item.button.disabled) return 'Unavailable';
    return item.button.classList.contains('active') ? 'On' : 'Off';
  }
  if (item.kind === 'submenu') return 'Open >';
  if (id === 'closeSettingsHud') return '';
  return 'Activate';
}

export function getXRSettingsMenuItems() {
  const items = settingsMenu?.items || [];
  return [
    { id: 'exitXR', label: 'Exit VR', value: '' },
    ...items
      .filter((item) => !XR_SETTINGS_EXCLUDED_IDS.has(item.id))
      .map((item) => ({
        id: item.id,
        label: item.label,
        value: getSettingsMenuValue(item.id, item),
        disabled: item.button.disabled,
      })),
    { id: 'closeXRMenu', label: 'Close', value: '' },
  ];
}

// Capabilities can appear after the menu is built -- the browser decides when a
// page becomes installable -- so the owning module refreshes the row itself.
export function refreshSettingsMenu() {
  settingsMenu?.refresh();
}

export function activateXRSettingsMenuItem(id) {
  const item = settingsMenu?.items.find((candidate) => candidate.id === id);
  if (!item || item.button.disabled) return false;
  item.button.click();
  settingsMenu.refresh();
  return true;
}

function setWireframeMode(enabled) {
  const scene = hudContext.getScene();
  if (!scene) return;
  scene.traverse((obj) => {
    if (obj.isMesh && obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((mat) => { if (mat) mat.wireframe = enabled; });
      } else {
        obj.material.wireframe = enabled;
      }
    }
  });
  wireframeEnabled = enabled;
  if (domRefs.wireframeBtn) {
    domRefs.wireframeBtn.classList.toggle('active', enabled);
  }
  // Same reason as toggleVirtualControls: the button's handler stops the click,
  // so the settings menu only learns the new state if it is told.
  refreshHudButtons();
}

function updateSettingsBtn() {
  if (!domRefs.settingsBtn || !domRefs.settingsHud) return;
  const visible = domRefs.settingsHud.style.display === 'block';
  domRefs.settingsBtn.classList.toggle('active', visible);
  domRefs.settingsBtn.title = visible ? 'Hide Settings' : 'Show Settings';
}

function toggleSettingsHud() {
  if (!domRefs.settingsHud) return;
  const visible = domRefs.settingsHud.style.display === 'block';
  if (visible) {
    hideDialog(domRefs.settingsHud);
  } else {
    setInputContext(INPUT_CONTEXT.DIALOG);
    settingsMenu?.refresh();
    showDialog(domRefs.settingsHud);
  }
  if (visible) syncInputContextFromUi();
  hudContext.showMessage(visible ? 'Settings: Hidden' : 'Settings: Shown');
  updateSettingsBtn();
}

export function openSettingsDialog() {
  if (!domRefs.settingsHud || domRefs.settingsHud.style.display === 'block') return;
  toggleSettingsHud();
}

export function closeSettingsDialog() {
  if (!domRefs.settingsHud || domRefs.settingsHud.style.display !== 'block') return;
  toggleSettingsHud();
}

function hideSettingsHudSilently() {
  if (!domRefs.settingsHud) return;
  if (domRefs.settingsHud.style.display === 'block') {
    hideDialog(domRefs.settingsHud, { restoreFocus: false });
    updateSettingsBtn();
  }
}

function updateAudioBtn() {
  if (!domRefs.audioBtn || !domRefs.audioOverlay) return;
  const visible = domRefs.audioOverlay.style.display === 'block';
  domRefs.audioBtn.classList.toggle('active', visible);
  domRefs.audioBtn.title = visible ? 'Hide Audio Settings' : 'Open Audio Settings';
}

function toggleAudioOverlay() {
  if (!domRefs.audioOverlay) return;
  const visible = domRefs.audioOverlay.style.display === 'block';
  if (visible) {
    hideDialog(domRefs.audioOverlay);
    syncInputContextFromUi();
    hudContext.showMessage('Audio Settings: Hidden');
  } else {
    hideSettingsHudSilently();
    setInputContext(INPUT_CONTEXT.DIALOG);
    showDialog(domRefs.audioOverlay);
    hudContext.showMessage('Audio Settings: Shown');
  }
  updateAudioBtn();
}

function updateHelpBtn() {
  if (!domRefs.helpBtn || !domRefs.helpPanel) return;
  const visible = domRefs.helpPanel.style.display === 'block';
  domRefs.helpBtn.classList.toggle('active', visible);
  domRefs.helpBtn.title = visible ? 'Hide Help (?)' : 'Show Help (?)';
}

function toggleHelpPanel() {
  if (!domRefs.helpPanel) return;
  const visible = domRefs.helpPanel.style.display === 'block';
  if (visible) {
    hideDialog(domRefs.helpPanel);
    syncInputContextFromUi();
    hudContext.showMessage('Help Panel: Hidden');
  } else {
    hideSettingsHudSilently();
    setInputContext(INPUT_CONTEXT.DIALOG);
    showDialog(domRefs.helpPanel);
    hudContext.showMessage('Help Panel: Shown');
  }
  updateHelpBtn();
}

function isFullscreenActive() {
  return document.fullscreenElement ||
         document.webkitFullscreenElement ||
         document.mozFullScreenElement;
}

function enterFullscreen() {
  // iOS has no Fullscreen API in Safari; installing the app is the only way to
  // lose the browser chrome there.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  if (isIOS && window.navigator.standalone !== true) {
    hudContext.pushChatMessage('💡 iOS: Use "Share" → "Add to Home Screen" for fullscreen');
    hudContext.updateChatWindow();
    return false;
  }

  const elem = document.documentElement;
  const request = elem.requestFullscreen ||
                 elem.webkitRequestFullscreen ||
                 elem.webkitEnterFullscreen ||
                 elem.mozRequestFullScreen;

  if (!request) {
    hudContext.pushChatMessage('⚠️ Fullscreen not supported');
    hudContext.updateChatWindow();
    return false;
  }

  try {
    if (request === elem.webkitRequestFullscreen) {
      request.call(elem, Element.ALLOW_KEYBOARD_INPUT);
    } else {
      request.call(elem);
    }
    return true;
  } catch (e) {
    console.warn('Fullscreen request failed:', e);
    hudContext.pushChatMessage('⚠️ Fullscreen not supported');
    hudContext.updateChatWindow();
    return false;
  }
}

function leaveFullscreen() {
  const exit = document.exitFullscreen ||
             document.webkitExitFullscreen ||
             document.webkitCancelFullScreen ||
             document.mozCancelFullScreen;

  if (!exit) return;
  try {
    exit.call(document);
  } catch (e) {
    console.warn('Fullscreen exit failed:', e);
  }
}

function toggleFullscreen() {
  if (isFullscreenActive()) {
    leaveFullscreen();
  } else {
    enterFullscreen();
  }

  setTimeout(() => {
    const message = `Screen resolution: ${window.innerWidth}x${window.innerHeight}`;
    hudContext.pushChatMessage(message);
    hudContext.updateChatWindow();
  }, 200);
  setTimeout(refreshHudButtons, 100);
}

// BZFlag remembers the player's display preference between runs. Track the real
// fullscreen state rather than the toggle, so leaving with Escape is remembered
// too. F11 is browser chrome rather than the Fullscreen API and does not reach
// this event, which is correct: it is not a preference the game set.
function rememberFullscreenPreference() {
  try {
    localStorage.setItem('fullscreenEnabled', isFullscreenActive() ? 'true' : 'false');
  } catch {
    /* ignore storage errors */
  }
}

// Fullscreen cannot be entered on load: browsers require transient user
// activation, and no manifest setting overrides that. Restoring on the first
// gesture -- typing a name, clicking Join -- is the closest thing to starting
// fullscreen that a web app is allowed.
function restoreFullscreenOnFirstGesture() {
  let saved = null;
  try {
    saved = localStorage.getItem('fullscreenEnabled');
  } catch {
    /* ignore storage errors */
  }
  if (saved !== 'true') return;

  const restore = () => {
    window.removeEventListener('pointerdown', restore);
    window.removeEventListener('keydown', restore);
    if (!isFullscreenActive()) enterFullscreen();
  };
  window.addEventListener('pointerdown', restore);
  window.addEventListener('keydown', restore);
}

function cameraModeLabel(mode) {
  if (mode === 'first-person') return 'First Person';
  if (mode === 'third-person') return 'Third Person';
  return 'Overview';
}

const CAMERA_MODE_ORDER = Object.freeze(['first-person', 'third-person', 'overview']);

function cycleCameraMode(direction = 1) {
  // Upstream's `roam cycle type forward` (F8). An observer's camera modes are
  // the roaming views, so C cycles those and leaves the player's own choice
  // untouched underneath, ready for when they join a team. Roaming only cycles
  // one way, so an observer gets the same view whichever way the row is pushed.
  if (hudContext.isObserver()) {
    hudContext.cycleObserverView();
    refreshHudButtons();
    return;
  }
  const current = CAMERA_MODE_ORDER.indexOf(hudContext.getCameraMode());
  const step = direction < 0 ? -1 : 1;
  const next = CAMERA_MODE_ORDER[
    ((current < 0 ? 0 : current) + step + CAMERA_MODE_ORDER.length) % CAMERA_MODE_ORDER.length
  ];
  hudContext.setCameraMode(next);
  try {
    localStorage.setItem('cameraMode', next);
  } catch {
    /* ignore storage errors */
  }
  hudContext.showMessage(`Camera: ${cameraModeLabel(next)}`);
  refreshHudButtons();
}

// The only way mouse steering goes on or off: `M`, this row, Escape. Driving the
// tank never reaches it. Upstream bumps between input devices on its own
// instead (`allowInputChange`, playing.cxx:821), because its devices are
// exclusive and one of them has to be chosen; bzo drives from the keyboard and
// the mouse together, so there is nothing for a bump to choose between. A
// preference the player set by hand is only ever unset by hand.
export function toggleMouseMode(forceState) {
  const current = hudContext.getMouseControlEnabled();
  const next = typeof forceState === 'boolean' ? forceState : !current;
  // Turning it off always works. A context that cannot steer with a mouse says
  // so rather than storing a preference that does nothing.
  if (next && !isMouseSteeringAvailable()) {
    hudContext.showMessage(mouseSteeringUnavailableReason());
    return;
  }
  if (next === current) return;
  hudContext.setMouseControlEnabled(next);
  try {
    localStorage.setItem('mouseControlEnabled', next ? 'true' : 'false');
  } catch {
    /* ignore storage errors */
  }
  hudContext.resetMouseSteering();
  hudContext.showMessage(`Controls: ${next ? 'Mouse and keyboard' : 'Keyboard'}`);
  refreshHudButtons();
}

function updateVirtualControlsBtn() {
  if (!domRefs.virtualControlsBtn) return;
  const enabled = hudContext.getVirtualControlsEnabled();
  domRefs.virtualControlsBtn.classList.toggle('active', enabled);
  domRefs.virtualControlsBtn.title = enabled ? 'Hide Virtual Controls' : 'Show Virtual Controls';
}

export function toggleVirtualControls(forceState) {
  if (!domRefs.controlsOverlay) return;
  const current = hudContext.getVirtualControlsEnabled();
  const next = typeof forceState === 'boolean' ? forceState : !current;
  hudContext.setVirtualControlsEnabled(next);
  try {
    localStorage.setItem('virtualControlsEnabled', next ? 'true' : 'false');
  } catch {
    /* ignore storage errors */
  }
  domRefs.controlsOverlay.style.display = next ? 'block' : 'none';
  document.body.classList.toggle('virtual-controls-active', next);
  updateVirtualControlsBtn();
  // The overlay takes steering off the mouse while it is up, and the mouse box
  // holds whatever offset the cursor was last at. Clearing it means the overlay
  // going away cannot hand a stale offset back to a tank nobody is touching.
  hudContext.resetMouseSteering();
  // The button's own handler stops the click propagating, so the settings menu
  // never sees it and never re-reads the row. Toggling looked like it did
  // nothing there. toggleMouseMode has always ended this way.
  refreshHudButtons();
  hudContext.showMessage(`Virtual Controls: ${next ? 'Enabled' : 'Disabled'}`);
}

function updateOperatorBtn() {
  if (!domRefs.operatorBtn || !domRefs.operatorOverlay) return;
  const isVisible = window.getComputedStyle(domRefs.operatorOverlay).display !== 'none';
  domRefs.operatorBtn.classList.toggle('active', isVisible);
  domRefs.operatorBtn.title = isVisible ? 'Hide Operator Panel (O)' : 'Show Operator Panel (O)';
}

export function toggleOperatorPanel() {
  if (!domRefs.operatorOverlay) return;
  // A disabled button cannot be clicked, so the button path needs no guard --
  // but the `O` key reaches here directly, and on a server where this player is
  // not an operator there is nothing behind the panel to show: every message it
  // sends is refused. The button carries the answer, so it is the one place the
  // state is read from.
  if (domRefs.operatorBtn?.disabled) {
    hudContext.showMessage('Operator: enter a name to become an operator on this server');
    return;
  }
  const currentVisible = isOperatorPanelVisible();
  if (currentVisible) {
    hideDialog(domRefs.operatorOverlay);
    syncInputContextFromUi();
    hudContext.showMessage('Operator Panel: Hidden');
  } else {
    hideSettingsHudSilently();
    setInputContext(INPUT_CONTEXT.DIALOG);
    showDialog(domRefs.operatorOverlay, {
      focusTarget: (dialog) => {
        const motdInput = dialog.querySelector('#motdInput');
        if (motdInput && typeof motdInput.focus === 'function') {
          motdInput.focus();
          if (typeof motdInput.select === 'function') motdInput.select();
          return true;
        }
        return focusFirstDialogControl(dialog);
      },
    });
    hudContext.showMessage('Operator Panel: Shown');
    const requestId = Math.floor(Math.random() * 1e9);
    hudContext.sendToServer({ type: 'getMaps', requestId });
    window._operatorMapReqId = requestId;
  }
  updateOperatorBtn();
}

// A click outside an open dialog dismisses it. The entry dialog is excluded:
// it is the join prompt, not something a stray click should cancel.
export function dismissDialogFromOutsideClick(target) {
  const visibleDialog = getVisibleDialogRoot();
  if (!visibleDialog || visibleDialog.id === 'entryDialog') return false;
  if (visibleDialog.contains(target)) return false;
  return dismissVisibleDialog(visibleDialog.id);
}

export function syncInputContextFromUi() {
  const visibleDialog = getVisibleDialogRoot();
  if (visibleDialog?.id === 'entryDialog') {
    setInputContext(INPUT_CONTEXT.ENTRY);
    return;
  }
  if (visibleDialog) {
    setInputContext(INPUT_CONTEXT.DIALOG);
    return;
  }
  const chatInput = hudContext.getChatInput ? hudContext.getChatInput() : null;
  setInputContext(document.activeElement === chatInput ? INPUT_CONTEXT.CHAT : INPUT_CONTEXT.GAMEPLAY);
}

function dismissVisibleDialog(dialogId) {
  if (dialogId === 'settingsHud') {
    toggleSettingsHud();
    return true;
  }
  if (dialogId === 'audioOverlay') {
    toggleAudioOverlay();
    return true;
  }
  if (dialogId === 'helpPanel') {
    toggleHelpPanel();
    return true;
  }
  if (dialogId === 'operatorOverlay') {
    toggleOperatorPanel();
    return true;
  }
  if (dialogId === 'entryDialog' && typeof hudContext.toggleEntryDialog === 'function') {
    hudContext.toggleEntryDialog();
    return true;
  }
  return false;
}

function bindHudElements() {
  setupMobileOrientationDebug();

  domRefs.operatorOverlay = document.getElementById('operatorOverlay');
  domRefs.virtualControlsBtn = document.getElementById('virtualControlsBtn');
  domRefs.controlsOverlay = document.getElementById('controlsOverlay');
  domRefs.mouseBtn = document.getElementById('mouseBtn');
  domRefs.fullscreenBtn = document.getElementById('fullscreenBtn');
  domRefs.debugBtn = document.getElementById('debugBtn');
  domRefs.cameraBtn = document.getElementById('cameraBtn');
  domRefs.helpBtn = document.getElementById('helpBtn');
  domRefs.playerOptionsBtn = document.getElementById('playerOptionsBtn');
  domRefs.settingsBtn = document.getElementById('settingsBtn');
  domRefs.settingsHud = document.getElementById('settingsHud');
  domRefs.audioBtn = document.getElementById('audioBtn');
  domRefs.audioOverlay = document.getElementById('audioOverlay');
  domRefs.helpPanel = document.getElementById('helpPanel');
  domRefs.closeSettingsBtn = document.getElementById('closeSettingsHud');
  domRefs.closeSettingsTitleBtn = document.getElementById('closeSettingsTitleBtn');
  domRefs.closeHelpBtn = document.getElementById('closeHelpBtn');
  domRefs.operatorBtn = document.getElementById('operatorBtn');
  domRefs.closeOperatorBtn = document.getElementById('closeOperatorBtn');
  domRefs.closeAudioBtn = document.getElementById('closeAudioBtn');
  domRefs.wireframeBtn = document.getElementById('wireframeBtn');
  // The whole label, not just the name: the flag beside it opens Settings too,
  // because the two read as one thing.
  domRefs.playerLabelEl = document.getElementById('playerLabel');
  domRefs.voicePermissionBtn = document.getElementById('voicePermissionBtn') ||
    document.getElementById('voiceRequestPermissionBtn') ||
    document.getElementById('requestVoicePermissionBtn');
  domRefs.voiceMicrophoneBtn = document.getElementById('voiceMicrophoneBtn') ||
    document.getElementById('voiceMicBtn') ||
    document.getElementById('voiceMicToggle') ||
    document.getElementById('microphoneBtn');

  stopPropagationForHud(['chatHud', 'debugHud', 'radarHud', 'controlsOverlay', 'helpPanel']);
  // Settings controls include native selects and checkboxes. Stop gameplay
  // input from escaping the panel without cancelling their default behavior.
  stopPropagationForHud(['settingsHud'], false);
  stopPropagationForHud(['audioOverlay'], false);
  stopPropagationForHud(['operatorOverlay'], false);

  if (domRefs.wireframeBtn) {
    domRefs.wireframeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setWireframeMode(!wireframeEnabled);
    });
  }

  if (domRefs.virtualControlsBtn) {
    domRefs.virtualControlsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleVirtualControls();
    });
  }

  if (domRefs.mouseBtn) {
    domRefs.mouseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMouseMode();
    });
  }

  if (domRefs.fullscreenBtn) {
    domRefs.fullscreenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  if (domRefs.debugBtn) {
    domRefs.debugBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hudContext.toggleDebugHud({
        debugEnabled: hudContext.getDebugEnabled(),
        setDebugEnabled: hudContext.setDebugEnabled,
        updateHudButtons: () => refreshHudButtons(),
        showMessage: hudContext.showMessage,
        updateDebugDisplay: hudContext.updateDebugDisplay,
        getDebugState: hudContext.getDebugState,
      });
    });
  }

  if (domRefs.cameraBtn) {
    domRefs.cameraBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleCameraMode();
    });
  }

  if (domRefs.helpBtn) {
    domRefs.helpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHelpPanel();
    });
  }

  if (domRefs.settingsBtn) {
    domRefs.settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettingsHud();
    });
  }

  if (domRefs.playerOptionsBtn) {
    domRefs.playerOptionsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideSettingsHudSilently();
      hudContext.toggleEntryDialog();
    });
  }

  if (domRefs.audioBtn) {
    domRefs.audioBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleAudioOverlay();
    });
  }

  if (domRefs.closeSettingsBtn) {
    domRefs.closeSettingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettingsHud();
    });
  }

  // The [X] in the heading and the Close row at the foot of the menu do the same
  // thing. Both are kept: in XR the menu is rendered from SETTINGS_MENU_ITEMS as
  // rows and the heading's button is not one of them, so the row is the only one
  // reachable there -- and it is the easier target on a controller.
  if (domRefs.closeSettingsTitleBtn) {
    domRefs.closeSettingsTitleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettingsHud();
    });
  }

  if (domRefs.closeHelpBtn) {
    domRefs.closeHelpBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleHelpPanel();
    });
  }

  if (domRefs.closeAudioBtn) {
    domRefs.closeAudioBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleAudioOverlay();
    });
  }

  if (domRefs.operatorBtn) {
    domRefs.operatorBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettingsHud();
      toggleOperatorPanel();
    });
  }

  if (domRefs.closeOperatorBtn) {
    domRefs.closeOperatorBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleOperatorPanel();
    });
  }

  if (domRefs.playerLabelEl) {
    domRefs.playerLabelEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSettingsDialog();
    });
  }

  if (domRefs.voicePermissionBtn) {
    domRefs.voicePermissionBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      callOptionalHudCallback([
        'requestVoicePermission',
        'requestVoiceMicrophonePermission',
        'requestMicrophonePermission',
      ]);
    });
  }

  if (domRefs.voiceMicrophoneBtn) {
    domRefs.voiceMicrophoneBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      callOptionalHudCallback(['toggleVoiceMicrophone', 'toggleMicrophone']);
    });
  }

  if (!keyboardListenerAttached) {
    document.addEventListener('keydown', (e) => {
      const activeElement = document.activeElement;
      const chatInput = hudContext.getChatInput ? hudContext.getChatInput() : null;
      const visibleDialog = getVisibleDialogRoot();
      if (handleDialogKeydown(e, { dismissDialog: dismissVisibleDialog })) {
        return;
      }
      if (activeElement === chatInput) return;
      const entryInput = document.getElementById('entryInput');
      if (activeElement === entryInput) return;
      if (isOperatorPanelVisible()) return;
      if (visibleDialog) return;
      if (isEditableElement(activeElement)) return;

      // Past every dialog and text field, so the game has the keyboard.
      if (isGameplayOwnedKey(e)) e.preventDefault();

      setGameplayKeyState(e.code, true);
      if (hudContext.handleGameplayKeydown(e)) return;

      if (e.key === 'm' || e.key === 'M') {
        toggleMouseMode();
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      } else if (e.code === 'Backquote') {
        // Matched on `code`, not `key`: the console key is where a layout puts
        // it, and on AZERTY or QWERTZ this one does not produce a backtick at
        // all. `I` is reserved for upstream's `identify`.
        hudContext.toggleDebugHud({
          debugEnabled: hudContext.getDebugEnabled(),
          setDebugEnabled: hudContext.setDebugEnabled,
          updateHudButtons: () => refreshHudButtons(),
          showMessage: hudContext.showMessage,
          updateDebugDisplay: hudContext.updateDebugDisplay,
          getDebugState: hudContext.getDebugState,
        });
      } else if (e.key === 'c' || e.key === 'C') {
        cycleCameraMode();
      } else if (e.key === 'o' || e.key === 'O') {
        toggleOperatorPanel();
      } else if ((e.key === 'b' || e.key === 'B') && !e.repeat) {
        if (callOptionalHudCallback(['toggleVoiceMicrophone', 'toggleMicrophone'])) {
          e.preventDefault();
        }
      } else if (e.key === '?' || e.key === '/') {
        toggleHelpPanel();
      }
    });
    document.addEventListener('keyup', (e) => {
      setGameplayKeyState(e.code, false);
    });
    keyboardListenerAttached = true;
  }

  try {
    const savedCameraMode = localStorage.getItem('cameraMode');
    if (savedCameraMode === 'first-person' || savedCameraMode === 'third-person' || savedCameraMode === 'overview') {
      hudContext.setCameraMode(savedCameraMode);
    }
  } catch {
    /* ignore storage errors */
  }
  try {
    const savedMouseMode = localStorage.getItem('mouseControlEnabled');
    if (savedMouseMode === 'true') {
      hudContext.setMouseControlEnabled(true);
    }
  } catch {
    /* ignore storage errors */
  }
  // A phone is handed the on-screen controls and a desktop is not, which is a
  // fair guess from a user agent and no answer at all to a player who has said
  // otherwise -- one with a keyboard and a mouse plugged into a phone wants them
  // gone, and wants them to stay gone.
  let virtualControls = isMobile;
  try {
    const savedVirtualControls = localStorage.getItem('virtualControlsEnabled');
    if (savedVirtualControls === 'true') virtualControls = true;
    if (savedVirtualControls === 'false') virtualControls = false;
  } catch {
    /* ignore storage errors */
  }
  toggleVirtualControls(virtualControls);
  document.addEventListener('fullscreenchange', () => {
    rememberFullscreenPreference();
    refreshHudButtons();
  });
  // Plugging a mouse into a phone, or unplugging one, changes what the mouse
  // row is allowed to offer.
  finePointerQuery?.addEventListener?.('change', () => refreshHudButtons());
  watchForMousePointer();
  restoreFullscreenOnFirstGesture();

  updateSettingsBtn();
  updateHelpBtn();
  updateOperatorBtn();
  updateVirtualControlsBtn();
  refreshHudButtons();
  settingsMenu = initSettingsMenu({
    root: domRefs.settingsHud,
    getValue: getSettingsMenuValue,
    onAdjust: adjustSettingsMenuRow,
  });
}

export function initHudControls(context) {
  hudContext = { ...hudContext, ...context, isMobile };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => bindHudElements(), { once: true });
  } else {
    bindHudElements();
  }
}
