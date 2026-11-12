/**
 * @file preload.js
 * @brief Bridge between the renderer (the page) and the main process.
 *
 * Runs in the isolated preload context and exposes ONE object, `window.api`, through
 * `contextBridge`. The page has no direct access to Node or Electron: every capability it has is a
 * function listed in `PreloadApi.build()`, and each of them is a fixed IPC channel name.
 * To add a capability: add the channel handler in main.js and one line here.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Channels the main process may push to the page (everything else is blocked in `on`). */
const RECEIVE_CHANNELS = new Set(['open-file', 'file:opening', 'startup:ready', 'menu', 'menu-run', 'license:changed']);

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Builds the `window.api` object. */
class PreloadApi {
  /**
   * @returns {object} the API object: one function per capability, grouped by topic below
   */
  static build() {
    const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
    const send = (channel, ...args) => ipcRenderer.send(channel, ...args);
    return {
      platform: process.platform,
      distribution: (typeof __MACCAD_MAS__ !== 'undefined' ? __MACCAD_MAS__ : !!process.mas) ? 'app-store' : 'direct',
      features: Object.freeze({
        edition: typeof __MACCAD_EDITION__ === 'undefined' ? '3d' : __MACCAD_EDITION__,
        has3d: typeof __MACCAD_HAS_3D__ === 'undefined' ? true : __MACCAD_HAS_3D__,
        aiMode: typeof __MACCAD_AI_MODE__ === 'undefined' ? 'user-managed' : __MACCAD_AI_MODE__,
      }),

      // window and menu
      setMenu: (tree) => send('menu:set', tree),
      editAction: (a) => send('edit:action', a),
      message: (o) => invoke('dialog:message', o),
      win: (a) => send('win', a),
      newWindow: () => send('window:new'),
      setDirty: (d) => send('dirty', d),
      reveal: (p) => send('reveal', p),
      onCloseRequest: (cb) => ipcRenderer.on('close-request', () => cb()),
      closeAnswer: (ok) => send('close-answer', ok),
      /** Subscribes to a channel the main process pushes to (only the allowed ones). */
      on: (ch, cb) => {
        if (RECEIVE_CHANNELS.has(ch)) ipcRenderer.on(ch, (_e, payload) => cb(payload));
      },

      // drawing files
      openFile: (opts) => invoke('file:open', opts),
      readFile: (f) => invoke('file:read', f),
      recentList: () => invoke('recent:list'),
      recentAdd: (o) => invoke('recent:add', o),
      recentThumbnail: (o) => invoke('recent:thumbnail', o),
      recentRemove: (p) => invoke('recent:remove', p),
      samplesList: () => invoke('samples:list'),
      saveFile: (o) => invoke('file:save', o),
      saveChunks: (o) => invoke('file:saveChunks', o),
      saveBinary: (o) => invoke('file:saveBinary', o),
      pickSave: (o) => invoke('file:pickSave', o),
      /** The real path of a dropped File object ('' when it cannot be resolved). */
      pathForFile: (f) => {
        try {
          return webUtils.getPathForFile(f);
        } catch {
          return '';
        }
      },

      // DWG, PDF and plotting
      dwgWrite: (o) => invoke('dwg:write', o),
      dwgTools: () => invoke('dwg:tools'),
      pdfImport: (f) => invoke('pdf:import', f),
      plotPdf: (o) => invoke('plot:pdf', o),

      // file system for AutoLISP
      fsAppDir: () => invoke('fs:appdir'),
      fsRead: (p) => invoke('fs:read', p),
      fsWrite: (p, t) => invoke('fs:write', p, t),
      fsRemove: (p) => invoke('fs:remove', p),
      readBinary: async (p) => {
        const b = await invoke('fs:readBinary', p);
        return b ? new Uint8Array(b) : null;
      },

      // local AI assistant
      aiChat: (o) => invoke('ai:chat', o),
      aiModels: (o) => invoke('ai:models', o),
      aiStart: (o) => invoke('ai:start', o),
      aiKeyInfo: () => invoke('ai:keyinfo'),

      // trial and licence
      licenseStatus: () => invoke('license:status'),
      subscriptionProducts: () => invoke('subscription:products'),
      subscriptionPurchase: (id) => invoke('subscription:purchase', id),
      subscriptionRestore: () => invoke('subscription:restore'),
      subscriptionManage: () => invoke('subscription:manage'),
      licenseActivate: (key) => invoke('license:activate', key),
      licenseRemove: () => invoke('license:remove'),
      licenseBuy: () => invoke('license:buy'),
    };
  }
}

/* ============================================================================================
 * 4. EXPOSE
 * ========================================================================================== */
contextBridge.exposeInMainWorld('api', PreloadApi.build());
