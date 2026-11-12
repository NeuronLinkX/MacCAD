/**
 * @file commands_license.js
 * @brief LICENSE command: opens the trial / licence window (enter a key, see the days left).
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { def } from './registry.js';
import { license } from './license.js';

/* ============================================================================================
 * 2. COMMAND CLASS
 * ========================================================================================== */

/** Commands about the trial period and the licence key. */
export class LicenseCommands {
  /** Registers LICENSE with the command registry. */
  static register() {
    def('LICENSE', LicenseCommands.show);
  }

  /**
   * LICENSE: shows the licence window, then echoes the state (days left, or the licence line).
   * @param {object} c command context
   */
  static async show(c) {
    await c.ui.licenseDialog();
    const b = license.badge();
    c.echo(b ? `${b.text}.` : license.lines()[0]);
  }
}

LicenseCommands.register();
