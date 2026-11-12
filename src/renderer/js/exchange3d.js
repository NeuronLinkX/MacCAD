/**
 * @file exchange3d.js
 * @brief 3D data exchange: STEP (exact B-rep), STL (binary mesh) and OBJ (mesh) export of the
 *        solids, and STEP import.
 *
 * DXF / DWG export of solids (as 3DFACE meshes + edge lines) lives in dxf2000.js.
 * Commands registered here: STEPOUT, STLOUT, OBJOUT, STEPIN.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as K from './kernel3d.js';
import * as E from './entities.js';
import { Doc } from './doc.js';
import { def as registerCommand } from './registry.js';
const def = (names, fn, opts = {}) => registerCommand(names, fn, { ...opts, feature: '3d' });

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

/** Bridge to the main process (null in a plain browser). */
import { api } from './apibridge.js';

/** Export formats: file extension, display name and MIME type. */
const FMT = {
  step: { ext: 'step', name: 'STEP', mime: 'application/step' },
  stl: { ext: 'stl', name: 'STL', mime: 'model/stl' },
  obj: { ext: 'obj', name: 'OBJ', mime: 'text/plain' },
};

/** Browser fallback: downloads bytes as a file. */
function download(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Browser fallback: lets the user pick one file. @returns {Promise<{name: string, path: null, data: string}|null>} */
const pickFile = (accept) =>
  new Promise((resolve) => {
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

/** Lets the command window show a message before the kernel blocks the page. */
const paint = () => new Promise((r) => setTimeout(r, 60));

/**
 * A readable message for a failed STEP import. The only real limit is the memory of the 3D kernel
 * (WebAssembly, about 2 GB).
 */
const stepErr = (e) => {
  const m = (e && e.message) || (typeof e === 'number' ? '' : String(e));
  return /memory|abort|alloc/i.test(m) || typeof e === 'number'
    ? 'the 3D kernel ran out of memory (the file is too big for it). Restart MacCAD before using 3D again, and export a smaller assembly or single parts from the CAD program'
    : m;
};

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static functions for STEP / STL / OBJ export and STEP import. */
export class Exchange3d {
  /** @returns {object[]} the selected solids, or every visible solid when nothing is selected. */
  static solidsToExport(app) {
    const sel = app.selectedEnts().filter((e) => e.type === 'solid3d');
    return sel.length
      ? sel
      : app.curEnts().filter((e) => e.type === 'solid3d' && app.doc.visible(e));
  }

  /**
   * Exports the solids to a file in the given format.
   * @param {object} c command context
   * @param {'step'|'stl'|'obj'} fmt
   * @returns {Promise<boolean>} true when a file was written
   */
  static async exportSolids(c, fmt) {
    const spec = FMT[fmt];
    if (!spec) return false;
    const ents = Exchange3d.solidsToExport(c.app);
    if (!ents.length) {
      c.echo('There are no 3D solids to export. Create or select solids first.');
      return false;
    }
    c.echo('Loading the 3D solid kernel (OpenCascade)...');
    await K.initKernel();
    const file = `${c.doc.name}.${spec.ext}`;
    let bytes;
    if (fmt === 'obj') bytes = new TextEncoder().encode(K.objText(ents.map((e) => K.solidMesh(e))));
    else {
      const shapes = ents.map((e) => K.bakedShape(e));
      const blob = fmt === 'step' ? K.stepBlob(shapes) : K.stlBlob(shapes);
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    if (api && api.saveBinary) {
      const p = await api.saveBinary({
        defaultName: file,
        data: bytes,
        filters: [{ name: spec.name, extensions: [spec.ext] }],
      });
      if (!p) {
        c.echo('Export cancelled.');
        return false;
      }
      c.echo(`${ents.length} solid(s) exported to ${p}`);
    } else {
      download(file, bytes, spec.mime);
      c.echo(`${ents.length} solid(s) exported as ${file}`);
    }
    return true;
  }

  /**
   * Puts the solids of a STEP file into the drawing of the running command.
   * A STEP file of a whole assembly can be hundreds of MB: it is handed over as bytes
   * (`f.stepBytes`), never as one string. The drawing that receives the solids keeps the big BREP
   * text by reference (doc.js), so neither an undo step nor Save has to put it into one string.
   * @param {object} c command context
   * @param {{name?: string, path?: string, stepBytes?: Uint8Array, data?: string}} f the file
   * @returns {Promise<number>} how many solids were imported
   */
  static async importStepData(c, f) {
    const name = f.name || f.path || 'STEP file';
    const src = f.stepBytes || f.data;
    const mb = (src ? src.length || src.byteLength : 0) / 1e6;
    const head = !src
      ? ''
      : typeof src === 'string'
        ? src.slice(0, 4000)
        : new TextDecoder().decode(src.subarray(0, 4000));
    if (!/ISO-10303-21/.test(head)) {
      c.echo(`${name} is not a STEP file (the ISO-10303-21 header is missing).`);
      return 0;
    }
    c.echo('Loading the 3D solid kernel (OpenCascade)...');
    await K.initKernel();
    c.echo(
      `Reading ${name} (${mb.toFixed(1)} MB). Large files take a while and the window may pause...`,
    );
    await paint();
    let shape;
    try {
      shape = await K.importStep(new Blob([src], { type: 'application/step' }));
    } catch (e) {
      c.echo(`STEP import failed: ${stepErr(e)}.`);
      return 0;
    }
    const parts = shape.solids && shape.solids.length ? shape.solids : [shape];
    const lod = mb > 8 || parts.length > 30; // a big model: coarser curves so that it opens in seconds, not minutes
    if (lod)
      c.echo(
        'Big model: curved surfaces are drawn with a coarser mesh to keep the window responsive (the solids themselves are exact).',
      );
    K.setCacheMax(parts.length + 50);
    const list = [];
    let skipped = 0;
    let total = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const s = parts[i];
      try {
        const b = s.boundingBox.bounds;
        const props = K.solidProps(s);
        total += props.brep.length;
        K.seedShape(props.brep, s); // before mk: mk measures the solid, which meshes it; the shape just imported saves deserialising the BREP text
        const e = c.mk('solid3d', {
          ...props,
          ...(lod ? { lod: true } : {}),
          bb: { x0: b[0][0], y0: b[0][1], z0: b[0][2], x1: b[1][0], y1: b[1][1], z1: b[1][2] },
        }); // lod must be set before mk, too
        K.solidMesh(e); // build the display mesh now, in steps, so that progress can be shown (adding first would do it all in one frozen moment)
        list.push(e);
      } catch {
        skipped += 1;
      }
      if (parts.length > 10 && (i + 1) % 10 === 0) {
        c.echo(`  ${i + 1} of ${parts.length} solids prepared...`);
        await paint();
      }
    }
    c.addAll(list);
    const n = list.length;
    c.echo(
      `${n} solid(s) imported from ${name} (${(total / 1e6).toFixed(1)} MB of solid data).${skipped ? ` ${skipped} body(ies) could not be converted and were left out.` : ''}`,
    );
    if (n) {
      c.app.enter3D('swiso');
      c.app.zoomExtents(false);
    }
    return n;
  }

  /** STEPIN: picks a file and adds its solids to the current drawing. @returns {Promise<number>} solids imported. */
  static async importStepFile(c) {
    const f = api
      ? await api.openFile({ filters: [{ name: 'STEP', extensions: ['step', 'stp'] }] })
      : await pickFile('.step,.stp');
    if (!f || f.error) {
      if (f && f.error) c.echo(f.error);
      return 0;
    }
    return Exchange3d.importStepData(c, f);
  }

  /** @returns {boolean} true when the opened file is a STEP file. */
  static isStepFile(f) {
    return /\.(step|stp)$/i.test(String((f && (f.path || f.name)) || ''));
  }

  /**
   * File > Open, drag and drop, Finder: a STEP file opens as a new drawing that holds its solids.
   * @param {object} app
   * @param {object} f the file delivered by the main process
   */
  static async openStepFile(app, f) {
    const d = new Doc();
    d.name =
      String(f.name || f.path || 'STEP')
        .split('/')
        .pop()
        .replace(/\.[^.]+$/, '') || 'STEP';
    if (f.path) d.sourcePath = f.path;
    const shown = app.openTab(d);
    if (shown !== d) return; // the same file is already open: it was just shown
    await app.runInternal('STEPIN', (c) => Exchange3d.importStepData(c, f));
  }

  /** Registers STEPOUT, STLOUT, OBJOUT and STEPIN. */
  static register() {
    def('STEPOUT', async (c) => {
      await Exchange3d.exportSolids(c, 'step');
    });
    def('STLOUT', async (c) => {
      await Exchange3d.exportSolids(c, 'stl');
    });
    def('OBJOUT', async (c) => {
      await Exchange3d.exportSolids(c, 'obj');
    });
    def('STEPIN', async (c) => {
      await Exchange3d.importStepFile(c);
    });
  }
}

/* ============================================================================================
 * 4. REGISTRATION AND COMPATIBILITY EXPORTS
 * ========================================================================================== */
Exchange3d.register();
void E;

export const solidsToExport = Exchange3d.solidsToExport;
export const exportSolids = Exchange3d.exportSolids;
export const importStepData = Exchange3d.importStepData;
export const importStepFile = Exchange3d.importStepFile;
export const isStepFile = Exchange3d.isStepFile;
export const openStepFile = Exchange3d.openStepFile;
