/**
 * @file dwgwriter.js
 * @brief DWG writer (main process): converts a DXF R2000 text to a DWG file.
 *
 * Two engines, tried in this order:
 *   1. ODA File Converter (free, Open Design Alliance) if it is installed: best fidelity, any
 *      AutoCAD release.
 *   2. The bundled LibreDWG `dxf2dwg` (GPL-3.0): DWG R2000, which opens in AutoCAD 2000 and every
 *      later version.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Places the ODA File Converter is looked for. */
const ODA_PATHS = [
  '/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter',
  path.join(os.homedir(), 'Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter'),
];
const CONVERT_TIMEOUT_MS = 180000;
const CONVERT_MAX_BUFFER = 64 * 1024 * 1024;
/** A DWG smaller than this many bytes is treated as a failed conversion. */
const MIN_DWG_BYTES = 100;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static helpers that write DWG files through an external converter. */
class DwgWriter {
  /** @returns {boolean} true when the path exists (never throws). */
  static exists(p) {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }

  /** @returns {string|undefined} path of the installed ODA File Converter, if any. */
  static findOda() {
    if (process.mas) return undefined; // Store sandbox uses the bundled converter.
    return ODA_PATHS.find(DwgWriter.exists);
  }

  /** @returns {string|undefined} path of the bundled `dxf2dwg` binary (packaged app or source tree). */
  static bundledBinary() {
    const rel = path.join('bin', 'dxf2dwg');
    const cands = [
      app.isPackaged
        ? path.join(process.resourcesPath, rel)
        : path.join(__dirname, '..', '..', rel),
      path.join(__dirname, '..', '..', rel),
    ];
    return cands.find(DwgWriter.exists);
  }

  /**
   * Runs a program and resolves with its result (never rejects).
   * @private
   * @returns {Promise<{err: Error|null, stdout: string, stderr: string}>}
   */
  static run(bin, args, opts = {}) {
    return new Promise((resolve) =>
      execFile(
        bin,
        args,
        { timeout: CONVERT_TIMEOUT_MS, maxBuffer: CONVERT_MAX_BUFFER, ...opts },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }),
      ),
    );
  }

  /**
   * Converts DXF text to a DWG file.
   * @param {{dxf: string, outPath: string, version?: string}} job the DXF text, where to write the
   *        DWG, and the engine choice ('auto' or a version containing "oda" tries ODA first)
   * @returns {Promise<{ok: boolean, engine: string, warnings: string[], error?: string}>}
   */
  static async write({ dxf, outPath, version }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maccad-dwg-'));
    const base = path.basename(outPath).replace(/\.dwg$/i, '');
    const inDxf = path.join(tmp, `${base}.dxf`);
    fs.writeFileSync(inDxf, dxf, 'utf8');
    const result = { ok: false, engine: '', warnings: [] };
    try {
      const oda =
        (version && /oda/i.test(version)) || version === 'auto' ? DwgWriter.findOda() : null;
      if (oda && (await DwgWriter.viaOda(oda, tmp, base, outPath, result))) return result;
      return await DwgWriter.viaLibreDwg(tmp, base, inDxf, outPath, result);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Engine 1: ODA File Converter.
   * @private
   * @returns {Promise<boolean>} true when it produced the file (result is filled in)
   */
  static async viaOda(oda, tmp, base, outPath, result) {
    const outDir = path.join(tmp, 'out');
    fs.mkdirSync(outDir);
    const r = await DwgWriter.run(oda, [tmp, outDir, 'ACAD2018', 'DWG', '0', '1', `${base}.dxf`]);
    const produced = path.join(outDir, `${base}.dwg`);
    if (!r.err && fs.existsSync(produced)) {
      fs.copyFileSync(produced, outPath);
      result.ok = true;
      result.engine = 'ODA File Converter (AutoCAD 2018 DWG)';
      return true;
    }
    result.warnings.push('ODA File Converter failed; falling back to the bundled writer.');
    return false;
  }

  /**
   * Engine 2: the bundled LibreDWG dxf2dwg (DWG R2000).
   * @private
   * @returns {Promise<object>} the filled-in result
   */
  static async viaLibreDwg(tmp, base, inDxf, outPath, result) {
    const bin = DwgWriter.bundledBinary();
    if (!bin) {
      result.error = 'The bundled DWG writer (dxf2dwg) was not found.';
      return result;
    }
    const produced = path.join(tmp, `${base}.out.dwg`);
    const r = await DwgWriter.run(bin, ['-y', '--as', 'r2000', '-o', produced, inDxf]);
    if (!fs.existsSync(produced) || fs.statSync(produced).size < MIN_DWG_BYTES) {
      result.error = `DWG conversion failed: ${(r.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ') || (r.err && r.err.message)}`;
      return result;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(produced, outPath);
    result.ok = true;
    result.engine = 'LibreDWG dxf2dwg (DWG R2000)';
    result.warnings.push(
      ...(r.stderr || '')
        .split('\n')
        .filter((l) => /^Warning|ERROR/i.test(l))
        .slice(0, 8),
    );
    return result;
  }
}

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
module.exports = {
  DwgWriter,
  writeDwg: DwgWriter.write,
  findOda: DwgWriter.findOda,
  bundledBinary: DwgWriter.bundledBinary,
};
