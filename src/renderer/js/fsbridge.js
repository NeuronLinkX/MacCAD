import { api } from "./apibridge.js";
/**
 * @file fsbridge.js
 * @brief File-system bridge for AutoLISP (open / load / findfile ...).
 *
 * In the desktop app it reads and writes real files through the preload API (`window.api`); in a
 * plain browser it falls back to a virtual file store kept in localStorage.
 */

/* ============================================================================================
 * 1. CLASS
 * ========================================================================================== */

/** File access used by the LISP interpreter. Create one with `makeFs(app)`. */
export class LispFileSystem {
  /**
   * @param {object} app the application object; its `doc.path` adds the drawing's folder to the search path
   */
  constructor(app) {
    /** @private */
    this.app = app;
    /** @private Desktop bridge, or null in a browser. */
    this.api = api;
    app.api = this.api;
  }

  /** @private @returns {string} localStorage key of a virtual file. */
  static vkey(p) {
    return 'maccad.vfs.' + p;
  }

  /** @private @returns {boolean} true for an absolute path (Unix or drive letter). */
  static isAbs(p) {
    return /^([A-Za-z]:)?[\\/]/.test(p);
  }

  /** @returns {Promise<string>} the application support folder ('' in a browser). */
  async supportDir() {
    return this.api && this.api.fsAppDir ? this.api.fsAppDir() : '';
  }

  /** @returns {Promise<string|null>} file contents, or null when it cannot be read. */
  async readText(p) {
    try {
      if (this.api && this.api.fsRead) {
        const r = await this.api.fsRead(p);
        return r === undefined ? null : r;
      }
      const v = localStorage.getItem(LispFileSystem.vkey(p));
      return v === null ? null : v;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean>} true when the file was written. */
  async writeText(p, text) {
    try {
      if (this.api && this.api.fsWrite) return await this.api.fsWrite(p, text);
      localStorage.setItem(LispFileSystem.vkey(p), text);
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<boolean>} true when a file existed and was removed. */
  async remove(p) {
    try {
      if (this.api && this.api.fsRemove) return await this.api.fsRemove(p);
      const had = localStorage.getItem(LispFileSystem.vkey(p)) !== null;
      localStorage.removeItem(LispFileSystem.vkey(p));
      return had;
    } catch {
      return false;
    }
  }

  /**
   * Every path a name could refer to, in search order: as given, in the drawing's folder, in the
   * support folder's `lisp/` directory; with ".lsp" / ".LSP" appended when the name has no extension.
   * @param {string} name file name or path
   * @returns {Promise<string[]>}
   */
  async candidates(name) {
    const names = /\.[A-Za-z0-9]+$/.test(name) ? [name] : [name, name + '.lsp', name + '.LSP'];
    if (LispFileSystem.isAbs(name)) return names;
    const dirs = [''];
    if (this.app.doc && this.app.doc.path) dirs.push(this.app.doc.path.replace(/[^\\/]*$/, ''));
    const sd = await this.supportDir();
    if (sd) dirs.push(sd.replace(/[\\/]?$/, '/') + 'lisp/');
    const out = [];
    for (const d of dirs) for (const n of names) out.push(d + n);
    return out;
  }

  /** @returns {Promise<string|null>} the first candidate path that can be read (findfile). */
  async find(name) {
    for (const c of await this.candidates(name)) {
      const t = await this.readText(c);
      if (t !== null) return c;
    }
    return null;
  }

  /** @returns {Promise<string|null>} the text of the first readable candidate (load). */
  async readLisp(name) {
    for (const c of await this.candidates(name)) {
      const t = await this.readText(c);
      if (t !== null) return t;
    }
    return null;
  }
}

/* ============================================================================================
 * 2. FACTORY
 * ========================================================================================== */

/**
 * Creates the file-system bridge for an app.
 * @param {object} app the application object (receives `app.api`)
 * @returns {LispFileSystem}
 */
export function makeFs(app) {
  return new LispFileSystem(app);
}
