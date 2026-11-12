/**
 * @file main.js
 * @brief Renderer entry point: builds the app, the user interface and the licence watcher.
 *
 * Loaded by index.html. Everything else is imported from here, so this file stays small and holds
 * only start-up wiring.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { createApp } from './app.js';
import { initUI } from './ui.js';
import { license } from './license.js';
import { StartScreen } from './start.js';
import { applyUiMode, chooseUiMode } from './uimode.js';
import { initPalette } from './palette.js';
import { HAS_3D } from './features.js';

/* ============================================================================================
 * 2. START-UP CLASS
 * ========================================================================================== */

/** Wires the app, the user interface and the licence messages together. */
class Startup {
  /** Creates the app on an off-screen canvas, builds the UI and starts the licence watcher. */
  constructor() {
    /** The application object (also reachable as `window.__app` for debugging). */
    this.app = createApp(document.createElement('canvas'));
    /** True while the 15-day trial is running; used to notice when it ends. */
    this.wasTrial = false;
  }

  /** Runs the whole start-up sequence. */
  run() {
    initUI(this.app);
    if (HAS_3D) initPalette(this.app);
    applyUiMode(this.app);
    this.app.on('settings', () => applyUiMode(this.app));
    if (!this.app.settings.uiModeChosen) chooseUiMode(this.app).then(() => {
        this.showStartScreen();
        this.showNow(); // the "ready" message of the main process came long ago
      });
    else this.showStartScreen();
    this.watchLicense();
    if (typeof __MACCAD_RELEASE__ === 'undefined' || !__MACCAD_RELEASE__) window.__app = this.app; // handy for debugging in dev tools
  }

  /** Shows the list of recent drawings, unless a file is opened on start (double click in Finder). */
  showStartScreen() {
    this.app.startScreen = new StartScreen(this.app);
    const show = () => {
      const empty = this.app.tabs.length <= 1 && this.app.doc.model.length === 0 && !this.app.doc.path;
      if (empty && !this.app.openingFile) this.app.startScreen.show();
    };
    this.showNow = show;
    if (window.api) {
      window.api.on('file:opening', () => this.app.startScreen.hide());
      window.api.on('startup:ready', (state) => { if (!state.openingFile) show(); });
    } else show();
  }

  /** Says the licence state once at start, and again when the trial ends while the program is open. */
  watchLicense() {
    license.watch().then((st) => {
      // 15-day trial and licence key: the status bar shows the days left, the command line says it once
      const b = license.badge();
      if (st && st.state !== 'licensed' && b)
        this.app.echo(`${b.text}. Type LICENSE to ${st.provider === 'app-store' ? 'manage your subscription' : 'enter a licence key'}.`);
    });
    license.on((st) => {
      // the trial ended while the program was open: say so (the status bar has turned red)
      if (this.wasTrial && st && st.restricted) this.app.echo(`${license.blockedMessage()}`);
      this.wasTrial = !!(st && st.state === 'trial');
    });
  }
}

new Startup().run();
