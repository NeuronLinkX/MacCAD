'use strict';
const { app, ipcMain, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { SubscriptionService } = require('./subscription-service');

let service;
function getService() {
  if (service) return service;
  const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'storekit/config.json'), 'utf8'));
  // This native module lives inside the signed app; renderer content cannot supply a verifier.
  const native = require(path.join(process.resourcesPath, 'storekit/storekit.node'));
  service = new SubscriptionService({
    config,
    bridge: (request) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('App Store request timed out')), 120000);
      try { native.request(JSON.stringify(request), (text) => {
        clearTimeout(timeout);
        try {
          const result = JSON.parse(text);
          if (!result.ok) reject(new Error('The App Store could not complete this request. Please try again.'));
          else resolve(result.data);
        } catch (error) { reject(error); }
      }); } catch (error) { clearTimeout(timeout); reject(error); }
    }),
    changed: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('license:changed', status);
      }
    },
  });
  return service;
}

async function status(force = false) {
  try { return await getService().status(force); }
  catch { return { provider: 'app-store', state: 'unavailable', restricted: true, now: Date.now() }; }
}
function register() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame || frame.url !== pathToFileURL(path.join(app.getAppPath(), 'src/renderer/index.html')).href) {
      throw new Error('Untrusted subscription request');
    }
    return fn(...args);
  });
  handle('license:status', () => status());
  handle('subscription:products', () => getService().products());
  handle('subscription:purchase', (productId) => getService().purchase(productId));
  handle('subscription:restore', () => getService().restore());
  handle('subscription:manage', () => shell.openExternal('https://apps.apple.com/account/subscriptions'));
  // Compatibility channels never activate a manual licence in an App Store build.
  handle('license:activate', () => ({ ok: false, error: 'Use an App Store subscription.' }));
  handle('license:remove', () => status());
  handle('license:buy', () => shell.openExternal('https://apps.apple.com/account/subscriptions'));
  const timer = setInterval(() => { status().catch(() => {}); }, 60000);
  timer.unref();
  app.on('browser-window-focus', () => { status(true).catch(() => {}); });
  app.whenReady().then(() => status());
}
module.exports = { register, status, outputBlocked: async () => (await status()).restricted };
