/**
 * @file main.js
 * @brief MacCAD main process: window, native menu, file dialogs, PDF plotting, IPC handlers.
 *
 * Layout of this file:
 *   1. includes and constants
 *   2. FileLoader   - turns a file on disk into the object the renderer opens
 *   3. NativeMenu   - builds the macOS menu bar from the structure the renderer sends
 *   4. MacCadApp    - owns the window and registers every IPC handler, grouped by topic
 *   5. start-up
 *
 * The renderer (the page) has no Node access. It reaches this process only through the functions
 * listed in preload.js, and every one of them ends in a handler registered below.
 */

/* ============================================================================================
 * 1. INCLUDES AND CONSTANTS
 * ========================================================================================== */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
// These Chromium switches are separate from the Node inspector fuses.
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some(
  (flag) => app.commandLine.hasSwitch(flag),
)) app.exit(1);

const fs = require('fs');
const path = require('path');
const { readDwg } = require('./dwgreader');
const { decodeDxf } = require('./textdecode');
const { splitBigMcad } = require('./bigmcad');
const ai = require('./ai');
const { readPdf } = require('./pdfreader');
const { writeDwg, findOda } = require('./dwgwriter');
const license = require('./licensing');
const StartSupport = require('./start');
const security = require('./security');

const EDITION = typeof __MACCAD_EDITION__ === 'undefined' ? '3d' : __MACCAD_EDITION__;
const HAS_3D = typeof __MACCAD_HAS_3D__ === 'undefined' ? true : __MACCAD_HAS_3D__;
const APP_NAME = `MacCAD 2027 ${HAS_3D ? '3D' : '2D'}`;

/** From this size (bytes) a .mcad is read in pieces (see bigmcad.js). */
const BIG_MCAD_BYTES = 100e6;

/** File types the app opens from the command line / Finder. */
const OPENABLE = HAS_3D ? /\.(mcad|dxf|dwg|step|stp|stl)$/i : /\.(mcad|dxf|dwg)$/i;

/* ============================================================================================
 * 2. FILE LOADER
 * ========================================================================================== */

/** Reads a drawing or model file into the object the renderer opens. */
class FileLoader {
  /**
   * @param {string} f path of the file
   * @returns {Promise<object>} `{name, path, ...}` plus one of: `dwg` (parsed DWG database),
   *          `stepBytes` (raw STEP bytes), `data` + `breps` (a big .mcad split in pieces), or `data` (text)
   */
  static async load(f) {
    if (!HAS_3D && /\.(step|stp|stl)$/i.test(f))
      throw new Error('STEP and STL files require the MacCAD 2027 3D edition.');
    const isSample = StartSupport.isSample(f);
    if (/\.dwg$/i.test(f)) return { name: path.basename(f), path: f, isSample, dwg: await readDwg(f) };
    const raw = fs.readFileSync(f);
    if (/\.stl$/i.test(f)) return { name: path.basename(f), path: f, isSample, stlBytes: raw };
    // STEP: handed over as bytes, never as a string (a JavaScript string holds about 512 MB at
    // most, and big assemblies are more than that)
    if (/\.(step|stp)$/i.test(f)) return { name: path.basename(f), path: f, isSample, stepBytes: raw };
    if (/\.(mcad|json)$/i.test(f) && raw.length > BIG_MCAD_BYTES)
      return { name: path.basename(f), path: f, isSample, ...splitBigMcad(raw) };
    return {
      name: path.basename(f),
      path: f,
      isSample,
      data: /\.dxf$/i.test(f) ? decodeDxf(raw) : raw.toString('utf8'),
    };
  }
}

/* ============================================================================================
 * 3. NATIVE MENU
 * ========================================================================================== */

/** Builds the menu bar. */
class NativeMenu {
  /**
   * The small fixed menu used until the renderer sends its own structure.
   * @param {(cmd: string) => void} send sends a menu command to the window
   * @returns {Electron.Menu}
   */
  static buildDefault(send) {
    const isMac = process.platform === 'darwin';
    const tpl = [
      ...(isMac
        ? [
            {
              label: APP_NAME,
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'Start Page', click: () => send('START') },
          { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('NEW') },
          { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => send('OPEN') },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('SAVE') },
          { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('SAVEAS') },
          { label: 'Plot...', accelerator: 'CmdOrCtrl+P', click: () => send('PLOT') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'togglefullscreen' },
          ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }]),
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
    ];
    return Menu.buildFromTemplate(tpl);
  }

  /** @private @returns {string} the renderer's key text ("Ctrl+Z") as an Electron accelerator. */
  static toAccel(k) {
    return String(k)
      .replace(/Ctrl\+/g, 'CmdOrCtrl+')
      .replace(/Shift\+Ctrl/g, 'CmdOrCtrl+Shift');
  }

  /**
   * Converts the renderer's menu items into Electron menu items.
   * @private
   * @param {object[]} items `{label, id, key, disabled, checked, sub, type}` items
   * @param {(id: string) => void} run runs the menu command with this id in the window
   * @returns {object[]}
   */
  static convertItems(items, run) {
    return items.map((it) => {
      if (it.type === 'separator') return { type: 'separator' };
      const o = { label: it.label, enabled: !it.disabled };
      if (it.checked !== undefined) {
        o.type = 'checkbox';
        o.checked = !!it.checked;
      }
      if ((it.key && /^(CmdOrCtrl|Ctrl|F\d+)/.test(it.key)) || (it.key && /^Ctrl/.test(it.key)))
        o.accelerator = NativeMenu.toAccel(it.key);
      if (it.sub) o.submenu = NativeMenu.convertItems(it.sub, run);
      else o.click = () => run(it.id);
      return o;
    });
  }

  /**
   * The native macOS menu bar: the renderer owns the menu structure (labels, checks, enabled
   * state) and sends it here.
   * @param {object[]} tree top-level menus `{label, items}`
   * @param {(cmd: string) => void} send sends a named menu command to the window
   * @param {(id: string) => void} run runs a menu item by id in the window
   * @returns {Electron.Menu}
   */
  static buildFromTree(tree, send, run) {
    const tpl = [
      {
        label: APP_NAME,
        submenu: [
          { label: `About ${APP_NAME}`, click: () => send('ABOUT') },
          { type: 'separator' },
          { label: 'Settings...', accelerator: 'Cmd+,', click: () => send('OPTIONS') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
    ];
    for (const m of tree) {
      if (m.label === 'Window') {
        tpl.push({
          label: 'Window',
          role: 'window',
          submenu: [
            ...NativeMenu.convertItems(m.items, run),
            { type: 'separator' },
            { role: 'minimize' },
            { role: 'zoom' },
            { role: 'front' },
          ],
        });
        continue;
      }
      const sub = NativeMenu.convertItems(m.items, run);
      if (m.label === 'View') sub.push({ type: 'separator' }, { role: 'togglefullscreen' });
      tpl.push(
        m.label === 'Help' ? { role: 'help', submenu: sub } : { label: m.label, submenu: sub },
      );
    }
    return Menu.buildFromTemplate(tpl);
  }
}

/* ============================================================================================
 * 4. THE APPLICATION
 * ========================================================================================== */

/** Owns the window and wires every IPC handler. */
class MacCadApp {
  constructor() {
    /** @type {Electron.BrowserWindow|null} the main window */
    this.win = null;
    /** Every drawing window. `win` is the currently focused one. */
    this.windows = new Set();
    /** Windows whose renderer already confirmed its save/discard questions. */
    this.forceClosing = new WeakSet();
    this.forceCloseAll = false;
    /** Files given on the command line / by Finder before the window finished loading. */
    this.pendingOpen = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => OPENABLE.test(a));
  }

  // ---------------------------------------------------------------- small helpers

  /** Sends a named menu command to the window (no-op without a window). */
  send(cmd) {
    if (this.win) this.win.webContents.send('menu', cmd);
  }

  /** Runs a menu item by id in the window (no-op without a window). */
  runMenu(id) {
    if (this.win) this.win.webContents.send('menu-run', id);
  }

  /**
   * Asks for a save location when the caller did not give a path.
   * @private
   * @returns {Promise<string|null>} the chosen path, or null when cancelled
   */
  async chooseTarget(p, defaultName, filters) {
    if (p) return p;
    const r = await dialog.showSaveDialog(this.win, { defaultPath: defaultName, filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  /** @private Copies an existing file to "<name>.bak" before it is overwritten (best effort). */
  backup(target, stripExt = /\.[^.\\/]+$/) {
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, target.replace(stripExt, '') + '.bak');
    } catch {
      /* backup is best effort */
    }
  }

  // ---------------------------------------------------------------- window

  /** Creates the main window and loads the renderer. */
  createWindow({ showSplash = true } = {}) {
    const win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 600,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 8 } }
        : { frame: false }),
      backgroundColor: '#ececec',
      show: false,
      title: APP_NAME,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        devTools: !app.isPackaged,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.win = win;
    this.windows.add(win);
    win.on('focus',()=>{this.win=win;});
    const started = Date.now();
    const splash = showSplash ? StartSupport.showSplash() : null;
    const closeSplash = () => {
      if (splash && !splash.isDestroyed()) splash.destroy();
    };
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => {
      // keep the picture on screen for a moment, so that it can be seen
      setTimeout(() => {
        if (!win.isDestroyed()) win.show();
        closeSplash();
      }, showSplash ? Math.max(0, 650 - (Date.now() - started)) : 0);
    });
    win.webContents.on('did-fail-load', closeSplash);
    win.once('closed', closeSplash);
    win.webContents.on('did-finish-load', () => {
      const pending=[...this.pendingOpen];this.pendingOpen=[];
      win.webContents.send('startup:ready', { openingFile: pending.length > 0 });
      for (const f of pending) this.sendOpen(f,win);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      // a link in a drawing may carry any address: only web and mail links are handed to the system
      if (security.isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // the page never navigates away from the application itself
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('will-redirect', (e) => e.preventDefault());
    win.on('close', (e) => {
      if (this.forceCloseAll || this.forceClosing.has(win)) return;
      e.preventDefault();
      win.webContents.send('close-request');
    });
    win.on('closed', () => {
      this.windows.delete(win);
      if(this.win===win)this.win=[...this.windows].at(-1)||null;
    });
    return win;
  }

  /** Loads a file and hands it to the window (an error dialog when it cannot be read). */
  async sendOpen(file,target=this.win) {
    if (target) target.webContents.send('file:opening');
    try {
      const f = await FileLoader.load(file);
      if (target&&!target.isDestroyed()) target.webContents.send('open-file', f);
    } catch (e) {
      dialog.showErrorBox(APP_NAME, `Cannot open ${file}\n${e.message}`);
    }
  }

  // ---------------------------------------------------------------- application events

  /** Registers the application-level events (open-file, ready, activate, window-all-closed). */
  registerAppEvents() {
    app.on('open-file', (e, file) => {
      e.preventDefault();
      if (this.win && this.win.webContents && !this.win.webContents.isLoading())
        this.sendOpen(file);
      else this.pendingOpen.push(file);
    });
    app.whenReady().then(() => {
      const { session } = require('electron');
      session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(security.isAllowedPermission(permission)));
      session.defaultSession.setPermissionCheckHandler((wc, permission) => security.isAllowedPermission(permission));
      Menu.setApplicationMenu(NativeMenu.buildDefault((cmd) => this.send(cmd)));
      this.createWindow();
      app.on('activate', () => {
        if (!this.win) {
          this.createWindow();
        }
      });
    });
    app.on('window-all-closed', () => app.quit());
  }

  // ---------------------------------------------------------------- IPC: window, menu, editing

  /** Window buttons, close handshake, native menu bar, edit actions, message sheets. */
  registerWindowIpc() {
    ipcMain.on('win', (e, action) => {
      const win = BrowserWindow.fromWebContents(e.sender) || this.win;
      if (!win) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'close') win.close();
      else if (action === 'quit') {
        this.forceCloseAll = true;
        app.quit();
      }
    });
    ipcMain.on('window:new',()=>this.createWindow({showSplash:false}));
    // native macOS menu bar: the renderer owns the menu structure and sends it here
    ipcMain.on('menu:set', (e, tree) => {
      try {
        Menu.setApplicationMenu(
          NativeMenu.buildFromTree(
            tree,
            (cmd) => this.send(cmd),
            (id) => this.runMenu(id),
          ),
        );
      } catch (err) {
        console.error('menu', err.message);
      }
    });
    // text editing inside the command line / dialog fields (the menu accelerators take the keys first)
    ipcMain.on('edit:action', (e, a) => {
      const wc = this.win && this.win.webContents;
      if (!wc) return;
      ({
        undo: () => wc.undo(),
        redo: () => wc.redo(),
        cut: () => wc.cut(),
        copy: () => wc.copy(),
        paste: () => wc.paste(),
        selectAll: () => wc.selectAll(),
      })[a]?.();
    });
    // native message sheet (Save changes? / alerts)
    ipcMain.handle('dialog:message', async (e, o = {}) => {
      const lines = String(o.message || '').split('\n');
      const owner=BrowserWindow.fromWebContents(e.sender)||this.win;
      const r = await dialog.showMessageBox(owner, {
        type: o.type || 'question',
        message: lines[0],
        detail: lines.slice(1).join('\n') || undefined,
        buttons: o.buttons || ['OK'],
        defaultId: o.defaultId ?? 0,
        cancelId: o.cancelId ?? -1,
        noLink: true,
      });
      return r.response;
    });
    ipcMain.on('close-answer', (e, ok) => {
      if (ok) {
        const win=BrowserWindow.fromWebContents(e.sender)||this.win;
        const last=this.windows.size<=1;
        if(win){this.forceClosing.add(win);win.close();}
        if(last)app.quit();
      }
    });
    ipcMain.on('reveal', (e, p) => {
      if (typeof p === 'string' && p) shell.showItemInFolder(p);
    });
    ipcMain.on('dirty', (e, d) => {
      const win=BrowserWindow.fromWebContents(e.sender)||this.win;
      if (win && process.platform === 'darwin') win.setDocumentEdited(!!d);
    });
  }

  // ---------------------------------------------------------------- IPC: opening files

  /** Open dialog, drag-and-drop reads, PDF import. */
  registerOpenIpc() {
    ipcMain.handle('file:open', async (e, opts = {}) => {
      const r = await dialog.showOpenDialog(this.win, {
        properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: opts.filters || [
          {
            name: HAS_3D ? 'Drawings and 3D models (DWG, DXF, MCAD, STEP, STL)' : '2D drawings (DWG, DXF, MCAD)',
            extensions: HAS_3D ? ['dwg', 'dxf', 'mcad', 'json', 'step', 'stp', 'stl'] : ['dwg', 'dxf', 'mcad', 'json'],
          },
          { name: 'AutoLISP', extensions: ['lsp', 'scr'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const one = async (p) => {
        try {
          return await FileLoader.load(p);
        } catch (err) {
          dialog.showErrorBox(APP_NAME, `Cannot open ${p}\n${err.message}`);
          return null;
        }
      };
      if (!opts.multi) return one(r.filePaths[0]);
      const list = [];
      for (const p of r.filePaths) {
        const f = await one(p);
        if (f) list.push(f);
      } // one drawing per tab, in the order chosen
      return list.length ? list : null;
    });
    ipcMain.handle('recent:list', () => StartSupport.recentList());
    ipcMain.handle('recent:add', (e, entry) => StartSupport.recentAdd(entry));
    ipcMain.handle('recent:thumbnail', (e, entry) => StartSupport.recentThumbnail(entry));
    ipcMain.handle('recent:remove', (e, p) => StartSupport.recentRemove(p));
    ipcMain.handle('samples:list', () => StartSupport.samplesList());
    ipcMain.handle('file:read', async (e, f) => {
      try {
        return await FileLoader.load(f);
      } catch (err) {
        return { error: err.message };
      }
    });
    ipcMain.handle('pdf:import', async (e, f) => {
      let file = f;
      if (!file) {
        const r = await dialog.showOpenDialog(this.win, {
          properties: ['openFile'],
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (r.canceled || !r.filePaths[0]) return null;
        file = r.filePaths[0];
      }
      try {
        const d = await readPdf(file, 1);
        d.name = path.basename(file);
        return d;
      } catch (err) {
        return { error: err.message };
      }
    });
  }

  // ---------------------------------------------------------------- IPC: local AI

  /** Local LLM (loopback only unless the user allows otherwise): errors come back as `{ok:false, error}`. */
  registerAiIpc() {
    const wrap = (fn) => async (e, o) => {
      try {
        return await fn(o || {});
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };
    ipcMain.handle('ai:chat', wrap(ai.chat));
    ipcMain.handle('ai:keyinfo', wrap(ai.keyInfo));
    ipcMain.handle('ai:start', wrap((options) => process.mas
      ? { ok: false, error: 'Start Ollama outside MacCAD, then connect to its local endpoint.' }
      : ai.startServer(options)));
    ipcMain.handle('ai:models', wrap(ai.models));
  }

  // ---------------------------------------------------------------- IPC: file system for AutoLISP

  /** Plain file access for AutoLISP, plus the one read of bundled vendor files. */
  registerFsIpc() {
    ipcMain.handle('fs:appdir', () => app.getPath('userData'));
    ipcMain.handle('fs:read', (e, p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });
    ipcMain.handle('fs:write', async (e, p, t) => {
      if (process.mas && await license.outputBlocked(p)) return false;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, t, 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.handle('fs:readBinary', (e, p) => {
      // only the bundled vendor files (3D kernel wasm) may be read this way
      try {
        const root = path.join(app.getAppPath(), 'src', 'renderer', 'vendor') + path.sep;
        const f = path.resolve(String(p));
        if (!f.startsWith(root)) return null;
        return fs.readFileSync(f);
      } catch {
        return null;
      }
    });
    ipcMain.handle('fs:remove', async (e, p) => {
      if (process.mas && await license.outputBlocked(p)) return false;
      try {
        fs.unlinkSync(p);
        return true;
      } catch {
        return false;
      }
    });
  }

  // ---------------------------------------------------------------- IPC: saving and plotting

  /**
   * Saving drawings, DWG output and PDF plots. After the trial (no licence key) every handler
   * here refuses to write (see `license.outputBlocked`).
   */
  registerSaveIpc() {
    ipcMain.handle('file:pickSave', async (e, { defaultName, filters, path: p }) => {
      const r = await dialog.showSaveDialog(this.win, { defaultPath: p || defaultName, filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
    ipcMain.handle('file:save', async (e, { path: p, defaultName, data, filters }) => {
      if (await license.outputBlocked(p || defaultName)) return null; // trial ended and no licence key
      const target = await this.chooseTarget(p, defaultName, filters);
      if (!target) return null;
      this.backup(target);
      fs.writeFileSync(target, data, 'utf8');
      return target;
    });
    // a drawing as a list of strings (see Doc.fileChunks): written one after the other, so no
    // single string has to hold the whole file
    ipcMain.handle('file:saveChunks', async (e, { path: p, defaultName, chunks, filters }) => {
      if (await license.outputBlocked(p || defaultName)) return null;
      const target = await this.chooseTarget(p, defaultName, filters);
      if (!target) return null;
      this.backup(target);
      const tmp = target + '.saving';
      const fd = fs.openSync(tmp, 'w');
      try {
        for (const c of chunks) fs.writeSync(fd, Buffer.from(c, 'utf8'));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target); // the old file stays whole until the new one is complete
      return target;
    });
    ipcMain.handle('dwg:write', async (e, { dxf, outPath, version, verify }) => {
      if (await license.outputBlocked(outPath))
        return {
          ok: false,
          error: process.mas ? 'An active App Store subscription is required. Open LICENSE.' : 'The 15-day trial has ended. Enter a licence key (command LICENSE).',
        };
      this.backup(outPath, /\.dwg$/i);
      const r = await writeDwg({ dxf, outPath, version });
      if (r.ok && verify) {
        try {
          const db = await readDwg(outPath);
          const c = {};
          for (const en of db.entities) c[en.type] = (c[en.type] || 0) + 1;
          r.readBack = {
            entities: db.entities.length,
            types: c,
            layers: db.layers.length,
            blocks: db.blocks.length,
          };
        } catch (err) {
          r.readBackError = err.message;
        }
      }
      return r;
    });
    ipcMain.handle('dwg:tools', () => ({ oda: !!findOda() }));
    ipcMain.handle('file:saveBinary', async (e, { defaultName, data, filters }) => {
      if (await license.outputBlocked(defaultName)) return null;
      const r = await dialog.showSaveDialog(this.win, { defaultPath: defaultName, filters });
      if (r.canceled || !r.filePath) return null;
      fs.writeFileSync(r.filePath, Buffer.from(data));
      return r.filePath;
    });
    ipcMain.handle('plot:pdf', async (e, { svg, W, H, defaultName }) => {
      if (await license.outputBlocked(defaultName)) return null;
      const r = await dialog.showSaveDialog(this.win, {
        defaultPath: defaultName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return null;
      const hidden = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: false, sandbox: true, devTools: !app.isPackaged },
      });
      const html = `<!doctype html><html><head><style>@page{size:${W}mm ${H}mm;margin:0}html,body{margin:0;padding:0;background:#fff}svg{display:block;width:${W}mm;height:${H}mm}</style></head><body>${svg.replace(/^<\?xml[^>]*>\s*/, '')}</body></html>`;
      await hidden.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await hidden.webContents.printToPDF({
        pageSize: { width: W / 25.4, height: H / 25.4 },
        printBackground: true,
        margins: { marginType: 'none' },
        preferCSSPageSize: true,
      });
      hidden.destroy();
      fs.writeFileSync(r.filePath, pdf);
      return r.filePath;
    });
  }

  // ---------------------------------------------------------------- start

  /** Registers everything; call once, before the app is ready. */
  start() {
    app.setName(APP_NAME);
    if (process.platform === 'darwin' && !app.isPackaged) {
      try {
        app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
      } catch {
        /* dev only */
      }
    }
    security.guardIpc(ipcMain); // from here on every handler answers the application's own page only
    this.registerAppEvents();
    this.registerWindowIpc();
    this.registerOpenIpc();
    this.registerAiIpc();
    this.registerFsIpc();
    license.register(); // 15-day trial and licence keys (licensecore.js, license.js)
    this.registerSaveIpc();
  }
}

/* ============================================================================================
 * 5. START-UP
 * ========================================================================================== */
const macCad = new MacCadApp();
// test hook (inspector), off unless the env var is set
if (!app.isPackaged && process.env.MACCAD_DEBUG)
  globalThis.__maccad = { electron: require('electron'), getWin: () => macCad.win };
macCad.start();
