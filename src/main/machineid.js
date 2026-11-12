'use strict';
/**
 * @file machineid.js
 * @brief The Computer ID of this Mac (see licensecore.js `machineCode`).
 *
 * It is a hash of the hardware UUID that `ioreg` reports. The UUID itself is neither stored nor
 * shown. On systems other than macOS there is no ID, so keys tied to a computer cannot be checked.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const core = require('./licensecore');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */
const IOREG = '/usr/sbin/ioreg';
const IOREG_ARGS = ['-rd1', '-c', 'IOPlatformExpertDevice'];
const IOREG_TIMEOUT_MS = 4000;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Reads and caches the Computer ID. */
class MachineId {
  constructor() {
    /** @private Cached ID after the first successful read. */
    this.cached = null;
  }

  /**
   * Asynchronous read (used by the app; the result is cached).
   * @returns {Promise<string|null>} the Computer ID, or null when it cannot be determined
   */
  async machineCode() {
    if (this.cached) return this.cached;
    if (process.platform !== 'darwin') return null;
    try {
      const out = await promisify(execFile)(IOREG, IOREG_ARGS, { timeout: IOREG_TIMEOUT_MS });
      const u = core.parseUuid(out.stdout);
      if (u) this.cached = core.machineCode(u);
    } catch {
      /* no ID: keys tied to a computer cannot be checked */
    }
    return this.cached;
  }

  /**
   * Synchronous read, for the tools in scripts/ (issue.mjs) and tests, which may wait.
   * @returns {string|null}
   */
  machineCodeSync() {
    if (process.platform !== 'darwin') return null;
    try {
      const u = core.parseUuid(
        execFileSync(IOREG, IOREG_ARGS, { timeout: IOREG_TIMEOUT_MS }).toString(),
      );
      return u ? core.machineCode(u) : null;
    } catch {
      return null;
    }
  }
}

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
const instance = new MachineId();
module.exports = {
  MachineId,
  machineCode: () => instance.machineCode(),
  machineCodeSync: () => instance.machineCodeSync(),
};
