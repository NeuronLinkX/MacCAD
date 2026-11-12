/**
 * @file io.js
 * @brief File input / output: the native Electron bridge (`window.api`) with a plain-browser fallback.
 *
 * `FileIo` (also exported as `io`) holds everything that opens, saves, exports, plots and closes
 * drawings. Save formats follow the file extension: .mcad (native), .dxf (AutoCAD 2000 DXF), .dwg
 * (AutoCAD 2000 DWG, written by the main process). Nothing can be written after the trial without
 * a licence key (see license.js).
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { openMeshFile } from './commands_hybrid.js';
import { StartScreen } from './start.js';
import { Doc, parseMcad } from './doc.js';
import { exportDXF, importDXF } from './dxf.js';
import { exportDXF2000 } from './dxf2000.js';
import { dwgToDoc } from './dwg.js';
import { toSVG } from './svg.js';
import * as E from './entities.js';
import * as K from './kernel3d.js';
import { exportSolids, isStepFile, openStepFile } from './exchange3d.js';
import { license } from './license.js';

/* ============================================================================================
 * 2. HELPERS
 * ========================================================================================== */

/** Bridge to the main process (null in a plain browser). */
import { api } from './apibridge.js';

/** A4 landscape in millimetres: the paper size of SVG / PNG exports. */
const A4 = { W: 297, H: 210 };

/** @returns {string} a file name without folder and extension. */
const baseName = (p) =>
  (p || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '');

/**
 * Browser fallback: downloads data as a file.
 * @param {string} name file name
 * @param {string|Blob|Uint8Array} data contents
 * @param {string} [mime] type used when `data` is not already a Blob
 */
function browserSave(name, data, mime = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Browser fallback: lets the user pick one text file.
 * @param {string} accept the `accept` list of the file input (".mcad,.dxf")
 * @returns {Promise<{name: string, path: null, data: string}|null>} null when nothing was picked
 */
function browserPick(accept) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => {
      const f = i.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, path: null, data: r.result });
      r.readAsText(f);
    };
    i.click();
  });
}

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static functions for drawing files. Used as `io.saveFile(app, false)`. */
export class FileIo {
  // ---------------------------------------------------------------- closing and new drawings

  /**
   * Asks to save the current drawing if it has unsaved changes.
   * @param {object} app the application
   * @returns {Promise<boolean>} false when the user cancelled (or saving failed)
   */
  static async confirmDiscard(app) {
    if (!app.doc.dirty) return true;
    const r = await app.ui.confirm({
      title: 'MacCAD',
      message: `Save changes to ${app.doc.name}.mcad?`,
      buttons: ['Yes', 'No', 'Cancel'],
    });
    if (r === 'Cancel') return false;
    if (r === 'Yes') return (await FileIo.saveFile(app, false)) !== false;
    return true;
  }

  /**
   * Asks about every drawing with unsaved changes (each one is shown first).
   * @returns {Promise<boolean>} false when the user cancelled
   */
  static async confirmAll(app) {
    for (let i = 0; i < app.tabs.length; i += 1) {
      if (!app.tabs[i].doc.dirty) continue;
      app.activateTab(i);
      if (!(await FileIo.confirmDiscard(app))) return false;
    }
    return true;
  }

  /** @returns {string} the first free "DrawingN" name among the open drawings. */
  static freeName(app) {
    const used = new Set(app.tabs.map((t) => t.doc.name));
    let n = 1;
    while (used.has(`Drawing${n}`)) n += 1;
    return `Drawing${n}`;
  }

  /**
   * NEW / CLOSE: opens an empty drawing in a new tab, or (closeOnly) closes the current one.
   * @param {object} app
   * @param {boolean} [closeOnly]
   */
  static async newDrawing(app, closeOnly) {
    if (app.startScreen) app.startScreen.hide();
    if (closeOnly) {
      await FileIo.closeTab(app, app.tabIndex);
      return;
    }
    const d = new Doc();
    d.name = FileIo.freeName(app);
    app.openTab(d, { keepBlank: true });
    app.echo(`New drawing: ${d.name} (a new tab).`);
  }

  /** Closes tab `i` after asking about unsaved changes. @returns {Promise<boolean>} false when cancelled. */
  static async closeTab(app, i) {
    if (i !== app.tabIndex) app.activateTab(i);
    if (!(await FileIo.confirmDiscard(app))) return false;
    const name = app.doc.name;
    app.dropTab(app.tabIndex);
    app.echo(`Closed ${name}.`);
    return true;
  }

  /** Closes every tab, last first. @returns {Promise<boolean>} false when the user cancelled. */
  static async closeAll(app) {
    for (let i = app.tabs.length - 1; i >= 0; i -= 1) {
      if (i >= app.tabs.length) continue;
      if (!(await FileIo.closeTab(app, i))) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- opening

  /** OPEN: file dialog (several files = one tab each), then `openData` for each. */
  static async openFile(app) {
    const f = api
      ? await api.openFile({ multi: true })
      : await browserPick('.mcad,.json,.dxf,.step,.stp');
    for (const one of Array.isArray(f) ? f : [f]) {
      if (!one) continue;
      if (one.error) {
        await app.ui.alert(one.error);
        continue;
      }
      await FileIo.openData(app, one);
    }
  }

  /**
   * Opens one file the main process (or the browser picker) delivered.
   * @param {object} app
   * @param {{name?: string, path?: string, data?: string, dwg?: object, stepBytes?: Uint8Array}} f
   *        the file: text (`data`), a parsed DWG (`dwg`) or STEP bytes (`stepBytes`)
   */
  static async openData(app, f) {
    app.openingFile = (app.openingFile || 0) + 1;
    if (app.startScreen) app.startScreen.hide();
    try {
      if (f.stlBytes) { await openMeshFile(app, f); if (f.path) StartScreen.record(app, f.path); return; }
      if (isStepFile(f)) {
        await openStepFile(app, f);
        if (f.path && app.doc.model.some((e) => e.type === 'solid3d')) StartScreen.record(app, f.path);
        if (f.isSample) { app.doc.path = null; app.doc.sourcePath = null; }
        return;
      }
      const name = baseName(f.name || f.path);
      let doc;
      if (f.dwg) {
        const r = dwgToDoc(f.dwg, name);
        doc = r.doc;
        r.warnings.forEach((w) => app.echo(w));
        doc.path = null;
        doc.fromDwg = true;
        app.echo(
          `DWG ${f.name || f.path}: ${doc.model.length} objects, ${Object.keys(doc.blocks).length} blocks, ${doc.layers.length} layers imported. Edit it as usual; SAVEAS stores it as .mcad, .dxf or .dwg (R2000).`,
        );
      } else if (/\.dxf$/i.test(f.name || f.path || '')) {
        const r = importDXF(f.data, name);
        doc = r.doc;
        r.warnings.forEach((w) => app.echo(w));
        doc.path = null;
      } else {
        doc = Doc.fromJSON(parseMcad(f));
        doc.name = name || doc.name;
        doc.path = f.path || null;
      }
      // a DWG / DXF is saved as a new .mcad, so it keeps the source path only for the dialog's folder
      if (f.path && (f.dwg || /\.dxf$/i.test(f.path))) {
        doc.sourcePath = f.path;
        doc.path = null;
      }
      if (f.isSample) { doc.path = null; doc.sourcePath = null; }
      const shown = app.openTab(doc);
      if (app.startScreen) app.startScreen.hide();
      if (f.path) StartScreen.record(app, f.path);
      if (shown === doc) app.echo(`Opened ${f.name || f.path}`);
    } catch (e) {
      app.echo(`Cannot open file: ${e.message}`);
      app.ui.alert(`Cannot open file:\n${e.message}`);
    } finally {
      app.openingFile -= 1;
    }
  }

  // ---------------------------------------------------------------- saving

  /**
   * SAVE / SAVEAS. The format follows the file extension: .mcad native, .dxf AutoCAD 2000 DXF, .dwg
   * AutoCAD 2000 DWG.
   * @param {object} app
   * @param {boolean} as true = always ask for a file name (Save As)
   * @returns {Promise<boolean>} false when nothing was saved (cancelled, failed, or the trial is over)
   */
  static async saveFile(app, as) {
    // trial ended (also reached by Cmd+S and by the close question)
    if (license.restricted) {
      app.echo(license.blockedMessage());
      return false;
    }
    await FileIo.loadKernelForSolids(app);
    const doc = app.doc;
    app.saveView();
    doc.modelView = app.space === 'model' ? app.view.save() : doc.modelView;
    let target = !as && doc.path ? doc.path : null;
    const dir = (doc.sourcePath || doc.path || '').replace(/[^\\/]*$/, '');
    if (!target) {
      if (api && api.pickSave) {
        target = await api.pickSave({
          defaultName: `${dir}${doc.name}.mcad`,
          filters: [
            { name: 'MacCAD Drawing (*.mcad)', extensions: ['mcad'] },
            {
              name: 'AutoCAD DWG 2000 - opens in AutoCAD for Windows/Mac (*.dwg)',
              extensions: ['dwg'],
            },
            { name: 'AutoCAD DXF 2000 - opens in any CAD (*.dxf)', extensions: ['dxf'] },
          ],
        });
        if (!target) return false;
      } else {
        target = `${doc.name}.mcad`;
      }
    }
    const ext = (/\.([A-Za-z0-9]+)$/.exec(target) || [, 'mcad'])[1].toLowerCase();
    const name = baseName(target);
    let saved;
    if (ext === 'dwg') saved = await FileIo.saveDwg(app, doc, target, name);
    else if (ext === 'dxf') saved = await FileIo.saveDxf(app, doc, target, name);
    else saved = await FileIo.saveMcad(app, doc, target, name);
    if (!saved) return false;
    target = saved.target;
    if (api) {
      doc.path = target;
      doc.name = baseName(target);
    }
    doc.dirty = false;
    if (api) StartScreen.record(app, target);
    app.emit('doc');
    return true;
  }

  /** @private Writes a DWG through the main process. @returns {Promise<{target: string}|null>} null on failure. */
  static async saveDwg(app, doc, target, name) {
    const dxf = exportDXF2000(doc, { dimensions: 'explode', forDwg: true });
    if (!api || !api.dwgWrite) {
      browserSave(`${name}.dxf`, exportDXF2000(doc), 'text/plain');
      app.echo(
        'DWG writing needs the desktop app; a DXF R2000 file was downloaded instead (open it in AutoCAD and Save As DWG).',
      );
      return null;
    }
    app.echo('Writing DWG...');
    const r = await api.dwgWrite({ dxf, outPath: target, verify: true });
    if (!r.ok) {
      app.echo(`DWG save failed: ${r.error || 'unknown error'}`);
      await app.ui.alert(
        `DWG save failed.\n${r.error || ''}\n\nSave as DXF instead; every AutoCAD version opens DXF.`,
      );
      return null;
    }
    app.echo(`Saved ${target}  [${r.engine}]`);
    if (r.readBack)
      app.echo(
        `Verified by reading it back: ${r.readBack.entities} model objects, ${r.readBack.layers} layers, ${r.readBack.blocks} blocks.`,
      );
    (r.warnings || []).forEach((w) => app.echo(`  ${w}`));
    app.echo(
      'Note: dimensions are stored as plain geometry in DWG files written by MacCAD. Use DXF to keep dimension objects.',
    );
    return { target };
  }

  /** @private Writes an AutoCAD 2000 DXF. @returns {Promise<{target: string}|null>} null when cancelled. */
  static async saveDxf(app, doc, target, name) {
    const data = exportDXF2000(doc, { dimensions: 'objects' });
    if (api) {
      const p = await api.saveFile({
        path: target,
        defaultName: `${name}.dxf`,
        data,
        filters: [{ name: 'DXF', extensions: ['dxf'] }],
      });
      if (!p) return null;
      target = p;
    } else browserSave(`${name}.dxf`, data);
    app.echo(`Saved ${target}  [AutoCAD 2000 DXF]`);
    return { target };
  }

  /** @private Writes the native .mcad. @returns {Promise<{target: string}|null>} null when cancelled. */
  static async saveMcad(app, doc, target, name) {
    // big solids are chunks of their own: the file may be larger than one string can be
    const chunks = doc.fileChunks();
    if (api) {
      const p = await api.saveChunks({
        path: target,
        defaultName: `${name}.mcad`,
        chunks,
        filters: [{ name: 'MacCAD Drawing', extensions: ['mcad'] }],
      });
      if (!p) return null;
      target = p;
    } else {
      browserSave(`${name}.mcad`, chunks.join(''), 'application/json');
    }
    app.echo(`Saved ${target}`);
    return { target };
  }

  /** QUIT: closes the app after asking about unsaved changes. */
  static async quit(app) {
    if (!(await FileIo.confirmDiscard(app))) return;
    if (api) api.win('quit');
    else window.close();
  }

  // ---------------------------------------------------------------- export

  /**
   * EXPORT: asks for a format, then writes the drawing (or the solids) in it.
   * @param {object} c command context
   */
  static async exportDialog(c) {
    const r = await c.ui.dialog({
      title: 'Export',
      body: (() => {
        const s = document.createElement('select');
        s.name = 'fmt';
        for (const [v, l] of [
          ['dxf2000', 'AutoCAD DXF 2000 (recommended)'],
          ['dwg', 'AutoCAD DWG 2000'],
          ['dxf', 'AutoCAD DXF R12 (maximum compatibility)'],
          ['svg', 'SVG vector image'],
          ['png', 'PNG image'],
          ['step', '3D solids: STEP (exact, for other CAD / CAM)'],
          ['stl', '3D solids: STL binary (3D printing)'],
          ['obj', '3D solids: Wavefront OBJ'],
        ]) {
          const o = document.createElement('option');
          o.value = v;
          o.textContent = l;
          s.append(o);
        }
        const d = document.createElement('div');
        d.style.cssText = 'width:300px';
        d.append('Format: ', s);
        return d;
      })(),
      collect: (el) => el.querySelector('[name=fmt]').value,
    });
    if (!r) return;
    if (r === 'step' || r === 'stl' || r === 'obj') {
      await exportSolids(c, r);
      return;
    }
    await FileIo.loadKernelForSolids(c.app);
    const svgOf = () =>
      toSVG(c.doc, c.app.space === 'model' ? 'model' : c.app.space, {
        paperW: A4.W,
        paperH: A4.H,
        background: '#ffffff',
      });
    if (r === 'dxf') await FileIo.exportText(c.app, 'dxf', exportDXF(c.doc));
    if (r === 'dxf2000')
      await FileIo.exportText(c.app, 'dxf', exportDXF2000(c.doc, { dimensions: 'objects' }));
    if (r === 'dwg') {
      const prev = c.app.doc.path;
      c.app.doc.path = null;
      await FileIo.saveFile(c.app, true);
      if (prev) c.app.doc.path = prev;
    }
    if (r === 'svg') await FileIo.exportText(c.app, 'svg', svgOf());
    if (r === 'png') await FileIo.plot(c.app, { svg: svgOf(), W: A4.W, H: A4.H, fmt: 'png' });
  }

  /** DXF / DWG carry the solids as 3DFACE meshes, which needs the OpenCascade kernel to be loaded. */
  static async loadKernelForSolids(app) {
    if (!K.kernelReady() && app.doc.model.some((e) => e.type === 'solid3d')) {
      try {
        await K.initKernel();
      } catch (err) {
        app.echo(`The 3D kernel could not be loaded, so solids are left out: ${err.message}`);
      }
    }
  }

  /**
   * Writes text to a file chosen by the user (a download in the browser).
   * @param {object} app
   * @param {string} ext file extension without the dot
   * @param {string} data file contents
   */
  static async exportText(app, ext, data) {
    if (api) {
      const p = await api.saveFile({
        path: null,
        defaultName: `${app.doc.name}.${ext}`,
        data,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (p) app.echo(`Exported ${p}`);
    } else browserSave(`${app.doc.name}.${ext}`, data);
  }

  // ---------------------------------------------------------------- DXFIN, plot, blocks

  /** DXFIN: adds the objects, blocks and layers of a DXF file to the current drawing (one undo step). */
  static async importDxf(app) {
    const f = api
      ? await api.openFile({ filters: [{ name: 'DXF', extensions: ['dxf'] }] })
      : await browserPick('.dxf');
    if (!f) return;
    const r = importDXF(f.data, baseName(f.name || f.path));
    r.warnings.forEach((w) => app.echo(w));
    const before = app.doc.snapshot();
    for (const e of r.doc.model) {
      e.id = 0;
      app.doc.add(e, 'model');
    }
    for (const [n, b] of Object.entries(r.doc.blocks))
      if (!app.doc.blocks[n]) app.doc.defineBlock(n, b.base, b.ents);
    for (const l of r.doc.layers) if (!app.doc.hasLayer(l.name)) app.doc.layers.push(l);
    app.doc.pushUndo(before, 'DXFIN');
    E.bump();
    app.emit('doc');
    app.zoomExtents(false);
    app.echo(`${r.doc.model.length} objects imported.`);
  }

  /**
   * PLOT / PNG export: writes an SVG, PDF or PNG of a plot.
   * @param {object} app
   * @param {{svg: string, W: number, H: number, fmt: 'svg'|'pdf'|'png'}} job the SVG text, the
   *        paper size in mm and the output format
   */
  static async plot(app, { svg, W, H, fmt }) {
    const name = `${app.doc.name}`;
    if (fmt === 'svg') return FileIo.exportText(app, 'svg', svg);
    if (fmt === 'pdf') {
      if (api) {
        const p = await api.plotPdf({ svg, W, H, defaultName: `${name}.pdf` });
        if (p) app.echo(`Plotted to ${p}`);
        else app.echo('Plot cancelled.');
      } else {
        app.echo('PDF output needs the desktop app. Exporting SVG instead.');
        await FileIo.exportText(app, 'svg', svg);
      }
      return;
    }
    // PNG: draw the SVG on a canvas at 300 dpi
    const scale = 300 / 25.4;
    const cw = Math.round(W * scale);
    const ch = Math.round(H * scale);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (api) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const p = await api.saveBinary({
        defaultName: `${name}.png`,
        data: buf,
        filters: [{ name: 'PNG', extensions: ['png'] }],
      });
      if (p) app.echo(`Saved ${p}`);
    } else browserSave(`${name}.png`, blob);
  }

  /**
   * INSERT from a file: picks a .mcad / .dxf, defines its blocks and the file itself as a block.
   * @param {object} c command context
   * @returns {Promise<string|null>} the name of the new block, or null when cancelled
   */
  static async pickBlockFile(c) {
    const f = api
      ? await api.openFile({ filters: [{ name: 'Drawings', extensions: ['mcad', 'dxf', 'dwg'] }] })
      : await browserPick('.mcad,.dxf');
    if (!f) return null;
    const name = baseName(f.name || f.path);
    const d = f.dwg ? dwgToDoc(f.dwg,name).doc : /\.dxf$/i.test(f.name || f.path || '')
      ? importDXF(f.data, name).doc : Doc.fromJSON(parseMcad(f));
    for (const [n, b] of Object.entries(d.blocks))
      if (!c.doc.blocks[n]) c.doc.defineBlock(n, b.base, b.ents);
    c.doc.defineBlock(name, { x: 0, y: 0 }, d.model);
    c.doc.blocks[name].sourcePath=f.path||null;
    return name;
  }

  /**
   * WBLOCK: writes objects to a .mcad file, moved so `base` becomes the origin.
   * @param {object} c command context
   * @param {{x: number, y: number}} base the base point
   * @param {object[]} ents the objects to write
   */
  static async writeBlockFile(c, base, ents) {
    const d = new Doc();
    d.name = 'block';
    d.layers = JSON.parse(JSON.stringify(c.doc.layers));
    d.blocks = JSON.parse(JSON.stringify(c.doc.blocks));
    d.model = ents.map((e) => {
      const k = E.clone(e);
      E.translateEnt(k, -base.x, -base.y, c.doc);
      k.id = d.nextId++;
      return k;
    });
    const data = JSON.stringify(d.toJSON());
    if (api) {
      const p = await api.saveFile({
        path: null,
        defaultName: 'block.mcad',
        data,
        filters: [{ name: 'MacCAD Drawing', extensions: ['mcad'] }],
      });
      if (p) c.echo(`Block written to ${p}`);
    } else browserSave('block.mcad', data);
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORT
 * ========================================================================================== */
/** The name the rest of the program uses: `io.saveFile(...)`. */
export const io = FileIo;
