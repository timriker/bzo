/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

export const INPUT_CONTEXT = Object.freeze({
  GAMEPLAY: 'gameplay',
  DIALOG: 'dialog',
  CHAT: 'chat',
  ENTRY: 'entry',
});

const VALID_CONTEXTS = new Set(Object.values(INPUT_CONTEXT));

export class InputContextManager {
  constructor({ resetGameplayInput = () => {} } = {}) {
    this.context = INPUT_CONTEXT.GAMEPLAY;
    this.resetGameplayInput = resetGameplayInput;
  }

  getContext() {
    return this.context;
  }

  isGameplayActive() {
    return this.context === INPUT_CONTEXT.GAMEPLAY;
  }

  setContext(context) {
    if (!VALID_CONTEXTS.has(context)) {
      throw new TypeError(`Unknown input context: ${context}`);
    }
    if (context === this.context) return false;

    this.resetGameplayInput();
    this.context = context;
    return true;
  }
}