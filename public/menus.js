/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

const DIALOG_ROOT_IDS = [
  'settingsHud',
  'audioOverlay',
  'helpPanel',
  'operatorOverlay',
  'entryDialog',
];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(', ');

// One line and one page of a dialog that scrolls. Arrows step a line the way a
// scroll wheel does rather than jumping a whole screen.
const DIALOG_SCROLL_LINE = 48;

// A dialog that is read rather than operated: the help panel, and anything else
// that is a document with a close button rather than a panel of rows.
function isDocumentDialog(dialog) {
  return dialog?.dataset?.dialogKind === 'document';
}

// The element that actually scrolls: the dialog root if the overflow is on it,
// otherwise its content. Measured rather than assumed, because which of the two
// carries `overflow-y` is a styling decision.
function getDialogScroller(dialog) {
  const candidates = [dialog, ...dialog.querySelectorAll('.dialogContent')];
  return candidates.find((element) => element.scrollHeight - element.clientHeight > 1) || null;
}

function scrollDialogByKey(scroller, key) {
  if (key === 'Home') {
    scroller.scrollTop = 0;
    return true;
  }
  if (key === 'End') {
    scroller.scrollTop = scroller.scrollHeight;
    return true;
  }
  const page = Math.max(DIALOG_SCROLL_LINE, scroller.clientHeight * 0.9);
  const deltas = {
    ArrowUp: -DIALOG_SCROLL_LINE,
    ArrowDown: DIALOG_SCROLL_LINE,
    PageUp: -page,
    PageDown: page,
  };
  const delta = deltas[key];
  if (delta === undefined) return false;
  scroller.scrollTop += delta;
  return true;
}

const dialogReturnFocus = new Map();
const controllerNavigationState = {
  direction: 0,
  nextRepeatAt: 0,
  activatePressed: false,
  backPressed: false,
};

function isElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function getDialogRoots(dialogIds = DIALOG_ROOT_IDS) {
  return dialogIds.map((dialogId) => document.getElementById(dialogId)).filter(Boolean);
}

function getFocusableElements(dialog) {
  if (!dialog) return [];
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    if (!element || !isElementVisible(element)) return false;
    if (element.hasAttribute('disabled')) return false;
    return true;
  });
}

function focusElement(element) {
  if (!element || typeof element.focus !== 'function') return false;
  element.focus();
  if (typeof element.select === 'function' && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
    element.select();
  }
  return true;
}

function rememberReturnFocus(dialog) {
  const activeElement = document.activeElement;
  if (!dialog || !activeElement || dialog.contains(activeElement)) return;
  dialogReturnFocus.set(dialog.id, activeElement);
}

function restoreReturnFocus(dialog) {
  if (!dialog) return false;
  const target = dialogReturnFocus.get(dialog.id);
  dialogReturnFocus.delete(dialog.id);
  if (!target || !document.contains(target)) return false;
  return focusElement(target);
}

export function getVisibleDialogRoot(dialogIds = DIALOG_ROOT_IDS) {
  return getDialogRoots(dialogIds).find((dialog) => isElementVisible(dialog)) || null;
}

export function focusFirstDialogControl(dialog) {
  const focusables = getFocusableElements(dialog);
  if (!focusables.length) {
    return focusElement(dialog);
  }

  const preferred = focusables.find((element) => !element.classList.contains('closeBtn')) || focusables[0];
  return focusElement(preferred);
}

// The close button, for a dialog whose other controls sit wherever the text put
// them. It is in the title bar at the top, so focusing it never scrolls.
export function focusDialogCloseControl(dialog) {
  const focusables = getFocusableElements(dialog);
  const close = focusables.find((element) => element.classList.contains('closeBtn'));
  return focusElement(close || focusables[0] || dialog);
}

export function showDialog(dialog, { focusTarget } = {}) {
  if (!dialog) return false;
  rememberReturnFocus(dialog);
  dialog.style.display = 'block';
  if (typeof focusTarget === 'function') {
    return Boolean(focusTarget(dialog));
  }
  // A document opens at its top. It holds the scroll position it was closed at,
  // and the control `focusFirstDialogControl` prefers over a close button is the
  // first link in the text -- which in the help panel is in the last paragraph,
  // so focusing it scrolls the end of the document into view and hides the
  // beginning along with the title bar.
  if (isDocumentDialog(dialog)) {
    const scroller = getDialogScroller(dialog);
    if (scroller) scroller.scrollTop = 0;
    return focusDialogCloseControl(dialog);
  }
  return focusFirstDialogControl(dialog);
}

export function hideDialog(dialog, { restoreFocus = true } = {}) {
  if (!dialog) return false;
  dialog.style.display = 'none';
  return restoreFocus ? restoreReturnFocus(dialog) : true;
}

function focusLastDialogControl(dialog) {
  const focusables = getFocusableElements(dialog);
  if (!focusables.length) {
    return focusElement(dialog);
  }
  return focusElement(focusables[focusables.length - 1]);
}

function moveDialogFocus(dialog, currentElement, direction) {
  const focusables = getFocusableElements(dialog);
  if (!focusables.length) return false;

  const currentIndex = focusables.findIndex((element) => element === currentElement || element.contains(currentElement));
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + focusables.length) % focusables.length;
  return focusElement(focusables[nextIndex]);
}

function isRangeInput(element) {
  return element?.tagName === 'INPUT' && element.type === 'range';
}

function canCycleWithArrowKeys(activeElement) {
  if (!activeElement) return false;
  if (activeElement.tagName === 'BUTTON') return true;
  if (activeElement.classList && activeElement.classList.contains('closeBtn')) return true;
  if (activeElement.getAttribute && activeElement.getAttribute('role') === 'button') return true;
  // A slider is the one input the shared model drives itself: Left/Right adjust
  // it through menuadjust, the same event an XR thumbstick sends, and Up/Down
  // leave the row. Letting the browser's native range keys through instead
  // would strand the focus on desktop and skip the row's own handler.
  if (isRangeInput(activeElement)) return true;
  return activeElement.tabIndex >= 0 && activeElement.tagName !== 'INPUT' && activeElement.tagName !== 'TEXTAREA' && activeElement.tagName !== 'SELECT';
}

function getOpenDialogForElement(activeElement) {
  if (!activeElement) return null;
  return getDialogRoots().find((dialog) => isElementVisible(dialog) && dialog.contains(activeElement)) || null;
}

function dismissVisibleDialog(dismissDialog, dialog) {
  if (typeof dismissDialog !== 'function' || !dialog) return false;
  return Boolean(dismissDialog(dialog.id, dialog));
}

function activateFocusedControl(dialog) {
  const activeElement = document.activeElement;
  const target = dialog.contains(activeElement) ? activeElement : null;
  if (!target) {
    return focusFirstDialogControl(dialog);
  }
  if (typeof target.click === 'function') {
    target.click();
    return true;
  }
  return false;
}

// Left and right belong to the focused row, and the row says whether it wanted
// them: a listener that acts on the adjustment calls preventDefault, which is
// what dispatchEvent reports back. A row with nothing to adjust -- an action, or
// a submenu asked to go left -- leaves the keys unconsumed rather than
// swallowing them.
function adjustFocusedControl(dialog, direction) {
  const activeElement = document.activeElement;
  const target = dialog.contains(activeElement) ? activeElement.closest?.('[data-menu-row]') : null;
  if (!target) return false;
  return !target.dispatchEvent(new window.CustomEvent('menuadjust', {
    bubbles: true,
    cancelable: true,
    detail: { direction },
  }));
}

// A dialog that is read rather than operated: up and down scroll the text, so
// left and right are the only way a controller reaches the close button. Every
// other dialog keeps the two axes apart -- up and down move between rows, left
// and right act on the row.
function movesFocusHorizontally(dialog) {
  return isDocumentDialog(dialog);
}

export function handleDialogControllerInput(input, { dismissDialog, now = performance.now() } = {}) {
  const openDialog = getVisibleDialogRoot();
  if (!openDialog) {
    controllerNavigationState.direction = 0;
    controllerNavigationState.activatePressed = false;
    controllerNavigationState.backPressed = false;
    return false;
  }

  const horizontal = Number(input?.horizontal) || 0;
  const vertical = Number(input?.vertical) || 0;
  const useVertical = Math.abs(vertical) >= Math.abs(horizontal);
  const dominantAxis = useVertical ? vertical : horizontal;
  const direction = dominantAxis > 0.6 ? 1 : dominantAxis < -0.6 ? -1 : 0;
  const navigationToken = direction === 0 ? '' : `${useVertical ? 'vertical' : 'horizontal'}:${direction}`;

  if (direction === 0) {
    controllerNavigationState.direction = 0;
    controllerNavigationState.nextRepeatAt = 0;
  } else if (navigationToken !== controllerNavigationState.direction || now >= controllerNavigationState.nextRepeatAt) {
    const activeElement = document.activeElement;
    // The stick reads the same way the arrow keys do: sideways adjusts the row
    // it is on and never walks off it.
    if (useVertical || movesFocusHorizontally(openDialog)) {
      moveDialogFocus(openDialog, activeElement, direction);
    } else {
      adjustFocusedControl(openDialog, direction);
    }
    controllerNavigationState.direction = navigationToken;
    controllerNavigationState.nextRepeatAt = now + 250;
  }

  const activatePressed = Boolean(input?.activate);
  if (activatePressed && !controllerNavigationState.activatePressed) {
    activateFocusedControl(openDialog);
  }
  controllerNavigationState.activatePressed = activatePressed;

  const backPressed = Boolean(input?.back);
  if (backPressed && !controllerNavigationState.backPressed) {
    dismissVisibleDialog(dismissDialog, openDialog);
  }
  controllerNavigationState.backPressed = backPressed;
  return true;
}

export function handleDialogKeydown(event, { dismissDialog } = {}) {
  const activeElement = document.activeElement;
  const openDialog = getOpenDialogForElement(activeElement) || getVisibleDialogRoot();
  if (!openDialog) return false;

  if (event.key === 'Escape') {
    if (dismissVisibleDialog(dismissDialog, openDialog)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }

  // A dialog you read rather than one you operate: the arrows scroll it. Cycling
  // focus through its handful of links leaves most of the text unreachable, and
  // in XR there is no Page Up or Page Down to reach the rest with instead. Left
  // and right still move focus, which is how a controller reaches the close
  // button without a Tab key.
  if (isDocumentDialog(openDialog)) {
    const scroller = getDialogScroller(openDialog);
    if (scroller && scrollDialogByKey(scroller, event.key)) {
      event.preventDefault();
      return true;
    }
  }

  const focusables = getFocusableElements(openDialog);
  if (!focusables.length) return false;

  if (event.key === 'Tab') {
    event.preventDefault();
    moveDialogFocus(openDialog, activeElement, event.shiftKey ? -1 : 1);
    return true;
  }

  // Up and down leave the row, whatever the row is -- ahead of the gate below,
  // because a text field does not pass it. Sideways operates the control and up
  // and down move between controls: the same split a slider follows and the
  // same one an XR thumbstick reads, so one habit works on every row. A
  // single-line input has nothing to do with up and down anyway; the browser
  // would spend them jumping the caret to the ends of the text and strand the
  // focus in the field. Left, right, Home and End stay native there, which is
  // what editing needs.
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    moveDialogFocus(openDialog, activeElement, event.key === 'ArrowUp' ? -1 : 1);
    return true;
  }

  if (!canCycleWithArrowKeys(activeElement)) {
    return false;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    focusElement(focusables[0]);
    return true;
  }

  if (event.key === 'End') {
    event.preventDefault();
    focusLastDialogControl(openDialog);
    return true;
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (adjustFocusedControl(openDialog, direction)) {
      event.preventDefault();
      return true;
    }
    if (movesFocusHorizontally(openDialog)) {
      event.preventDefault();
      moveDialogFocus(openDialog, activeElement, direction);
      return true;
    }
    // The row had nothing to change. Left and right do not move the focus here,
    // so the press stops.
    event.preventDefault();
    return true;
  }

  return false;
}