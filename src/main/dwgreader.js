/**
 * @file dwgreader.js
 * @brief DWG reader (main process).
 *
 * Uses LibreDWG compiled to WebAssembly (@mlightcad/libredwg-web, GPL-3.0). The result is a
 * slimmed-down, structured-clone-safe database that the renderer maps onto its own document model
 * (see dwg.js in the renderer).
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const path = require('path');
const fs = require('fs');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Header variables copied from the DWG into the result. */
const HEADER_KEYS = [
  'ACADVER',
  'INSUNITS',
  'LTSCALE',
  'PDMODE',
  'PDSIZE',
  'DIMSCALE',
  'TEXTSIZE',
  'LUNITS',
  'LUPREC',
  'AUNITS',
  'AUPREC',
  'LIMMIN',
  'LIMMAX',
  'EXTMIN',
  'EXTMAX',
  'LWDISPLAY',
  'TILEMODE',
  'CLAYER',
];

/** Keys dropped while cleaning (they are large or cannot be cloned between processes). */
const DROPPED_KEYS = new Set([
  'xdata',
  'ownerDictionaryHardId',
  'transparencyType',
  'thumbnailImage',
]);

/** Dimension-style variables kept per dimension style. */
const DIMSTYLE_KEYS = [
  'DIMSCALE',
  'DIMASZ',
  'DIMEXO',
  'DIMEXE',
  'DIMTXT',
  'DIMGAP',
  'DIMDEC',
  'DIMLFAC',
  'DIMPOST',
];

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Reads DWG files through the WebAssembly LibreDWG. */
class DwgReader {
  /**
   * Loads the WebAssembly library once and keeps it.
   * @private
   * @returns {Promise<{lib: object, mod: object}>}
   */
  static getLib() {
    if (!DwgReader.libPromise) {
      DwgReader.libPromise = (async () => {
        const mod = await import('@mlightcad/libredwg-web');
        let dir =
          path.join(path.dirname(require.resolve('@mlightcad/libredwg-web')), '..', 'wasm') +
          path.sep;
        // inside the packaged app the .wasm files are unpacked next to app.asar
        dir = dir.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        const lib = await mod.LibreDwg.create(dir);
        return { lib, mod };
      })();
    }
    return DwgReader.libPromise;
  }

  /**
   * Makes a value safe to send between processes: BigInt -> Number, drops the keys in DROPPED_KEYS.
   * @private
   * @param {*} v any value read from the DWG
   * @returns {*} the cleaned copy
   */
  static strip(v) {
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v)) return v.map(DwgReader.strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        if (DROPPED_KEYS.has(k)) continue;
        o[k] = DwgReader.strip(x);
      }
      return o;
    }
    return v;
  }

  /**
   * Reads a DWG file.
   * @param {string} file path of the .dwg
   * @returns {Promise<object>} `{header, layers, ltypes, styles, dimstyles, blocks, entities, layouts}`
   * @throws {Error} when the file cannot be read
   */
  static async read(file) {
    const buf = fs.readFileSync(file);
    const { lib, mod } = await DwgReader.getLib();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const dwg = lib.dwg_read_data(ab, mod.Dwg_File_Type.DWG);
    if (!dwg) throw new Error('This DWG file could not be read.');
    const db = lib.convert(dwg);
    try {
      lib.dwg_free(dwg);
    } catch {
      /* ignore */
    }
    const header = {};
    for (const k of HEADER_KEYS)
      if (db.header && db.header[k] !== undefined) header[k] = DwgReader.strip(db.header[k]);
    return DwgReader.strip({
      header,
      layers: db.tables.LAYER.entries,
      ltypes: db.tables.LTYPE.entries,
      styles: db.tables.STYLE.entries,
      dimstyles: db.tables.DIMSTYLE.entries.map((d) => {
        const o = { name: d.name };
        for (const k of DIMSTYLE_KEYS) o[k] = d[k];
        return o;
      }),
      blocks: db.tables.BLOCK_RECORD.entries.map((b) => ({
        handle: b.handle,
        name: b.name,
        basePoint: b.basePoint,
        layout: b.layout,
        entities: b.entities,
      })),
      entities: db.entities,
      layouts: (db.objects.LAYOUT || []).map((l) => ({
        name: l.layoutName,
        tab: l.tabOrder,
        block: l.paperSpaceTableId,
        handle: l.handle,
      })),
    });
  }
}

/** @private Promise of the loaded library (shared by all reads). */
DwgReader.libPromise = null;

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
module.exports = { DwgReader, readDwg: DwgReader.read };
