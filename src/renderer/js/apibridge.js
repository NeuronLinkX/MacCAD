/**
 * @file apibridge.js
 * @brief The native bridge (`window.api`) seen through a thin proxy. The bridge object is frozen by
 * Electron, so a test cannot replace one of its functions; instead it fills `window.__apiOverride`
 * (for example `{ openFile: async () => null }`) and every call that goes through this proxy
 * uses that function. Without an override nothing changes.
 */
const real = typeof window !== 'undefined' ? window.api : null;

/** @type {object|null} the native bridge, or null in a plain browser */
export const api = real
  ? new Proxy(
      {},
      {
        get: (_, key) => {
          // the override exists for the tests of the source app only; a release build has no such hook
          const o = typeof __MACCAD_RELEASE__ !== 'undefined' && __MACCAD_RELEASE__ ? null : window.__apiOverride;
          return o && key in o ? o[key] : real[key];
        },
        has: (_, key) => key in real,
      },
    )
  : null;
