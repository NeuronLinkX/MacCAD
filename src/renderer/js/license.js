/**
 * @file license.js
 * @brief MacCAD 2027 trial and licence, window side.
 *
 * The rules and the checks are in src/main/licensecore.js and src/main/license.js; this file keeps
 * the status the window shows and tells the rest of the program about changes.
 *
 * After the 15-day trial, without a licence key, MacCAD is view-only: a drawing can be opened,
 * looked at and measured, but a change is taken back and nothing can be saved or exported. (The
 * program is open source: this is a reminder to buy a licence, not a lock.)
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** Bridge to the main process (undefined in a plain browser). */
const api = typeof window !== 'undefined' ? window.api : null;

const DAY = 86400000;
const HOUR = 3600000;
const MINUTE = 60000;

/** The same TRIAL_DAYS as src/main/licensecore.js (test/license.test.js compares them). */
export const TRIAL_DAYS = 15;
/** The badge turns to a warning when this many days or fewer are left. */
export const WARN_DAYS = 3;

/**
 * Commands that write a drawing or a model to a file (canonical names; an alias like QSAVE or EXP
 * is resolved to these before the check).
 */
export const OUTPUT_COMMANDS = new Set([
  'SAVE',
  'SAVEAS',
  'SAVEALL',
  'EXPORT',
  'PLOT',
  'EXPORTPDF',
  'PREVIEW',
  'STEPOUT',
  'STLOUT',
  'OBJOUT',
  'WBLOCK',
]);

/** Commands that may change the drawing even in view-only mode: taking a step back. */
export const KEEP_COMMANDS = new Set(['UNDO', 'U', 'UNDO1', 'REDO']);

/* ============================================================================================
 * 2. HELPERS
 * ========================================================================================== */

/** @returns {string} "1 day" / "5 days". */
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Time left as text: "30 days", and in the last day "5 hours", "12 min", "40 s" (so that the end
 * can be watched).
 * @param {number} ms milliseconds left
 * @returns {string}
 */
export const leftText = (ms) =>
  ms > DAY
    ? plural(Math.ceil(ms / DAY), 'day')
    : ms >= HOUR
      ? plural(Math.ceil(ms / HOUR), 'hour')
      : ms >= MINUTE
        ? `${Math.ceil(ms / MINUTE)} min`
        : `${Math.max(0, Math.ceil(ms / 1000))} s`;

/* ============================================================================================
 * 3. CLIENT CLASS
 * ========================================================================================== */

/** The licence state of this window. One shared instance is exported as `license`. */
export class LicenseClient {
  constructor() {
    /** Last status from the main process, or null before the first answer. */
    this.status = api?.distribution === 'app-store' ? { provider: 'app-store', state: 'checking', restricted: true } : null;
    /** @private Listeners called with the status on every change. */
    this._on = new Set();
    /** @private Timer of the countdown in the last day. */
    this._timer = 0;
  }

  /** @returns {boolean} true when the program is view-only (trial over, no key). */
  get restricted() {
    const s = this.status;
    if (s?.provider === 'app-store' && s.entitlementUntil && Date.now() >= s.entitlementUntil) return true;
    return !!(s && s.restricted);
  }

  /**
   * Subscribes to status changes.
   * @param {(status: object) => void} fn
   * @returns {() => boolean} call it to unsubscribe
   */
  on(fn) {
    this._on.add(fn);
    return () => this._on.delete(fn);
  }

  /** @private Stores a new status and tells the listeners. */
  _set(s) {
    this.status = s;
    this._notify();
    this._tick();
    return s;
  }

  /** @private Calls every listener (one failing listener never stops the others). */
  _notify() {
    for (const fn of this._on) {
      try {
        fn(this.status);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * @private
   * In the last day the text counts down (every second in the last hour); when the end is reached
   * the status is asked for again, which turns the program view-only.
   */
  _tick() {
    clearTimeout(this._timer);
    const s = this.status;
    if (!s || typeof window === 'undefined') return;
    const end = s.provider === 'app-store' ? s.entitlementUntil : s.state === 'trial' ? s.trialEnd : null;
    if (!end) return;
    const ms = end - Date.now();
    if (ms > DAY) return; // the 10-minute look in watch() is enough
    this._timer = setTimeout(
      () => {
        if (Date.now() >= end) this.refresh();
        else {
          this._notify();
          this._tick();
        }
      },
      ms < HOUR ? 1000 : 30000,
    );
  }

  /**
   * Asks the main process for the current status.
   * An error of ours must never lock the user out, so a failure keeps the old status.
   * @returns {Promise<object>} the status
   */
  async refresh() {
    if (!api || !api.licenseStatus) return this._set({ state: 'browser', restricted: false });
    try {
      return this._set(await api.licenseStatus());
    } catch (e) {
      console.error(e);
      if (api?.distribution === 'app-store' && (!this.status?.entitlementUntil || Date.now() >= this.status.entitlementUntil))
        return this._set({ provider: 'app-store', state: 'unavailable', restricted: true });
      return this.status;
    }
  }

  /**
   * Looks at start, when the window comes back, and every 10 minutes (a trial can end while the
   * program is open).
   * @returns {Promise<object>} the first status
   */
  watch() {
    const first = this.refresh();
    if (typeof window === 'undefined') return first;
    window.addEventListener('focus', () => this.refresh());
    if (api?.distribution === 'app-store') api.on('license:changed', (status) => this._set(status));
    setInterval(() => this.refresh(), api?.distribution === 'app-store' ? MINUTE : 10 * MINUTE);
    return first;
  }

  /**
   * Sends a pasted key to the main process.
   * @param {string} text the key
   * @returns {Promise<{ok: boolean, error?: string, status?: object}>}
   */
  async activate(text) {
    if (!api || !api.licenseActivate)
      return { ok: false, error: 'Licence keys can be entered in the MacCAD app only.' };
    const r = await api.licenseActivate(text);
    if (r && r.status) this._set(r.status);
    return r;
  }

  /** Removes the stored key. */
  async remove() {
    if (api && api.licenseRemove) this._set(await api.licenseRemove());
  }

  /** Opens the contact form that asks for a key. */
  buy() {
    return api && api.licenseBuy ? api.licenseBuy() : null;
  }

  /**
   * The short text for the status bar.
   * @returns {{text: string, level: 'info'|'warn'|'bad'}|null} null when nothing needs saying
   */
  badge() {
    const s = this.status;
    if (!s) return null;
    if (s.provider === 'app-store') {
      if (s.state === 'checking') return { text: 'Checking subscription…', level: 'info' };
      if (s.restricted) return { text: 'View only · Subscription', level: 'warn' };
      if (s.state === 'grace') return { text: 'Subscription · Update payment', level: 'warn' };
      if (s.state === 'trial') return { text: `Free trial: ${leftText(Math.max(0, s.trialEnd - Date.now()))} left`, level: 'info' };
      return { text: 'MacCAD Pro', level: 'info' };
    }
    if (s.state === 'trial') {
      const ms = Math.max(0, s.trialEnd - Date.now());
      return {
        text: `Trial: ${leftText(ms)} left`,
        level: ms <= WARN_DAYS * DAY ? 'warn' : 'info',
      };
    }
    if (s.state === 'expired') return { text: 'Trial ended: view only', level: 'bad' };
    if (s.state === 'tamper') return { text: 'Clock set back: view only', level: 'bad' };
    if (s.state === 'licensed' && s.plan === 'pro' && s.expires) {
      const n = Math.ceil((s.expires - s.now) / DAY);
      if (n <= 0) return { text: 'Subscription ended: renew', level: 'bad' };
      if (n <= 7) return { text: `Subscription ends in ${plural(n, 'day')}`, level: 'warn' };
    }
    return null;
  }

  /** @returns {string[]} the lines of the licence window. */
  lines() {
    const s = this.status || {};
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    if (s.provider === 'app-store') {
      if (s.restricted) return [s.state === 'unavailable' ? 'Subscription could not be verified. Connect to the App Store and try Restore Purchases.' : 'MacCAD is in view-only mode.', 'Subscribe to edit, save and export drawings. Existing drawings remain available to view.'];
      return [s.state === 'trial' ? 'Your App Store free trial is active.' : s.state === 'grace' ? 'Update your payment method to keep MacCAD Pro.' : 'MacCAD Pro is active.',
        `${s.autoRenew === false ? 'Available until' : 'Current access ends'} ${day(s.entitlementUntil)}.`,
        s.autoRenew === false ? 'Automatic renewal is off. You keep access until the current period ends.' : 'Manage renewal in your App Store subscriptions.'];
    }
    if (s.state === 'licensed') {
      const soon = s.plan === 'pro' && s.expires && s.expires - Date.now() <= 7 * DAY;
      return [
        s.plan === 'operator'
          ? "Licensed: operator key (the developer's own computer)."
          : s.plan === 'lifetime'
            ? 'Licensed: lifetime licence for MacCAD 2027, for this computer.'
            : `Licensed: subscription for this computer${s.expires ? `, valid until ${day(s.expires)}` : ''}.`,
        s.name ? `Licensed to ${s.name}.` : '',
        soon
          ? 'It ends soon. Press "Get a key" to ask for the next period; paste the new key over the old one.'
          : '',
      ].filter(Boolean);
    }
    if (s.state === 'trial')
      return [
        `Trial: ${leftText(Math.max(0, s.trialEnd - Date.now()))} left (ends ${s.trialEnd - Date.now() <= DAY ? new Date(s.trialEnd).toTimeString().slice(0, 8) : day(s.trialEnd)}).`,
        'Everything works during the trial. Afterwards MacCAD is view-only until a licence key is entered.',
      ];
    if (s.state === 'expired')
      return [
        `The ${TRIAL_DAYS}-day trial ended on ${day(s.trialEnd)}.`,
        'MacCAD is view-only: drawings can be opened and looked at, but not changed, saved or exported.',
      ];
    if (s.state === 'tamper')
      return [
        s.message,
        'MacCAD is view-only until the clock is right or a licence key is entered.',
      ];
    return ['No licence information (running outside the app).'];
  }

  /** @returns {string} the message shown when a blocked action is tried. */
  blockedMessage() {
    const s = this.status || {};
    if (s.provider === 'app-store') return 'MacCAD is view-only. An active App Store subscription is required to edit, save or export. Type LICENSE to subscribe or restore purchases.';
    const why = s.state === 'tamper' ? s.message : `The ${TRIAL_DAYS}-day trial has ended.`;
    return `${why} MacCAD is view-only: nothing can be changed, saved or exported. Type LICENSE to enter a licence key.`;
  }
}

/* ============================================================================================
 * 4. SHARED INSTANCE
 * ========================================================================================== */
export const license = new LicenseClient();
