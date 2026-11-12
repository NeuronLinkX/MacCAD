'use strict';
/**
 * @file license.js
 * @brief MacCAD 2027 trial and licence, Electron side: where the records live and the messages to
 *        the window. The rules themselves are in licensecore.js.
 *
 * Where things are stored:
 *   - trial start : <userData>/trial.dat and the macOS Keychain (service com.maccad.2026.trial);
 *                   the earlier of the two counts
 *   - licence key : <userData>/license.key
 *
 * Nothing is sent over the network: the key is checked here with the public key.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const core = require('./licensecore');
const { machineCode } = require('./machineid');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Runs the Keychain tool beside the program, never blocking it (a locked Keychain can wait for a password). */
const run = promisify(execFile);

const SERVICE = process.env.MACCAD_KEYCHAIN_SERVICE || 'com.maccad.2026.trial';
const CONTACT_URL = 'https://macarchive.co.kr/contact.html';
const SECURITY_TOOL = '/usr/bin/security';
const KEYCHAIN_TIMEOUT_MS = 4000;
/** The stored "last seen" time is refreshed at most this often (ms). */
const LAST_SEEN_REFRESH_MS = 3600000;
/** How long the "is output blocked" answer is reused (ms), so saving does not hit the Keychain every time. */
const BLOCKED_CACHE_MS = 20000;
/** Programs and scripts that may still be saved after the trial. */
const ALWAYS_SAVABLE = /\.(lsp|lisp|scr|txt|csv|log|json|dcl)$/i;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Reads and writes the trial and licence records and answers the window's licence requests. */
class LicenseService {
  constructor() {
    /** @private Cached answer of `outputBlocked`. */
    this.cache = { t: 0, restricted: false };
  }

  // ---------------------------------------------------------------- storage locations

  /** @private @returns {string} path of the trial record file. */
  fileTrial() {
    return path.join(app.getPath('userData'), 'trial.dat');
  }

  /** @private @returns {string} path of the licence key file. */
  fileKey() {
    return path.join(app.getPath('userData'), 'license.key');
  }

  /**
   * @private
   * The tests of the tools switch the Keychain off (MACCAD_NO_KEYCHAIN): they must not share one trial.
   * @returns {boolean}
   */
  useKeychain() {
    return process.platform === 'darwin' && !process.env.MACCAD_NO_KEYCHAIN;
  }

  // ---------------------------------------------------------------- trial record

  /** @private @returns {{first: number, last: number}|null} the record in the file, or null. */
  readFile() {
    try {
      return core.unpackTrial(fs.readFileSync(this.fileTrial(), 'utf8'));
    } catch {
      return null;
    }
  }

  /** @private @returns {Promise<{first: number, last: number}|null>} the record in the Keychain, or null. */
  async readKeychain() {
    if (!this.useKeychain()) return null;
    try {
      const out = await run(
        SECURITY_TOOL,
        ['find-generic-password', '-a', 'first-run', '-s', SERVICE, '-w'],
        { timeout: KEYCHAIN_TIMEOUT_MS },
      );
      return core.unpackTrial(out.stdout);
    } catch {
      return null;
    }
  }

  /** @private Writes the trial record file (a failure is fine: the Keychain copy still counts). */
  writeFile(text) {
    try {
      fs.mkdirSync(path.dirname(this.fileTrial()), { recursive: true });
      fs.writeFileSync(this.fileTrial(), text, { mode: 0o600 });
    } catch {
      /* the Keychain copy still counts */
    }
  }

  /** @private Writes the Keychain record (a failure is fine: the file copy still counts). */
  async writeKeychain(text) {
    if (!this.useKeychain()) return;
    try {
      await run(
        SECURITY_TOOL,
        ['add-generic-password', '-U', '-a', 'first-run', '-s', SERVICE, '-w', text],
        { timeout: KEYCHAIN_TIMEOUT_MS },
      );
    } catch {
      /* no Keychain: the file counts */
    }
  }

  // ---------------------------------------------------------------- licence key file

  /** @private @returns {string} the stored licence key text ('' when there is none). */
  readKey() {
    try {
      return fs.readFileSync(this.fileKey(), 'utf8');
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- status

  /**
   * The full licence status: trial state, key check, this computer's ID, the contact address.
   * Also keeps the stored trial records up to date.
   * @returns {Promise<object>} see `LicenseCore.statusOf`, plus `machine`, `buyMail`, `now` and,
   *          when a stored key no longer works, `keyError`
   */
  async status() {
    const now = Date.now();
    const f = this.readFile();
    const k = await this.readKeychain();
    const trial = core.trialState([f, k], now);
    if (!trial.tampered) {
      // remember the start and the latest time seen (a set-back clock is never written)
      const want = core.packTrial(trial.first, Math.max(trial.last, now));
      // a deleted or older copy is made good; the time moves on once an hour
      const stale = (r) => !r || r.first !== trial.first || now - r.last > LAST_SEEN_REFRESH_MS;
      if (stale(f)) this.writeFile(want);
      if (stale(k)) await this.writeKeychain(want);
    }
    const machine = await machineCode();
    const text = this.readKey();
    const key = text ? core.verifyKey(text, now, undefined, machine) : null;
    const s = core.statusOf(trial, key);
    // a stored key that no longer works (an ended subscription, or a key for another computer)
    if (key && !key.ok) s.keyError = key.error;
    return { ...s, machine, contactUrl: CONTACT_URL, now };
  }

  /**
   * The save handlers in main.js ask this before they write a drawing or a model: after the trial
   * (no licence key) they refuse, whatever the window asks. The answer is kept for 20 s.
   * Programs and scripts (.lsp, .scr, ...) may still be saved.
   * @param {string} name file name that is about to be written
   * @returns {Promise<boolean>} true when writing must be refused
   */
  async outputBlocked(name) {
    if (ALWAYS_SAVABLE.test(String(name || ''))) return false;
    if (Date.now() - this.cache.t > BLOCKED_CACHE_MS) {
      try {
        this.cache = { t: Date.now(), restricted: (await this.status()).restricted };
      } catch {
        this.cache = { t: Date.now(), restricted: true };
      }
    }
    return this.cache.restricted;
  }

  // ---------------------------------------------------------------- window requests (IPC)

  /** Registers the `license:*` handlers the preload bridge calls. */
  register() {
    ipcMain.handle('license:status', () => this.status());
    ipcMain.handle('license:activate', (e, text) => this.activate(text));
    ipcMain.handle('license:remove', () => this.remove());
    ipcMain.handle('license:buy', () => this.openBuyMail());
  }

  /**
   * Checks a pasted key and stores it when it is valid for this computer.
   * @private
   * @param {string} text pasted key
   * @returns {Promise<{ok: boolean, error?: string, status: object}>}
   */
  async activate(text) {
    const r = core.verifyKey(text, Date.now(), undefined, await machineCode());
    if (!r.ok) return { ok: false, error: r.error, status: await this.status() };
    try {
      fs.mkdirSync(path.dirname(this.fileKey()), { recursive: true });
      fs.writeFileSync(this.fileKey(), String(text).trim() + '\n', { mode: 0o600 });
    } catch (err) {
      return {
        ok: false,
        error: 'The key could not be saved: ' + err.message,
        status: await this.status(),
      };
    }
    this.cache.t = 0;
    return { ok: true, status: await this.status() };
  }

  /** @private Removes the stored key and returns the new status. */
  async remove() {
    try {
      fs.rmSync(this.fileKey(), { force: true });
    } catch {
      /* nothing stored */
    }
    this.cache.t = 0;
    return await this.status();
  }

  /**
   * @private
   * Opens the contact form of the site. It already holds this Mac's Computer ID: the key is made for it.
   */
  async openBuyMail() {
    const st = await this.status();
    const renew = st.state === 'licensed' && st.plan === 'pro';
    const body = [
      renew
        ? `I would like to renew my MacCAD 2027 subscription${st.name ? ` (${st.name})` : ''}.`
        : 'I would like a MacCAD 2027 licence key (please say which: lifetime, or monthly subscription).',
      `Computer ID: ${st.machine || '(not available)'}`,
      'Name for the key: ',
    ].join('\n');
    return shell.openExternal(`${CONTACT_URL}?topic=license&msg=${encodeURIComponent(body)}`);
  }
}

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
const service = new LicenseService();
module.exports = {
  LicenseService,
  register: () => service.register(),
  status: () => service.status(),
  outputBlocked: (name) => service.outputBlocked(name),
  CONTACT_URL,
};
