/**
 * @file dxf2000.js
 * @brief DXF R2000 (AC1015) writer with full fidelity: handles, owners, subclass markers,
 *        LWPOLYLINE / ELLIPSE / SPLINE / MTEXT / HATCH / INSERT + ATTRIB / DIMENSION (with anonymous
 *        *D blocks) / LEADER / paper-space layouts, true colours and lineweights.
 *
 * This is the format AutoCAD 2000 and every later release (Windows or macOS) opens directly, and
 * the text that the DWG writer (main process, LibreDWG) converts to a .dwg file.
 *
 * Use `exportDXF2000(doc, {forDwg, dimensions, handleStart})`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';
import * as K from './kernel3d.js';
import { aciHex } from './doc.js';
import { fontFileName } from './fonts.js';

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

const { TAU, deg } = G;

/** The hatch pattern families (angle and spacing of the pattern lines). */
const HATCH_FAMILIES = E.HATCH_PATTERNS;

/** AutoCAD colour index palette as [index, r, g, b] (made on first use). */
let aciTable = null;

/** @returns {number} the colour index (1..255) whose colour is nearest to "#rrggbb". */
function nearestAci(hex) {
  if (!aciTable) {
    aciTable = [];
    for (let i = 1; i < 256; i += 1) {
      const h = aciHex(i);
      aciTable.push([
        i,
        parseInt(h.slice(1, 3), 16),
        parseInt(h.slice(3, 5), 16),
        parseInt(h.slice(5, 7), 16),
      ]);
    }
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  let best = 7;
  let bd = Infinity;
  for (const [i, rr, gg, bb] of aciTable) {
    const d = (rr - r) ** 2 + (gg - g) ** 2 + (bb - b) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
/** The lineweights of DXF in 1/100 mm. */
const LW = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200,
  211,
];
/** @returns {number} the DXF lineweight code nearest to a width in mm. */
const lwCode = (mm) => {
  const v = Math.round(mm * 100);
  return LW.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), 25);
};
/** MTEXT text: line breaks become \\P. */
const clean = (s) => String(s ?? '').replace(/\r?\n/g, '\\P');
/** Single-line text: line breaks become spaces. */
const dxfStr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ');

/* ============================================================================================
 * 3. THE WRITER
 * ========================================================================================== */

/** Writes one drawing as DXF R2000 text. Use `new Dxf2000Writer(doc, opts).write()`. */
class Dxf2000Writer {
  /**
   * @param {object} doc the document
   * @param {{forDwg?: boolean, dimensions?: string, handleStart?: number}} [opts]
   *   forDwg = keep only the used linetypes (LibreDWG limit); dimensions 'explode' = write
   *   dimensions as lines and text; handleStart = the first free handle
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.opts = opts;
    this.dimsAsObjects = opts.dimensions !== 'explode';
    /** The lines of the file (group code, value, group code, value, ...). */
    this.out = [];
    /** The next free handle. */
    this.hseed = opts.handleStart ?? 0x100;
    /** Anonymous dimension blocks found while the entities are written: {name, h: {br, begin, end}, ents}. */
    this.dimBlocks = [];
    /** Where in `out` the dimension block records / blocks are inserted afterwards. */
    this.brInsertAt = 0;
    this.blocksMark = 0;

    // AC1015 text is limited to the code page, so every non-ASCII character is written as \U+XXXX (AutoCAD reads it back everywhere)
    const esc = (s) =>
      String(s).replace(
        /[^\x00-\x7f]/g,
        (ch) => `\\U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      );
    /** Writes one group: code, then value. */
    this.w = (code, val) => {
      this.out.push(String(code));
      this.out.push(
        typeof val === 'number'
          ? Number.isInteger(val)
            ? String(val)
            : String(+val.toFixed(12))
          : esc(val),
      );
    };
    /** The next handle as hex text. */
    this.nh = () => {
      const h = this.hseed.toString(16).toUpperCase();
      this.hseed += 1;
      return h;
    };
    /** Writes a point as groups 10+i, 20+i, 30+i. */
    this.pt = (p, i = 0, z = 0) => {
      this.w(10 + i, p.x);
      this.w(20 + i, p.y);
      this.w(30 + i, z);
    };
    this.prepareHandles();
  }

  /** @private Gives the fixed objects and every layer, style, block and layout a handle. */
  prepareHandles() {
    const { doc, opts, nh } = this;
    // fixed handles for table controls / model & paper space
    this.H = {
      vportT: '8',
      ltypeT: '5',
      layerT: '2',
      styleT: '3',
      viewT: '6',
      ucsT: '7',
      appidT: '9',
      dimstyleT: 'A',
      brT: '1',
      nod: 'C',
      groupD: 'D',
      layoutD: 'E',
      model: '1F',
      paper: '1B',
      modelLayout: '22',
      plotStyle: 'F',
    };
    const { H } = this;
    const layoutNames = Object.keys(doc.layouts);
    this.brPaper = layoutNames.map((n, i) => ({
      name: n,
      h: i === 0 ? H.paper : nh(),
      block: i === 0 ? '*Paper_Space' : `*Paper_Space${i - 1}`,
      layoutH: nh(),
    }));
    this.blockH = {};
    for (const n of Object.keys(doc.blocks)) this.blockH[n] = { br: nh(), begin: nh(), end: nh() };
    this.layerH = {};
    for (const l of doc.layers) this.layerH[l.name] = l.name === '0' ? '10' : nh();
    this.styleH = {};
    for (const n of Object.keys(doc.textStyles)) this.styleH[n] = n === 'Standard' ? '11' : nh();
    this.dimstyleH = {};
    for (const n of Object.keys(doc.dimStyles)) this.dimstyleH[n] = nh();
    // LibreDWG's DWG writer mis-sizes LTYPE_CONTROL for long tables, so DWG output keeps only the linetypes that are really used
    const usedLt = new Set(doc.layers.map((l) => l.ltype));
    const scanLt = (list) =>
      list.forEach((e) => {
        if (e.ltype && e.ltype !== 'bb') usedLt.add(e.ltype);
      });
    scanLt(doc.model);
    Object.values(doc.layouts).forEach((l) => scanLt(l.ents));
    Object.values(doc.blocks).forEach((b) => scanLt(b.ents));
    this.ltypes = Object.keys(doc.ltypes).filter(
      (n) => !/^continuous$/i.test(n) && (!opts.forDwg || usedLt.has(n)),
    );
    this.ltypeH = {};
    for (const n of this.ltypes) this.ltypeH[n] = nh();
    this.ltByBlock = '14';
    this.ltByLayer = '15';
    this.ltCont = '16';
  }

  /** @returns {string} the whole file. */
  write() {
    this.writeHeader();
    this.writeTables();
    this.writeBlocks();
    this.writeEntities();
    this.writeObjects();
    this.finish();
    return this.out.join('\n') + '\n';
  }

  /** HEADER section. */
  writeHeader() {
    const { doc, w, pt } = this;
    // ---- HEADER
    let ext = null;
    for (const e of doc.model) if (doc.visible(e)) ext = E.bboxMerge(ext, E.bbox(e, doc));
    ext = ext || { x0: 0, y0: 0, x1: 420, y1: 297 };
    const lim = doc.limits || { x0: 0, y0: 0, x1: 420, y1: 297 };
    const lunits =
      { scientific: 1, decimal: 2, engineering: 3, architectural: 4, fractional: 5 }[
        doc.units.type
      ] || 2;
    w(0, 'SECTION');
    w(2, 'HEADER');
    w(9, '$ACADVER');
    w(1, 'AC1015');
    w(9, '$ACADMAINTVER');
    w(70, 20);
    w(9, '$DWGCODEPAGE');
    w(3, 'ANSI_949');
    w(9, '$INSBASE');
    pt({ x: 0, y: 0 });
    w(9, '$EXTMIN');
    pt({ x: ext.x0, y: ext.y0 });
    w(9, '$EXTMAX');
    pt({ x: ext.x1, y: ext.y1 });
    w(9, '$LIMMIN');
    w(10, lim.x0);
    w(20, lim.y0);
    w(9, '$LIMMAX');
    w(10, lim.x1);
    w(20, lim.y1);
    w(9, '$ORTHOMODE');
    w(70, 0);
    w(9, '$FILLMODE');
    w(70, 1);
    w(9, '$LTSCALE');
    w(40, doc.ltscale);
    w(9, '$TEXTSIZE');
    w(40, 2.5);
    w(9, '$TEXTSTYLE');
    w(7, doc.curTextStyle);
    w(9, '$CLAYER');
    w(8, doc.cur.layer);
    w(9, '$CELTYPE');
    w(6, doc.cur.ltype && doc.cur.ltype !== 'bb' ? doc.cur.ltype : 'BYLAYER');
    w(9, '$CECOLOR');
    w(
      62,
      doc.cur.color == null
        ? 256
        : doc.cur.color === 'bb'
          ? 0
          : typeof doc.cur.color === 'number'
            ? doc.cur.color
            : nearestAci(doc.cur.color),
    );
    w(9, '$LUNITS');
    w(70, lunits);
    w(9, '$LUPREC');
    w(70, doc.units.prec);
    w(9, '$AUNITS');
    w(70, { deg: 0, dms: 1, grad: 2, rad: 3 }[doc.units.angType] || 0);
    w(9, '$AUPREC');
    w(70, doc.units.aprec);
    w(9, '$PDMODE');
    w(70, doc.pdmode);
    w(9, '$PDSIZE');
    w(40, doc.pdsize);
    w(9, '$INSUNITS');
    w(70, doc.insUnits ?? 4);
    w(9, '$MEASUREMENT');
    w(70, 1);
    w(9, '$LWDISPLAY');
    w(290, 0);
    w(9, '$TILEMODE');
    w(70, 1);
    w(9, '$PSLTSCALE');
    w(70, 1);
    w(9, '$DIMSTYLE');
    w(2, doc.curDimStyle);
    w(9, '$HANDSEED');
    w(5, '__HANDSEED__');
    w(0, 'ENDSEC');
  }

  /** TABLES section (viewport, linetypes, layers, text styles, application ids, dimension styles, block records). */
  writeTables() {
    const {
      doc,
      opts,
      out,
      w,
      nh,
      H,
      brPaper,
      blockH,
      layerH,
      styleH,
      dimstyleH,
      ltypes,
      ltypeH,
      ltByBlock,
      ltByLayer,
      ltCont,
    } = this;
    // ---- TABLES
    w(0, 'SECTION');
    w(2, 'TABLES');
    this.tableHead('VPORT', H.vportT, 1);
    this.rec('VPORT', nh(), H.vportT, 'AcDbViewportTableRecord');
    w(2, '*Active');
    w(70, 0);
    w(10, 0);
    w(20, 0);
    w(11, 1);
    w(21, 1);
    w(12, doc.modelView.cx);
    w(22, doc.modelView.cy);
    w(13, 0);
    w(23, 0);
    w(14, 10);
    w(24, 10);
    w(15, 10);
    w(25, 10);
    w(16, 0);
    w(26, 0);
    w(36, 1);
    w(17, 0);
    w(27, 0);
    w(37, 0);
    w(40, 1000);
    w(41, 1.5);
    w(42, 50);
    w(43, 0);
    w(44, 0);
    w(50, 0);
    w(51, 0);
    w(71, 0);
    w(72, 100);
    w(73, 1);
    w(74, 3);
    w(75, 0);
    w(76, 0);
    w(77, 0);
    w(78, 0);
    w(0, 'ENDTAB');
    const ltBase = opts.forDwg
      ? [['Continuous', ltCont, 'Solid line']]
      : [
          ['ByBlock', ltByBlock, ''],
          ['ByLayer', ltByLayer, ''],
          ['Continuous', ltCont, 'Solid line'],
        ];
    this.tableHead('LTYPE', H.ltypeT, ltypes.length + ltBase.length);
    for (const [nm, h, desc] of ltBase) {
      this.rec('LTYPE', h, H.ltypeT, 'AcDbLinetypeTableRecord');
      w(2, nm);
      w(70, 0);
      w(3, desc);
      w(72, 65);
      w(73, 0);
      w(40, 0);
    }
    for (const nm of ltypes) {
      const pat = doc.ltypes[nm];
      this.rec('LTYPE', ltypeH[nm], H.ltypeT, 'AcDbLinetypeTableRecord');
      w(2, nm);
      w(70, 0);
      w(3, nm);
      w(72, 65);
      w(73, pat.length);
      w(
        40,
        pat.reduce((s, v) => s + Math.abs(v), 0),
      );
      for (const v of pat) {
        w(49, v);
        w(74, 0);
      }
    }
    w(0, 'ENDTAB');
    this.tableHead('LAYER', H.layerT, doc.layers.length);
    for (const l of doc.layers) {
      this.rec('LAYER', layerH[l.name], H.layerT, 'AcDbLayerTableRecord');
      w(2, l.name);
      w(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      const c = typeof l.color === 'number' ? l.color : nearestAci(l.color);
      w(62, (l.on ? 1 : -1) * (c || 7));
      if (typeof l.color === 'string' && l.color[0] === '#') w(420, parseInt(l.color.slice(1), 16));
      w(6, ltypeH[l.ltype] || /^continuous$/i.test(l.ltype) ? l.ltype : 'Continuous');
      w(290, l.plot === false ? 0 : 1);
      w(370, lwCode(l.lw ?? 0.25));
    }
    w(0, 'ENDTAB');
    this.tableHead('STYLE', H.styleT, Object.keys(doc.textStyles).length);
    for (const [nm, s] of Object.entries(doc.textStyles)) {
      this.rec('STYLE', styleH[nm], H.styleT, 'AcDbTextStyleTableRecord');
      w(2, nm);
      w(70, 0);
      w(40, s.h || 0);
      w(41, s.wf || 1);
      w(50, s.obl || 0);
      w(71, 0);
      w(42, 2.5);
      w(3, fontFileName(s.font));
      w(4, s.big || '');
    }
    w(0, 'ENDTAB');
    this.tableHead('VIEW', H.viewT, 0);
    w(0, 'ENDTAB');
    this.tableHead('UCS', H.ucsT, 0);
    w(0, 'ENDTAB');
    this.tableHead('APPID', H.appidT, 2);
    this.rec('APPID', '12', H.appidT, 'AcDbRegAppTableRecord');
    w(2, 'ACAD');
    w(70, 0);
    this.rec('APPID', nh(), H.appidT, 'AcDbRegAppTableRecord');
    w(2, 'MACCAD');
    w(70, 0);
    w(0, 'ENDTAB');
    this.tableHead('DIMSTYLE', H.dimstyleT, Object.keys(doc.dimStyles).length);
    w(100, 'AcDbDimStyleTable');
    w(71, 0);
    for (const [nm, d] of Object.entries(doc.dimStyles)) {
      w(0, 'DIMSTYLE');
      w(105, dimstyleH[nm]);
      w(330, H.dimstyleT);
      w(100, 'AcDbSymbolTableRecord');
      w(100, 'AcDbDimStyleTableRecord');
      w(2, nm);
      w(70, 0);
      w(3, `${d.prefix || ''}<>${d.suffix || ''}`.replace(/^<>$/, ''));
      w(4, d.altSuffix || '');
      w(40, d.scale || 1);
      w(41, d.asz);
      w(42, d.eo);
      w(43, d.bs ?? 3.75);
      w(44, d.ee);
      w(140, d.h);
      w(141, 2.5);
      w(147, d.gap);
      const tick = d.arrow === 'oblique' || d.arrow === 'archtick';
      if (tick) w(142, d.asz);
      if (d.tcolor != null && typeof d.tcolor === 'number') w(178, d.tcolor);
      w(77, d.tplace === 'centered' ? 0 : 1);
      w(73, d.talign === 'horizontal' ? 1 : 0);
      w(74, d.talign === 'horizontal' ? 1 : 0);
      w(78, { none: 0, lead: 4, trail: 8, both: 12 }[d.zero || 'none'] ?? 0);
      w(144, d.lfac ?? 1);
      w(45, d.round ?? 0);
      w(278, (d.dsep || '.').charCodeAt(0));
      w(170, d.alt ? 1 : 0);
      w(143, d.altf ?? 25.4);
      w(171, d.altPrec ?? 1);
      const tm = d.tolMode || 'none';
      w(71, tm === 'symmetrical' || tm === 'deviation' ? 1 : 0);
      w(72, tm === 'limits' ? 1 : 0);
      w(47, d.tolUp ?? 0);
      w(48, tm === 'symmetrical' ? (d.tolUp ?? 0) : (d.tolLo ?? 0));
      w(146, d.tolScale ?? 0.7);
      w(75, d.ext1off ? 1 : 0);
      w(76, d.ext2off ? 1 : 0);
      w(281, d.dim1off ? 1 : 0);
      w(282, d.dim2off ? 1 : 0);
      w(271, d.prec ?? 2);
      w(272, d.tolPrec ?? d.prec ?? 2);
      w(340, styleH.Standard || Object.values(styleH)[0]);
    }
    w(0, 'ENDTAB');
    this.tableHead('BLOCK_RECORD', H.brT, 2 + brPaper.length - 1 + Object.keys(doc.blocks).length);
    this.brRec(H.model, '*Model_Space', H.modelLayout);
    brPaper.forEach((p) => this.brRec(p.h, p.block, p.layoutH));
    for (const [n, h] of Object.entries(blockH)) this.brRec(h.br, n);
    // anonymous dimension blocks are appended while writing entities; their records are written afterwards (see patch below)
    this.brInsertAt = out.length;
    w(0, 'ENDTAB');
    w(0, 'ENDSEC');
  }

  /** BLOCKS section (the dimension blocks are added later by `finish`). */
  writeBlocks() {
    const { doc, out, w, pt, nh, H, brPaper, blockH } = this;
    // ---- BLOCKS
    w(0, 'SECTION');
    w(2, 'BLOCKS');
    this.blockHead('*Model_Space', H.model, nh());
    this.blockTail(H.model, nh());
    brPaper.forEach((p) => {
      this.blockHead(p.block, p.h, nh());
      this.blockTail(p.h, nh());
    });
    for (const [n, b] of Object.entries(doc.blocks)) {
      const h = blockH[n];
      this.blockHead(n, h.br, h.begin, b.base);
      for (const e of b.ents) {
        if (e.attdef) {
          const a = e.attdef;
          this.common(e, 'ATTDEF', 'AcDbText', h.br, false);
          pt(e.p);
          w(40, e.h);
          w(1, dxfStr(a.def));
          if (e.rot) w(50, deg(e.rot));
          w(7, doc.textStyles[e.style] ? e.style : 'Standard');
          w(100, 'AcDbAttributeDefinition');
          w(3, dxfStr(a.prompt));
          w(2, a.tag);
          w(70, 0);
        } else this.writeEntity(e, h.br, false, { inBlock: true });
      }
      this.blockTail(h.br, h.end);
    }
    this.blocksMark = out.length; // dimension blocks are inserted here after entities are written
    w(0, 'ENDSEC');
  }

  /** ENTITIES section: model space, then the objects of every layout. */
  writeEntities() {
    const { doc, w, pt, nh, H, brPaper } = this;
    // ---- ENTITIES
    w(0, 'SECTION');
    w(2, 'ENTITIES');
    for (const e of doc.model) if (e.type !== 'viewport') this.writeEntity(e, H.model, false);
    const vpHandles = {};
    brPaper.forEach((p) => {
      for (const e of doc.layouts[p.name].ents) {
        if (e.type === 'viewport') {
          const h = nh();
          vpHandles[p.name] = vpHandles[p.name] || [];
          vpHandles[p.name].push(h);
          w(0, 'VIEWPORT');
          w(5, h);
          w(330, p.h);
          w(100, 'AcDbEntity');
          w(67, 1);
          w(8, e.layer || '0');
          w(100, 'AcDbViewport');
          pt(G.mid(e.p1, e.p2));
          w(40, e.p2.x - e.p1.x);
          w(41, e.p2.y - e.p1.y);
          w(68, 1);
          w(69, vpHandles[p.name].length + 1);
          w(12, e.cx);
          w(22, e.cy);
          w(13, 0);
          w(23, 0);
          w(14, 10);
          w(24, 10);
          w(15, 10);
          w(25, 10);
          w(16, 0);
          w(26, 0);
          w(36, 1);
          w(17, 0);
          w(27, 0);
          w(37, 0);
          w(45, (e.p2.y - e.p1.y) / (e.scale || 1));
          w(72, 1000);
        } else this.writeEntity(e, p.h, true);
      }
    });
    w(0, 'ENDSEC');
  }

  /** OBJECTS section: dictionaries, layouts and groups. */
  writeObjects() {
    const { doc, w, nh, H, brPaper } = this;
    // ---- OBJECTS
    w(0, 'SECTION');
    w(2, 'OBJECTS');
    const groups = Object.entries(doc.groups || {});
    w(0, 'DICTIONARY');
    w(5, H.nod);
    w(330, 0);
    w(100, 'AcDbDictionary');
    w(281, 1);
    w(3, 'ACAD_GROUP');
    w(350, H.groupD);
    w(3, 'ACAD_LAYOUT');
    w(350, H.layoutD);
    w(3, 'ACAD_MLINESTYLE');
    w(350, '__LASTH__');
    w(0, 'DICTIONARY');
    w(5, H.groupD);
    w(330, H.nod);
    w(100, 'AcDbDictionary');
    w(281, 1);
    const groupObjs = groups.map(([name, ids]) => ({ name, ids, h: nh() }));
    groupObjs.forEach((g) => {
      w(3, g.name);
      w(350, g.h);
    });
    w(0, 'DICTIONARY');
    w(5, H.layoutD);
    w(330, H.nod);
    w(100, 'AcDbDictionary');
    w(281, 1);
    w(3, 'Model');
    w(350, H.modelLayout);
    brPaper.forEach((p) => {
      w(3, p.name);
      w(350, p.layoutH);
    });
    this.layoutObj('Model', H.modelLayout, H.model, 0, null);
    brPaper.forEach((p, i) =>
      this.layoutObj(p.name, p.layoutH, p.h, i + 1, doc.layouts[p.name].paper),
    );
    for (const g of groupObjs) {
      w(0, 'GROUP');
      w(5, g.h);
      w(330, H.groupD);
      w(100, 'AcDbGroup');
      w(300, '');
      w(70, 1);
      w(71, 1); /* member handles are not tracked across export */
    }
    // the LAST object of the file carries the highest handle: LibreDWG derives its next free handle from the last object
    w(0, 'DICTIONARY');
    w(5, '__LASTH__');
    w(330, H.nod);
    w(100, 'AcDbDictionary');
    w(281, 1);
    w(0, 'ENDSEC');
    w(0, 'EOF');
  }

  /** Patches in the anonymous dimension blocks, the BLOCK_RECORD count and the real handle seed. */
  finish() {
    const { out, w, nh, H, dimBlocks, brInsertAt, blocksMark } = this;
    // ---- patch in anonymous dimension block records / blocks, and the real handle seed
    const brLines = [];
    const bLines = [];
    const sub = (fn) => {
      const keep = out.length;
      fn();
      const piece = out.splice(keep);
      return piece;
    };
    for (const d of dimBlocks) {
      brLines.push(
        ...sub(() => {
          this.rec('BLOCK_RECORD', d.h.br, H.brT, 'AcDbBlockTableRecord');
          w(2, d.name);
          w(340, 0);
        }),
      );
      bLines.push(
        ...sub(() => {
          this.blockHead(d.name, d.h.br, d.h.begin);
          for (const k of d.ents) this.writeEntity(k, d.h.br, false, { inBlock: true });
          this.blockTail(d.h.br, d.h.end);
        }),
      );
    }
    out.splice(blocksMark, 0, ...bLines);
    out.splice(brInsertAt, 0, ...brLines);
    // fix the BLOCK_RECORD count in the table header
    for (let i = 0; i < out.length - 1; i += 1)
      if (
        out[i] === '2' &&
        out[i + 1] === 'BLOCK_RECORD' &&
        out[i - 1] === '0' &&
        out[i - 2] === 'TABLE'
      ) {
        let j = i + 2;
        while (out[j] !== '70') j += 2;
        out[j + 1] = String(+out[j + 1] + dimBlocks.length);
        break;
      }
    const lastH = nh();
    for (let i = 0; i < out.length; i += 1) if (out[i] === '__LASTH__') out[i] = lastH;
    const seed = (this.hseed + 16).toString(16).toUpperCase();
    for (let i = 0; i < out.length - 1; i += 1)
      if (out[i + 1] === '__HANDSEED__') {
        out[i + 1] = seed;
        break;
      }
    return out.join('\n') + '\n';
  }

  /** Starts a table of the TABLES section. */
  tableHead(name, h, count) {
    const { w } = this;
    w(0, 'TABLE');
    w(2, name);
    w(5, h);
    w(330, 0);
    w(100, 'AcDbSymbolTable');
    w(70, count);
  }

  /** Starts a table record. */
  rec(type, h, owner, sub) {
    const { w } = this;
    w(0, type);
    w(5, h);
    w(330, owner);
    w(100, 'AcDbSymbolTableRecord');
    w(100, sub);
  }

  /** A BLOCK_RECORD table record. */
  brRec(h, name, layout = 0) {
    const { w, H } = this;
    this.rec('BLOCK_RECORD', h, H.brT, 'AcDbBlockTableRecord');
    w(2, name);
    w(340, layout);
  }

  /** Starts a BLOCK. */
  blockHead(name, owner, begin, base = { x: 0, y: 0 }) {
    const { w, pt } = this;
    w(0, 'BLOCK');
    w(5, begin);
    w(330, owner);
    w(100, 'AcDbEntity');
    w(8, '0');
    w(100, 'AcDbBlockBegin');
    w(2, name);
    w(70, name.startsWith('*') ? 1 : 0);
    pt(base);
    w(3, name);
    w(1, '');
  }

  /** Ends a BLOCK. */
  blockTail(owner, end) {
    const { w } = this;
    w(0, 'ENDBLK');
    w(5, end);
    w(330, owner);
    w(100, 'AcDbEntity');
    w(8, '0');
    w(100, 'AcDbBlockEnd');
  }

  /** A LAYOUT object. */
  layoutObj(name, h, blockRec, tab, paper) {
    const { w, H } = this;
    w(0, 'LAYOUT');
    w(5, h);
    w(330, H.layoutD);
    w(100, 'AcDbPlotSettings');
    w(1, '');
    w(2, 'none_device');
    w(4, '');
    w(6, '');
    w(40, 0);
    w(41, 0);
    w(42, 0);
    w(43, 0);
    w(44, paper ? paper.w : 210);
    w(45, paper ? paper.h : 297);
    w(46, 0);
    w(47, 0);
    w(48, 0);
    w(49, 0);
    w(140, 0);
    w(141, 0);
    w(142, 1);
    w(143, 1);
    w(70, 1024);
    w(72, 1);
    w(73, 0);
    w(74, 5);
    w(7, '');
    w(75, 16);
    w(147, 1);
    w(148, 0);
    w(149, 0);
    w(100, 'AcDbLayout');
    w(1, name);
    w(70, 1);
    w(71, tab);
    w(10, 0);
    w(20, 0);
    w(11, paper ? paper.w : 12);
    w(21, paper ? paper.h : 9);
    w(12, 0);
    w(22, 0);
    w(32, 0);
    w(14, 0);
    w(24, 0);
    w(34, 0);
    w(15, 0);
    w(25, 0);
    w(35, 0);
    w(146, 0);
    w(13, 0);
    w(23, 0);
    w(33, 0);
    w(16, 1);
    w(26, 0);
    w(36, 0);
    w(17, 0);
    w(27, 1);
    w(37, 0);
    w(76, 0);
    w(330, blockRec);
  }

  /** The groups every entity starts with (type, handle, owner, layer, linetype, colour, lineweight, subclass). */
  common(e, type, sub, owner, paper) {
    const { w, nh } = this;
    w(0, type);
    w(5, nh());
    w(330, owner);
    w(100, 'AcDbEntity');
    if (paper) w(67, 1);
    w(8, e.layer || '0');
    if (e.ltype) w(6, e.ltype === 'bb' ? 'BYBLOCK' : e.ltype);
    if (e.color != null) {
      if (e.color === 'bb') w(62, 0);
      else if (typeof e.color === 'number') w(62, e.color);
      else {
        w(62, nearestAci(e.color));
        w(420, parseInt(e.color.slice(1), 16));
      }
    }
    if (e.lw != null) w(370, e.lw === 'bb' ? -2 : lwCode(e.lw));
    if (e.ltscale && e.ltscale !== 1) w(48, e.ltscale);
    if (sub) w(100, sub);
  }

  /** A TEXT entity; returns the text layout. */
  textCommon(t, owner, paper, sub2) {
    const { doc, w, pt } = this;
    const L = E.textLayout(t, doc);
    this.common(t, 'TEXT', 'AcDbText', owner, paper);
    const al = t.al || 0;
    pt(t.p);
    w(40, t.h);
    w(1, dxfStr(t.str));
    if (t.rot) w(50, deg(t.rot));
    if ((t.wf ?? L.st.wf ?? 1) !== 1) w(41, t.wf ?? L.st.wf);
    if (t.obl ?? L.st.obl) w(51, t.obl ?? L.st.obl);
    w(7, doc.textStyles[t.style] ? t.style : 'Standard');
    if (al) {
      w(72, al === 1 ? 1 : 2);
      pt(t.p, 1);
    }
    w(100, sub2 || 'AcDbText');
    w(73, 0);
    return L;
  }

  /** Writes one entity in the owner block. `ctx.inBlock` is set inside blocks (dimensions are exploded there). */
  writeEntity(e, owner, paper, ctx = {}) {
    const { doc, dimsAsObjects, out, w, pt, nh, dimBlocks } = this;
    switch (e.type) {
      case 'line':
        this.common(e, 'LINE', 'AcDbLine', owner, paper);
        pt(e.p1);
        pt(e.p2, 1);
        break;
      case 'circle':
        this.common(e, 'CIRCLE', 'AcDbCircle', owner, paper);
        pt(e.c);
        w(40, e.r);
        break;
      case 'arc':
        this.common(e, 'ARC', 'AcDbCircle', owner, paper);
        pt(e.c);
        w(40, e.r);
        w(100, 'AcDbArc');
        w(50, deg(G.normAng(e.a0)));
        w(51, deg(G.normAng(e.a1)));
        break;
      case 'point':
        this.common(e, 'POINT', 'AcDbPoint', owner, paper);
        pt(e.p);
        break;
      case 'pline': {
        this.common(e, 'LWPOLYLINE', 'AcDbPolyline', owner, paper);
        w(90, e.pts.length);
        w(70, e.closed ? 1 : 0);
        w(43, 0);
        for (const v of e.pts) {
          w(10, v.x);
          w(20, v.y);
          if (v.b) w(42, v.b);
        }
        break;
      }
      case 'ellipse': {
        const ax = E.ellipseAxes(e);
        const mj = ax.major;
        const n = ax.minor;
        const ratio = ax.b / ax.a;
        // canonical parameter: angle from the major axis; flip when the stored orientation is clockwise
        const cw = G.cross(mj, n) < 0;
        let a0 = e.a0 - ax.t0;
        let a1 = e.a1 - ax.t0;
        if (cw) {
          const t = a0;
          a0 = -a1;
          a1 = -t;
        }
        const full = Math.abs(e.a1 - e.a0) >= TAU - 1e-9;
        if (full) {
          a0 = 0;
          a1 = TAU;
        } else {
          a0 = G.normAng(a0);
          a1 = G.normAng(a1);
        }
        this.common(e, 'ELLIPSE', 'AcDbEllipse', owner, paper);
        pt(e.c);
        pt(mj, 1);
        w(210, 0);
        w(220, 0);
        w(230, 1);
        w(40, ratio);
        w(41, a0);
        w(42, a1);
        break;
      }
      case 'spline': {
        if (e.nurbs) {
          const nb = e.nurbs;
          this.common(e, 'SPLINE', 'AcDbSpline', owner, paper);
          w(210, 0);
          w(220, 0);
          w(230, 1);
          w(70, 8 | (nb.w ? 4 : 0));
          w(71, nb.deg);
          w(72, nb.knots.length);
          w(73, nb.ctrl.length);
          w(74, 0);
          w(42, 1e-9);
          w(43, 1e-9);
          w(44, 1e-10);
          nb.knots.forEach((k) => w(40, k));
          if (nb.w) nb.w.forEach((k) => w(41, k));
          nb.ctrl.forEach((p) => pt(p));
        } else {
          const pts = e.pts;
          this.common(e, 'SPLINE', 'AcDbSpline', owner, paper);
          w(210, 0);
          w(220, 0);
          w(230, 1);
          w(70, 8 | (e.closed ? 1 : 0));
          w(71, 3);
          w(72, 0);
          w(73, 0);
          w(74, pts.length);
          w(42, 1e-9);
          w(43, 1e-9);
          w(44, 1e-10);
          pts.forEach((p) => pt(p, 1));
        }
        break;
      }
      case 'text': {
        this.textCommon(e, owner, paper);
        break;
      }
      case 'mtext': {
        this.common(e, 'MTEXT', 'AcDbMText', owner, paper);
        pt(e.p);
        w(40, e.h);
        w(41, e.w || 0);
        w(71, e.att || 1);
        w(72, 5);
        const s = clean(e.str);
        for (let i = 0; i < s.length; i += 250) {
          const chunk = s.slice(i, i + 250);
          w(i + 250 >= s.length ? 1 : 3, chunk);
        }
        w(7, doc.textStyles[e.style] ? e.style : 'Standard');
        w(11, Math.cos(e.rot || 0));
        w(21, Math.sin(e.rot || 0));
        w(31, 0);
        break;
      }
      case 'insert': {
        const hasAttr =
          e.attribs && doc.blocks[e.name] && doc.blocks[e.name].ents.some((x) => x.attdef);
        this.common(e, 'INSERT', 'AcDbBlockReference', owner, paper);
        if (hasAttr) w(66, 1);
        w(2, e.name);
        pt(e.p);
        w(41, e.sx ?? 1);
        w(42, e.sy ?? e.sx ?? 1);
        w(43, e.sx ?? 1);
        if (e.rot) w(50, deg(e.rot));
        if (hasAttr) {
          const M = E.insertMatrix(e, doc.blocks[e.name].base);
          for (const d of doc.blocks[e.name].ents)
            if (d.attdef) {
              const t = E.clone(d);
              E.xformInPlace(t, M, doc);
              t.str = e.attribs[d.attdef.tag] ?? d.attdef.def;
              const L = E.textLayout(t, doc);
              void L;
              this.common(t, 'ATTRIB', 'AcDbText', owner, paper);
              pt(t.p);
              w(40, t.h);
              w(1, dxfStr(t.str));
              if (t.rot) w(50, deg(t.rot));
              w(7, doc.textStyles[t.style] ? t.style : 'Standard');
              w(100, 'AcDbAttribute');
              w(2, d.attdef.tag);
              w(70, 0);
            }
          w(0, 'SEQEND');
          w(5, nh());
          w(330, owner);
          w(100, 'AcDbEntity');
          if (paper) w(67, 1);
          w(8, e.layer);
        }
        break;
      }
      case 'solid3d': {
        // solids travel as shaded triangles (3DFACE with hidden inner edges) plus their real edges as lines
        if (!K.kernelReady()) {
          ctx.warn &&
            ctx.warn('3D solids were left out of the DXF because the 3D kernel was not loaded.');
          break;
        }
        let m;
        try {
          m = K.solidMesh(e);
        } catch {
          break;
        }
        const P = (i) => ({ x: m.pos[i * 3], y: m.pos[i * 3 + 1], z: m.pos[i * 3 + 2] });
        const f3 = (p, k) => {
          w(10 + k, p.x);
          w(20 + k, p.y);
          w(30 + k, p.z);
        };
        for (let i = 0; i + 2 < m.idx.length; i += 3) {
          const a = P(m.idx[i]);
          const b = P(m.idx[i + 1]);
          const c3 = P(m.idx[i + 2]);
          this.common(e, '3DFACE', 'AcDbFace', owner, paper);
          f3(a, 0);
          f3(b, 1);
          f3(c3, 2);
          f3(c3, 3);
          w(70, 15);
        }
        for (const ed of E.solidEdges(e))
          for (let i = 0; i + 1 < ed.pts.length; i += 1) {
            this.common(e, 'LINE', 'AcDbLine', owner, paper);
            w(10, ed.pts[i][0]);
            w(20, ed.pts[i][1]);
            w(30, ed.pts[i][2]);
            w(11, ed.pts[i + 1][0]);
            w(21, ed.pts[i + 1][1]);
            w(31, ed.pts[i + 1][2]);
          }
        break;
      }
      case 'xline':
      case 'ray':
        this.common(
          e,
          e.type === 'xline' ? 'XLINE' : 'RAY',
          e.type === 'xline' ? 'AcDbXline' : 'AcDbRay',
          owner,
          paper,
        );
        pt(e.p);
        pt(e.dir, 1);
        break;
      case 'donut':
        this.writeEntity({ ...e, type: 'circle', c: e.c, r: e.rin }, owner, paper);
        this.writeEntity({ ...e, type: 'circle', c: e.c, r: e.rout }, owner, paper);
        break;
      case 'hatch': {
        const solid = e.pattern === 'SOLID' || e.pattern === 'WIPE';
        if (
          solid &&
          e.loops.length === 1 &&
          (e.loops[0].length === 3 || e.loops[0].length === 4) &&
          e.pattern === 'SOLID'
        ) {
          const l = e.loops[0];
          this.common(e, 'SOLID', 'AcDbTrace', owner, paper);
          pt(l[0]);
          pt(l[1], 1);
          pt(l.length === 4 ? l[3] : l[2], 2);
          pt(l[2], 3);
          break;
        }
        const fam = HATCH_FAMILIES[e.pattern] || [];
        this.common(e, 'HATCH', 'AcDbHatch', owner, paper);
        pt({ x: 0, y: 0 });
        w(210, 0);
        w(220, 0);
        w(230, 1);
        w(2, e.pattern === 'WIPE' ? 'SOLID' : solid ? 'SOLID' : e.pattern);
        w(70, solid ? 1 : 0);
        w(71, 0);
        w(91, e.loops.length);
        for (const lp of e.loops) {
          w(92, 7);
          w(72, 0);
          w(73, 1);
          w(93, lp.length);
          for (const p of lp) {
            w(10, p.x);
            w(20, p.y);
          }
          w(97, 0);
        }
        w(75, 0);
        w(76, 1);
        if (!solid) {
          w(52, deg(e.angle || 0));
          w(41, e.scale || 1);
          w(77, 0);
          w(78, fam.length);
          for (const f of fam) {
            const a = G.rad(f.a) + (e.angle || 0);
            const d = f.d * (e.scale || 1);
            w(53, deg(a));
            w(43, 0);
            w(44, 0);
            w(45, -Math.sin(a) * d);
            w(46, Math.cos(a) * d);
            w(79, 0);
          }
        }
        w(98, 0);
        break;
      }
      case 'leader': {
        this.common(e, 'LEADER', 'AcDbLeader', owner, paper);
        w(3, doc.curDimStyle);
        w(71, e.noArrow ? 0 : 1);
        w(72, 0);
        w(73, 3);
        w(74, 1);
        w(75, 0);
        w(40, e.h || 2.5);
        w(41, 0);
        w(76, e.pts.length);
        e.pts.forEach((p) => pt(p));
        if (e.str)
          this.writeEntity(
            {
              type: 'mtext',
              p: e.tp || e.pts[e.pts.length - 1],
              h: e.h,
              str: e.str,
              rot: 0,
              w: 0,
              layer: e.layer,
              color: e.color,
              style: 'Standard',
              att: 1,
            },
            owner,
            paper,
          );
        break;
      }
      case 'dim': {
        if (!dimsAsObjects || e.kind === 'arcl' || ctx.inBlock) {
          for (const k of E.explode(e, doc) || []) this.writeEntity(k, owner, paper, ctx);
          break;
        }
        const type = { lin: 0, ali: 1, dia: 3, rad: 4, ang: e.p2 && e.c ? 5 : 2 }[e.kind];
        if (type === undefined) {
          for (const k of E.explode(e, doc) || []) this.writeEntity(k, owner, paper, ctx);
          break;
        }
        const g = E.dimGeom(e, doc);
        const bn = `*D${dimBlocks.length + 1}`;
        const bh = { br: nh(), begin: nh(), end: nh() };
        const blockEnts = E.explode(e, doc) || [];
        blockEnts.forEach((k) => {
          k.layer = e.layer;
        });
        dimBlocks.push({ name: bn, h: bh, ents: blockEnts });
        this.common(e, 'DIMENSION', 'AcDbDimension', owner, paper);
        w(2, bn);
        const def = e.kind === 'rad' || e.kind === 'dia' ? e.c : e.kind === 'ang' ? e.dp : e.dp;
        const tp = g.text ? g.text.p : e.dp || e.c;
        pt(
          e.kind === 'rad'
            ? e.c
            : e.kind === 'dia'
              ? G.add(e.c, G.mul(G.norm(G.sub(e.p, e.c)), e.r))
              : def,
        );
        pt(tp, 1);
        w(70, type | 32);
        if (e.text) w(1, dxfStr(e.text));
        w(3, doc.dimStyles[e.style] ? e.style : doc.curDimStyle);
        if (e.kind === 'lin') {
          w(100, 'AcDbAlignedDimension');
          pt(e.p1, 3);
          pt(e.p2, 4);
          w(50, deg(e.rot || 0));
          w(100, 'AcDbRotatedDimension');
        } else if (e.kind === 'ali') {
          w(100, 'AcDbAlignedDimension');
          pt(e.p1, 3);
          pt(e.p2, 4);
        } else if (e.kind === 'rad') {
          w(100, 'AcDbRadialDimension');
          pt(G.add(e.c, G.mul(G.norm(G.sub(e.p, e.c)), e.r)), 5);
          w(40, Math.max(0, G.dist(e.p, e.c) - e.r));
        } else if (e.kind === 'dia') {
          w(100, 'AcDbDiametricDimension');
          pt(G.sub(e.c, G.mul(G.norm(G.sub(e.p, e.c)), e.r)), 5);
          w(40, 0);
        } else if (e.kind === 'ang') {
          w(100, 'AcDb3PointAngularDimension');
          pt(e.p1, 3);
          pt(e.p2, 4);
          pt(e.c, 5);
        }
        break;
      }
      case 'viewport':
        break;
      default:
        break;
    }
  }
}

/* ============================================================================================
 * 4. ENTRY POINT
 * ========================================================================================== */

/**
 * The DXF R2000 text of a drawing.
 * @param {object} doc the document
 * @param {{forDwg?: boolean, dimensions?: string, handleStart?: number}} [opts]
 * @returns {string}
 */
export function exportDXF2000(doc, opts = {}) {
  return new Dxf2000Writer(doc, opts).write();
}
