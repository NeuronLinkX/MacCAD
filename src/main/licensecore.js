'use strict';
/**
 * @file licensecore.js
 * @brief MacCAD 2027 trial and licence: the parts that need no Electron (so they can be tested).
 *
 * How it works:
 *   - A licence is a text key `MCAD1.<payload>.<signature>` signed with an Ed25519 private key that
 *     only the developer has. The program holds the PUBLIC key, so a key generator cannot make
 *     valid keys; the key is checked offline, nothing is sent anywhere.
 *   - The trial is 15 days from the first start. The start time is kept in two places (a file in
 *     the user data folder and the macOS Keychain, see license.js), signed with an HMAC, and the
 *     clock is watched: a clock set back is noticed.
 *   - Every key is tied to ONE computer (or, for the developer's operator key, to a short list of
 *     the developer's own computers): the key holds the Computer ID that the buyer read from the
 *     licence window, so a copied key does not work on another Mac. The ID is a hash of the Mac's
 *     hardware UUID; the UUID itself is never shown or sent.
 *   - This is a deterrent, not a lock. The program is open source (GPL-3.0-or-later): anyone may
 *     read this file and change it.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const crypto = require('crypto');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */
const DAY = 86400000;
const TRIAL_DAYS = 15;
/** A clock that went back by more than this many ms is treated as tampering. */
const SKEW = 36 * 3600 * 1000;
/** A subscription key keeps working this many days after its end date. */
const GRACE_DAYS = 3;
const PRODUCT = 'maccad';
const EDITION = '2026';
/** The developer's public key (the private key is NOT in this repository: see scripts/license/README.md). */
const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAxn2mwdSwjGeQvWWVazR6IhELZHTeQt9MtK39i/2SqwI=';
const MAC_SECRET = 'maccad-2026-trial-v1';
const MACHINE_SALT = 'maccad-2026-machine-v1';

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Licence key checking, trial bookkeeping and the status shown to the program. All static. */
class LicenseCore {
  // ---------------------------------------------------------------- computer ID

  /**
   * The Computer ID shown to the buyer: 16 hex characters of a salted hash of the hardware UUID,
   * in groups of four (A1B2-C3D4-E5F6-0718).
   * @param {string} rawUuid the hardware UUID
   * @returns {string}
   */
  static machineCode(rawUuid) {
    return crypto
      .createHash('sha256')
      .update(MACHINE_SALT + String(rawUuid).trim().toLowerCase())
      .digest('hex')
      .slice(0, 16)
      .toUpperCase()
      .match(/.{4}/g)
      .join('-');
  }

  /**
   * Finds the hardware UUID in the output of `ioreg -rd1 -c IOPlatformExpertDevice`.
   * @param {string} ioregText
   * @returns {string|null}
   */
  static parseUuid(ioregText) {
    const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(String(ioregText || ''));
    return m ? m[1] : null;
  }

  /** @private @returns {string} a Computer ID reduced to its hex digits, upper case. */
  static normMachine(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '');
  }

  // ---------------------------------------------------------------- base64url helpers

  /** @returns {string} bytes as unpadded base64url. */
  static b64u(b) {
    return Buffer.from(b)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** @private @returns {Buffer} the bytes of a base64url string. */
  static unb64u(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  /** @returns {crypto.KeyObject} the Ed25519 public key (default: the built-in developer key). */
  static publicKey(b64 = PUBLIC_KEY_B64) {
    return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  }

  // ---------------------------------------------------------------- licence keys

  /**
   * Verifies a key for the computer `machine` (its Computer ID).
   * @param {string} text what the user pasted; the key is found inside it
   * @param {number} [now] current time in ms
   * @param {crypto.KeyObject} [pub] public key to check against
   * @param {string|null} [machine] this computer's ID
   * @returns {{ok: true, plan: string, name: string, issued: number, expires: number|null, edition?: string}
   *          | {ok: false, error: string}}
   */
  static verifyKey(text, now = Date.now(), pub = LicenseCore.publicKey(), machine = null) {
    // the key is found inside whatever was pasted (an e-mail, a line of the terminal, quotes, line
    // breaks in the key): an Ed25519 signature is always 64 bytes = 86 characters, so text after
    // the key is ignored
    const t = String(text || '').replace(/\s+/g, '');
    const m = /MCAD1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{86})/.exec(t);
    if (!m)
      return {
        ok: false,
        error:
          'This is not a MacCAD licence key. Paste the whole key, the long text that starts with MCAD1.',
      };
    let payload;
    try {
      if (!crypto.verify(null, Buffer.from(m[1]), pub, LicenseCore.unb64u(m[2])))
        return { ok: false, error: 'The licence key is not valid (the signature does not match).' };
      payload = JSON.parse(LicenseCore.unb64u(m[1]).toString('utf8'));
    } catch {
      return { ok: false, error: 'The licence key is damaged.' };
    }
    if (payload.product !== PRODUCT)
      return { ok: false, error: 'This key is for another product.' };
    if (!['lifetime', 'pro', 'operator'].includes(payload.plan))
      return { ok: false, error: 'Unknown licence plan.' };

    // the computer: a key that is not tied to one is not accepted, so a key that was passed on does nothing
    const machines = (Array.isArray(payload.machine) ? payload.machine : [])
      .map(LicenseCore.normMachine)
      .filter(Boolean);
    if (!machines.length)
      return {
        ok: false,
        error:
          'This key is not tied to a computer, so it is not accepted. Ask for a new key and send your Computer ID.',
      };
    if (!machine)
      return {
        ok: false,
        error: 'This computer has no Computer ID, so the key cannot be checked here.',
      };
    if (!machines.includes(LicenseCore.normMachine(machine)))
      return {
        ok: false,
        error: `This key is for another computer. The Computer ID of this one is ${machine}. Ask for a key for it.`,
      };

    // the developer's own key: no edition, no end
    if (payload.plan === 'operator')
      return {
        ok: true,
        plan: 'operator',
        name: payload.name || '',
        issued: payload.issued,
        expires: null,
      };
    if (payload.plan === 'lifetime') {
      if (String(payload.edition) !== EDITION)
        return {
          ok: false,
          error: `This lifetime key is for MacCAD ${payload.edition}, not ${EDITION}.`,
        };
      return {
        ok: true,
        plan: 'lifetime',
        edition: payload.edition,
        name: payload.name || '',
        issued: payload.issued,
        expires: null,
      };
    }
    // subscription ("pro"): needs an end date, with a few days of grace
    if (!(payload.expires > 0)) return { ok: false, error: 'The licence key has no end date.' };
    if (now > payload.expires + GRACE_DAYS * DAY)
      return {
        ok: false,
        error: `This subscription key ended on ${new Date(payload.expires).toISOString().slice(0, 10)}.`,
      };
    return {
      ok: true,
      plan: 'pro',
      name: payload.name || '',
      issued: payload.issued,
      expires: payload.expires,
    };
  }

  /**
   * Signs a key (used by scripts/license/issue.mjs and by the tests; needs the private key).
   * @param {object} payload fields of the key (plan, name, machine, expires ...)
   * @param {string} privateKeyPem the Ed25519 private key in PEM form
   * @returns {string} the key text `MCAD1.<payload>.<signature>`
   */
  static signKey(payload, privateKeyPem) {
    const body = LicenseCore.b64u(
      JSON.stringify({ v: 1, product: PRODUCT, edition: EDITION, issued: Date.now(), ...payload }),
    );
    return `MCAD1.${body}.${LicenseCore.b64u(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem)))}`;
  }

  // ---------------------------------------------------------------- trial record "first.last.mac"

  /** @private @returns {string} the HMAC that protects a trial record. */
  static mac(first, last) {
    return crypto
      .createHmac('sha256', MAC_SECRET)
      .update(`${first}.${last}`)
      .digest('hex')
      .slice(0, 24);
  }

  /** @returns {string} a trial record: first start, last seen, and their HMAC. */
  static packTrial(first, last) {
    return `${first}.${last}.${LicenseCore.mac(first, last)}`;
  }

  /** @returns {{first: number, last: number}|null} the record's times, or null when it is damaged. */
  static unpackTrial(text) {
    const m = /^(\d{10,14})\.(\d{10,14})\.([0-9a-f]{24})$/.exec(String(text || '').trim());
    if (!m || LicenseCore.mac(+m[1], +m[2]) !== m[3]) return null;
    return { first: +m[1], last: +m[2] };
  }

  /**
   * Combines the stored records (file, keychain: any may be null) into the trial state at `now`.
   * The earliest start wins, so deleting one copy does not restart the trial.
   * @param {Array<{first: number, last: number}|null>} records
   * @param {number} [now]
   * @returns {{first: number, last: number, end: number, daysLeft: number, msLeft: number,
   *           tampered: boolean, expired: boolean, fresh: boolean}}
   */
  static trialState(records, now = Date.now()) {
    const good = records.filter(Boolean);
    const first = good.length ? Math.min(...good.map((r) => r.first)) : now;
    const lastSeen = good.length ? Math.max(...good.map((r) => r.last)) : now;
    const tampered = now < lastSeen - SKEW; // the clock was set back
    const last = Math.max(lastSeen, now);
    const end = first + TRIAL_DAYS * DAY;
    const daysLeft = Math.max(0, Math.ceil((end - Math.max(now, lastSeen)) / DAY));
    const msLeft = Math.max(0, end - Math.max(now, lastSeen));
    return {
      first,
      last,
      end,
      daysLeft,
      msLeft,
      tampered,
      expired: tampered || Math.max(now, lastSeen) >= end,
      fresh: !good.length,
    };
  }

  // ---------------------------------------------------------------- status shown to the program

  /**
   * The status the program shows.
   * @param {object} trial result of `trialState`
   * @param {object|null} key result of `verifyKey`, or null when there is no key
   * @returns {{state: 'licensed'|'tamper'|'expired'|'trial', restricted: boolean, [k: string]: any}}
   */
  static statusOf(trial, key) {
    if (key && key.ok)
      return {
        state: 'licensed',
        plan: key.plan,
        name: key.name,
        expires: key.expires,
        restricted: false,
      };
    if (trial.tampered)
      return {
        state: 'tamper',
        restricted: true,
        message: 'The system clock was set back. Set it right, or enter a licence key.',
      };
    if (trial.expired)
      return {
        state: 'expired',
        restricted: true,
        trialEnd: trial.end,
        message: `The ${TRIAL_DAYS}-day trial has ended.`,
      };
    return {
      state: 'trial',
      restricted: false,
      daysLeft: trial.daysLeft,
      msLeft: trial.msLeft,
      trialEnd: trial.end,
    };
  }
}

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
module.exports = {
  LicenseCore,
  machineCode: LicenseCore.machineCode,
  parseUuid: LicenseCore.parseUuid,
  DAY,
  TRIAL_DAYS,
  GRACE_DAYS,
  PUBLIC_KEY_B64,
  verifyKey: LicenseCore.verifyKey,
  signKey: LicenseCore.signKey,
  packTrial: LicenseCore.packTrial,
  unpackTrial: LicenseCore.unpackTrial,
  trialState: LicenseCore.trialState,
  statusOf: LicenseCore.statusOf,
  publicKey: LicenseCore.publicKey,
  b64u: LicenseCore.b64u,
};
