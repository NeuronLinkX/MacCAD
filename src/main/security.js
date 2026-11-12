/**
 * @file security.js
 * @brief Small, testable security rules of the main process: which addresses may be handed to the
 * operating system, which page may call the IPC handlers, and which web permissions are granted.
 */
'use strict';

/** Schemes a link inside a drawing may open outside the app. Everything else (file:, smb:, ssh:, custom handlers ...) is refused. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** @returns {boolean} true when `url` may be opened with the system (browser, mail program). */
function isSafeExternalUrl(url) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

/**
 * Is this IPC message sent by the application's own page? The handlers read and write files, so
 * only the packaged `src/renderer/index.html` (a file: page) may use them.
 * @param {string} senderUrl the URL of the frame that sent the message
 */
function isTrustedSender(senderUrl) {
  try {
    const u = new URL(String(senderUrl));
    return u.protocol === 'file:' && /\/src\/renderer\/index\.html$/.test(decodeURIComponent(u.pathname));
  } catch {
    return false;
  }
}

/** The only web permissions the app needs: writing to (and reading from) the clipboard and full screen. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);

/** @returns {boolean} true when the permission may be granted. */
const isAllowedPermission = (permission) => ALLOWED_PERMISSIONS.has(permission);

/**
 * Wraps `ipcMain.handle` and `ipcMain.on` so that every handler refuses messages from any page
 * other than the application's own.
 * @param {object} ipcMain Electron's ipcMain
 * @param {(e: object) => string} urlOf how to read the sender URL of an event
 */
function guardIpc(ipcMain, urlOf = (e) => e.senderFrame?.url || e.sender?.getURL?.() || '') {
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.handle = (channel, fn) =>
    handle(channel, (e, ...args) => {
      if (!isTrustedSender(urlOf(e))) throw new Error('Blocked: this page may not use the application bridge.');
      return fn(e, ...args);
    });
  ipcMain.on = (channel, fn) =>
    on(channel, (e, ...args) => {
      if (isTrustedSender(urlOf(e))) fn(e, ...args);
    });
}

module.exports = { isSafeExternalUrl, isTrustedSender, isAllowedPermission, guardIpc, EXTERNAL_SCHEMES };
