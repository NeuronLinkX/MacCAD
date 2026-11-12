/**
 * @file dxf.js
 * @brief DXF export (R12 / AC1009 ASCII) and a tolerant import of the common entities.
 *
 * `exportDXF(doc)` returns the DXF text of a drawing; `importDXF(text, name)` returns
 * `{doc, warnings}`. The binary-free R2000 writer for DWG lives in dxf2000.js; the DWG reader in
 * dwg.js uses `importDXF` for the text it converts.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import * as E from './entities.js';
import { Doc, aciHex, LINETYPES } from './doc.js';
import { decodeText, parseMText } from './textcodes.js';
import { fontFileName } from './fonts.js';

const { TAU, deg, rad } = G;

/* ============================================================================================
 * 2. COLOUR HELPERS
 * ========================================================================================== */

/** AutoCAD colour index helpers for the writer. */
class AciMatch {
  /** The palette as [index, r, g, b] (made on first use). */
  static palette = null;

  /** @returns {number} the colour index (1..255) whose colour is nearest to "#rrggbb". */
  static nearest(hex) {
    if (!AciMatch.palette) {
      AciMatch.palette = [];
      for (let i = 1; i < 256; i += 1) {
        const h = aciHex(i);
        AciMatch.palette.push([
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
    for (const [i, rr, gg, bb] of AciMatch.palette) {
      const d = (rr - r) ** 2 + (gg - g) ** 2 + (bb - b) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** @returns {number} the colour index for a colour setting (true colours are matched). */
  static of(c) {
    return typeof c === 'number'
      ? c
      : typeof c === 'string' && c[0] === '#'
        ? AciMatch.nearest(c)
        : 7;
  }
}

/* ============================================================================================
 * 3. EXPORT
 * ========================================================================================== */

/** Writes a drawing as R12 ASCII DXF. Use `DxfWriter.write(doc)`. */
export class DxfWriter {
  /** @param {object} doc the document */
  constructor(doc) {
    this.doc = doc;
    /** The lines of the file. */
    this.out = [];
  }

  /** @returns {string} the DXF text of a drawing. */
  static write(doc) {
    return new DxfWriter(doc).run();
  }

  /** Writes one group: code, then value. */
  w(code, val) {
    this.out.push(String(code));
    this.out.push(
      typeof val === 'number'
        ? Number.isInteger(val)
          ? String(val)
          : String(+val.toFixed(10))
        : String(val),
    );
  }

  /** Writes a point as groups 10+i, 20+i, 30+i. */
  pt(p, i = 0) {
    this.w(10 + i, p.x);
    this.w(20 + i, p.y);
    this.w(30 + i, 0);
  }

  /** @private Writes the whole file. */
  run() {
    const { doc } = this;
    this.header(doc);
    this.tables(doc);
    this.blocks(doc);
    this.entities(doc);
    this.w(0, 'EOF');
    return this.out.join('\n') + '\n';
  }

  /** @private HEADER section. */
  header(doc) {
    const w = this.w.bind(this);
    w(0, 'SECTION');
    w(2, 'HEADER');
    w(9, '$ACADVER');
    w(1, 'AC1009');
    w(9, '$LTSCALE');
    w(40, doc.ltscale);
    w(9, '$PDMODE');
    w(70, doc.pdmode);
    w(9, '$PDSIZE');
    w(40, doc.pdsize);
    w(0, 'ENDSEC');
  }

  /** @private TABLES section: linetypes, layers, text styles. */
  tables(doc) {
    const w = this.w.bind(this);
    w(0, 'SECTION');
    w(2, 'TABLES');
    w(0, 'TABLE');
    w(2, 'LTYPE');
    w(70, Object.keys(doc.ltypes).length);
    for (const [name, pat] of Object.entries(doc.ltypes)) {
      w(0, 'LTYPE');
      w(2, name);
      w(70, 0);
      w(3, name);
      w(72, 65);
      w(73, pat.length);
      w(
        40,
        pat.reduce((t, v) => t + Math.abs(v), 0),
      );
      pat.forEach((v) => w(49, v));
    }
    w(0, 'ENDTAB');
    w(0, 'TABLE');
    w(2, 'LAYER');
    w(70, doc.layers.length);
    for (const l of doc.layers) {
      w(0, 'LAYER');
      w(2, l.name);
      w(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      w(62, (l.on ? 1 : -1) * AciMatch.of(l.color));
      w(6, l.ltype || 'Continuous');
    }
    w(0, 'ENDTAB');
    w(0, 'TABLE');
    w(2, 'STYLE');
    w(70, Object.keys(doc.textStyles).length);
    for (const [n, s] of Object.entries(doc.textStyles)) {
      w(0, 'STYLE');
      w(2, n);
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
    w(0, 'ENDSEC');
  }

  /** @private BLOCKS section. */
  blocks(doc) {
    const w = this.w.bind(this);
    w(0, 'SECTION');
    w(2, 'BLOCKS');
    for (const b of Object.values(doc.blocks)) {
      w(0, 'BLOCK');
      w(8, '0');
      w(2, b.name);
      w(70, 0);
      this.pt(b.base);
      w(3, b.name);
      w(1, '');
      for (const e of b.ents) this.emit(e, false);
      w(0, 'ENDBLK');
      w(8, '0');
    }
    w(0, 'ENDSEC');
  }

  /** @private ENTITIES section: model space, then the objects of every layout (paper space). */
  entities(doc) {
    const w = this.w.bind(this);
    w(0, 'SECTION');
    w(2, 'ENTITIES');
    for (const e of doc.model) this.emit(e, false);
    for (const lay of Object.values(doc.layouts))
      for (const e of lay.ents) if (e.type !== 'viewport') this.emit(e, true);
    w(0, 'ENDSEC');
  }

  /** @private The groups every entity starts with: type, paper space flag, layer, colour, linetype. */
  common(e, name, paper) {
    const w = this.w.bind(this);
    w(0, name);
    if (paper) w(67, 1);
    w(8, e.layer);
    if (e.color != null && e.color !== 'bb') w(62, AciMatch.of(e.color));
    else if (e.color === 'bb') w(62, 0);
    if (e.ltype && e.ltype !== 'bb') w(6, e.ltype);
  }

  /** @private Writes one entity (shapes DXF R12 does not have are written as lines and polylines). */
  emit(e, paper) {
    const w = this.w.bind(this);
    const pt = this.pt.bind(this);
    const common = this.common.bind(this);
    switch (e.type) {
      case 'line':
        common(e, 'LINE', paper);
        pt(e.p1);
        pt(e.p2, 1);
        break;
      case 'circle':
        common(e, 'CIRCLE', paper);
        pt(e.c);
        w(40, e.r);
        break;
      case 'arc':
        common(e, 'ARC', paper);
        pt(e.c);
        w(40, e.r);
        w(50, deg(G.normAng(e.a0)));
        w(51, deg(G.normAng(e.a1)));
        break;
      case 'point':
        common(e, 'POINT', paper);
        pt(e.p);
        break;
      case 'pline': {
        common(e, 'POLYLINE', paper);
        w(66, 1);
        w(70, e.closed ? 1 : 0);
        for (const v of e.pts) {
          w(0, 'VERTEX');
          w(8, e.layer);
          pt(v);
          if (v.b) w(42, v.b);
        }
        w(0, 'SEQEND');
        w(8, e.layer);
        break;
      }
      case 'ellipse':
      case 'spline': {
        const pts = e.type === 'ellipse' ? E.ellipsePts(e, 120) : E.splinePts(e);
        common(e, 'POLYLINE', paper);
        w(66, 1);
        w(70, e.closed ? 1 : 0);
        for (const v of pts) {
          w(0, 'VERTEX');
          w(8, e.layer);
          pt(v);
        }
        w(0, 'SEQEND');
        w(8, e.layer);
        break;
      }
      case 'text':
        common(e, 'TEXT', paper);
        pt(e.p);
        w(40, e.h);
        w(1, e.str);
        if (e.rot) w(50, deg(e.rot));
        w(7, e.style || 'Standard');
        break;
      case 'mtext': {
        for (const k of E.explode(e, null) || []) {
          k.layer = e.layer;
          this.emit(k, paper);
        }
        break;
      }
      case 'insert':
        common(e, 'INSERT', paper);
        w(2, e.name);
        pt(e.p);
        w(41, e.sx ?? 1);
        w(42, e.sy ?? e.sx ?? 1);
        w(50, deg(e.rot || 0));
        break;
      case 'xline':
        common(e, 'XLINE', paper);
        pt(e.p);
        pt(e.dir, 1);
        break;
      case 'ray':
        common(e, 'RAY', paper);
        pt(e.p);
        pt(e.dir, 1);
        break;
      case 'donut':
        this.emit({ ...e, type: 'circle', c: e.c, r: e.rin }, paper);
        this.emit({ ...e, type: 'circle', c: e.c, r: e.rout }, paper);
        break;
      case 'hatch': {
        if (e.pattern === 'SOLID')
          for (const l of e.loops.slice(0, 1))
            this.emit(
              { ...e, type: 'pline', pts: l.map((p) => ({ ...p, b: 0 })), closed: true },
              paper,
            );
        else
          for (const [a, b] of E.hatchLines(e))
            this.emit({ ...e, type: 'line', p1: a, p2: b }, paper);
        break;
      }
      case 'dim':
      case 'leader': {
        for (const k of E.explode(e, this.doc) || (e.type === 'leader' ? [] : []))
          this.emit(k, paper);
        break;
      }
      default:
        break;
    }
  }
}

/* ============================================================================================
 * 4. IMPORT
 * ========================================================================================== */

/** Reads DXF text into a document. Use `DxfReader.read(text, name)`. */
export class DxfReader {
  /**
   * @param {string} text the DXF text
   * @param {string} [name] the drawing name
   */
  constructor(text, name = 'Drawing1') {
    this.pairs = DxfReader.parsePairs(text);
    this.doc = new Doc();
    this.doc.name = name;
    this.doc.layers = [];
    this.doc.ltypes = { ...LINETYPES };
    /** Section ranges by name: [first pair, ENDSEC pair]. */
    this.sections = {};
    /** Messages about things that could not be imported exactly. */
    this.warnings = new Set();
    /** True once a STYLE table entry replaced the default text styles. */
    this.stylesFromFile = false;
  }

  /**
   * Reads DXF text.
   * @param {string} text
   * @param {string} [name]
   * @returns {{doc: object, warnings: string[]}}
   */
  static read(text, name = 'Drawing1') {
    return new DxfReader(text, name).run();
  }

  // ---------------------------------------------------------------- group access

  /** @returns {Array<[number, string]>} the (group code, value) pairs of a DXF text. */
  static parsePairs(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      let v = lines[i + 1];
      if (v.includes('\\U+'))
        v = v.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      pairs.push([parseInt(lines[i].trim(), 10), v]);
    }
    return pairs;
  }

  /** Reads the entity that starts at pair i (a group 0): `{type, g: [[code, value]...], next}`. */
  static readEntity(pairs, i) {
    const type = pairs[i][1].trim();
    const g = [];
    let j = i + 1;
    while (j < pairs.length && pairs[j][0] !== 0) {
      g.push(pairs[j]);
      j += 1;
    }
    return { type, g, next: j };
  }

  /** The first value of a group code (or d). */
  static get(g, c, d) {
    const f = g.find((x) => x[0] === c);
    return f ? f[1] : d;
  }

  /** The first value of a group code as a number. */
  static num(g, c, d = 0) {
    const f = g.find((x) => x[0] === c);
    return f ? parseFloat(f[1]) : d;
  }

  /** All values of a group code as numbers. */
  static all(g, c) {
    return g.filter((x) => x[0] === c).map((x) => parseFloat(x[1]));
  }

  /** All values of a group code as strings. */
  static all2(g, c) {
    return g.filter((x) => x[0] === c).map((x) => x[1]);
  }

  /** The point in groups 10+i / 20+i. */
  static P2(g, i = 0, d = 0) {
    return { x: DxfReader.num(g, 10 + i, d), y: DxfReader.num(g, 20 + i, d) };
  }

  // ---------------------------------------------------------------- reading the file

  /** @private Reads the whole file. */
  run() {
    this.findSections();
    this.readHeader();
    this.readTables();
    this.addDefaults();
    this.readBlocks();
    this.readModelSpace();
    this.doc.dirty = false;
    return { doc: this.doc, warnings: [...this.warnings] };
  }

  /** @private Finds the sections (HEADER, TABLES, BLOCKS, ENTITIES, ...). */
  findSections() {
    const { pairs, sections } = this;
    let i = 0;
    while (i < pairs.length) {
      if (pairs[i][0] === 0 && pairs[i][1].trim() === 'SECTION') {
        const nm = (pairs[i + 1] || [0, ''])[1].trim();
        let j = i + 2;
        const start = j;
        while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1].trim() === 'ENDSEC')) j += 1;
        sections[nm] = [start, j];
        i = j + 1;
      } else i += 1;
    }
  }

  /** @private HEADER: line type scale and point style. */
  readHeader() {
    const { pairs, sections, doc } = this;
    if (!sections.HEADER) return;
    const [a, b] = sections.HEADER;
    for (let k = a; k < b; k += 1)
      if (pairs[k][0] === 9) {
        const v = pairs[k + 1];
        if (pairs[k][1].trim() === '$LTSCALE' && v) doc.ltscale = parseFloat(v[1]) || 1;
        if (pairs[k][1].trim() === '$PDMODE' && v) doc.pdmode = parseInt(v[1], 10) || 0;
        if (pairs[k][1].trim() === '$PDSIZE' && v) doc.pdsize = parseFloat(v[1]) || 0;
      }
  }

  /** @private TABLES: layers, text styles, linetypes. */
  readTables() {
    const { pairs, sections, doc } = this;
    const { get, num, all } = DxfReader;
    if (!sections.TABLES) return;
    const [a, b] = sections.TABLES;
    for (let k = a; k < b; ) {
      if (
        pairs[k][0] === 0 &&
        (pairs[k][1].trim() === 'LAYER' ||
          pairs[k][1].trim() === 'LTYPE' ||
          pairs[k][1].trim() === 'STYLE')
      ) {
        const en = DxfReader.readEntity(pairs, k);
        if (en.type === 'LAYER') {
          const c = num(en.g, 62, 7);
          const fl = num(en.g, 70, 0);
          doc.layers.push({
            name: get(en.g, 2, '0'),
            color: Math.abs(c) || 7,
            ltype: get(en.g, 6, 'Continuous'),
            lw: 0.25,
            on: c >= 0,
            frozen: !!(fl & 1),
            locked: !!(fl & 4),
            plot: true,
          });
        } else if (en.type === 'STYLE') {
          const nm = get(en.g, 2, '');
          const fam = get(en.g, 1000, null);
          if (nm) {
            if (!this.stylesFromFile) {
              doc.textStyles = {};
              this.stylesFromFile = true;
            }
            doc.textStyles[nm] = {
              font:
                (fam && !/\.shx$/i.test(get(en.g, 3, '')) ? fam : '') ||
                get(en.g, 3, '') ||
                'Arial',
              big: get(en.g, 4, ''),
              wf: num(en.g, 41, 1) || 1,
              obl: num(en.g, 50, 0),
              h: num(en.g, 40, 0),
            };
          }
        } else {
          const pat = all(en.g, 49);
          const nm = get(en.g, 2, '');
          if (nm && !doc.ltypes[nm]) doc.ltypes[nm] = pat;
        }
        k = en.next;
      } else k += 1;
    }
  }

  /** @private Makes sure the standard text style and layer 0 exist. */
  addDefaults() {
    const { doc } = this;
    if (!doc.textStyles.Standard) doc.textStyles.Standard = { font: 'Arial', wf: 1, obl: 0, h: 0 };
    if (!doc.layers.some((l) => l.name === '0'))
      doc.layers.unshift({
        name: '0',
        color: 7,
        ltype: 'Continuous',
        lw: 0.25,
        on: true,
        frozen: false,
        locked: false,
        plot: true,
      });
  }

  /** @private The colour of an entity: a true colour "#rrggbb", an index, 'bb' (ByBlock) or null (ByLayer). */
  colorOf(g) {
    const { get } = DxfReader;
    const t = get(g, 420, null);
    if (t != null) {
      const v = parseInt(t, 10);
      return (
        '#' +
        [(v >> 16) & 255, (v >> 8) & 255, v & 255]
          .map((x) => x.toString(16).padStart(2, '0'))
          .join('')
      );
    }
    const c = get(g, 62, null);
    if (c == null) return null;
    const n = parseInt(c, 10);
    return n === 256 ? null : n === 0 ? 'bb' : Math.abs(n);
  }

  /** @private A new entity with the common properties (layer, colour, linetype, lineweight) of the group list. */
  base(g, type, props) {
    const { get } = DxfReader;
    const doc = this.doc;
    const e = E.mk(type, props);
    e.layer = get(g, 8, '0');
    e.color = this.colorOf(g);
    const lt = get(g, 6, null);
    e.ltype =
      lt && lt.toUpperCase() !== 'BYLAYER' ? (lt.toUpperCase() === 'BYBLOCK' ? 'bb' : lt) : null;
    const lw = parseInt(get(g, 370, '-1'), 10);
    e.lw = lw >= 0 ? lw / 100 : null;
    if (!doc.layers.some((l) => l.name === e.layer))
      doc.layers.push({
        name: e.layer,
        color: 7,
        ltype: 'Continuous',
        lw: 0.25,
        on: true,
        frozen: false,
        locked: false,
        plot: true,
      });
    return e;
  }

  // ---------------------------------------------------------------- entities

  /**
   * Reads the entities in pairs [a, b).
   * @private
   * @returns {object[]} the entities (each with a `paper` flag)
   */
  readEntities(a, b) {
    const { pairs } = this;
    const { P2, num, get } = DxfReader;
    const list = [];
    let k = a;
    while (k < b) {
      if (pairs[k][0] !== 0) {
        k += 1;
        continue;
      }
      const en = DxfReader.readEntity(pairs, k);
      const g = en.g;
      k = en.next;
      let e = null;
      switch (en.type) {
        case 'LINE':
          e = this.base(g, 'line', { p1: P2(g), p2: P2(g, 1) });
          break;
        case 'CIRCLE':
          e = this.base(g, 'circle', { c: P2(g), r: num(g, 40) });
          break;
        case 'ARC':
          e = this.base(g, 'arc', {
            c: P2(g),
            r: num(g, 40),
            a0: rad(num(g, 50)),
            a1: rad(num(g, 51)),
          });
          break;
        case 'POINT':
          e = this.base(g, 'point', { p: P2(g) });
          break;
        case 'XLINE':
        case 'RAY':
          e = this.base(g, en.type.toLowerCase(), { p: P2(g), dir: G.norm(P2(g, 1)) });
          break;
        case 'TEXT':
        case 'ATTRIB':
          e = this.readText(g);
          break;
        case 'MTEXT':
          e = this.readMText(g);
          break;
        case 'LWPOLYLINE':
          e = this.readLwPolyline(g);
          break;
        case 'POLYLINE': {
          const r = this.readPolyline(g, k, b);
          e = r.e;
          k = r.k;
          break;
        }
        case 'ELLIPSE': {
          const c = P2(g);
          const u = P2(g, 1);
          const ratio = num(g, 40, 1);
          e = this.base(g, 'ellipse', {
            c,
            u,
            v: G.mul(G.perp(u), ratio),
            a0: num(g, 41, 0),
            a1: num(g, 42, TAU),
          });
          break;
        }
        case 'SPLINE':
          e = this.readSpline(g);
          break;
        case 'LEADER': {
          const xs = DxfReader.all(g, 10);
          const ys = DxfReader.all(g, 20);
          e = this.base(g, 'leader', {
            pts: xs.map((x, ix) => ({ x, y: ys[ix] })),
            str: '',
            h: 2.5,
            tp: null,
          });
          break;
        }
        case 'SOLID':
        case 'TRACE': {
          const p = [P2(g), P2(g, 1), P2(g, 3), P2(g, 2)];
          e = this.base(g, 'hatch', {
            loops: [p.filter((q, ix) => ix === 0 || G.dist(q, p[ix - 1]) > 1e-12)],
            pattern: 'SOLID',
            scale: 1,
            angle: 0,
          });
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          const nm = get(g, 2, '');
          // DIMENSION groups 41/42/50 are spacing / measurement / angle, not an insertion transform: its block is in WCS
          if (en.type === 'INSERT')
            e = this.base(g, 'insert', {
              name: nm,
              p: P2(g),
              rot: rad(num(g, 50)),
              sx: num(g, 41, 1),
              sy: num(g, 42, num(g, 41, 1)),
            });
          else if (nm)
            e = this.base(g, 'insert', { name: nm, p: { x: 0, y: 0 }, rot: 0, sx: 1, sy: 1 });
          if (en.type === 'DIMENSION')
            this.warnings.add('Dimensions imported as exploded block geometry');
          break;
        }
        case 'HATCH':
          e = this.readHatch(g);
          break;
        case 'VIEWPORT':
        case 'SEQEND':
        case 'VERTEX':
          break;
        default:
          this.warnings.add('Unsupported entity skipped: ' + en.type);
      }
      if (e) {
        e.paper = num(g, 67, 0) === 1;
        list.push(e);
      }
    }
    return list;
  }

  /** @private TEXT / ATTRIB. */
  readText(g) {
    const { P2, num, get } = DxfReader;
    const al = num(g, 72, 0);
    const p = al || num(g, 73, 0) ? P2(g, 1) : P2(g);
    const dt = decodeText(get(g, 1, ''));
    const e = this.base(g, 'text', {
      p,
      h: num(g, 40, 2.5),
      str: dt.text,
      rot: rad(num(g, 50)),
      style: get(g, 7, 'Standard'),
      al: al === 1 || al === 4 ? 1 : al === 2 ? 2 : 0,
    });
    if (num(g, 41, 1) !== 1) e.wf = num(g, 41, 1);
    if (num(g, 51, 0)) e.obl = num(g, 51, 0);
    if (dt.u) e.u = true;
    if (dt.o) e.o = true;
    if (num(g, 73, 0) === 2 || num(g, 73, 0) === 3 || al === 4) {
      const va = num(g, 73, 0);
      const up = { x: -Math.sin(e.rot), y: Math.cos(e.rot) };
      e.p =
        va === 2 || al === 4
          ? G.add(e.p, G.mul(up, -e.h * 0.5))
          : va === 3
            ? G.add(e.p, G.mul(up, -e.h))
            : e.p;
    }
    return e;
  }

  /** @private MTEXT. */
  readMText(g) {
    const { P2, num, get, all2 } = DxfReader;
    const pm = parseMText(all2(g, 3).join('') + get(g, 1, ''));
    const str = pm.text;
    const rot = get(g, 11, null) != null ? Math.atan2(num(g, 21), num(g, 11)) : rad(num(g, 50));
    const e = this.base(g, 'mtext', {
      p: P2(g),
      h: num(g, 40, 2.5),
      str,
      rot,
      w: num(g, 41, 0),
      style: get(g, 7, 'Standard'),
      al: 0,
      att: num(g, 71, 1),
    });
    if (pm.u) e.u = true;
    if (pm.o) e.o = true;
    return e;
  }

  /** @private LWPOLYLINE. */
  readLwPolyline(g) {
    const pts = [];
    let cur = null;
    for (const [c, v] of g) {
      if (c === 10) {
        cur = { x: parseFloat(v), y: 0, b: 0 };
        pts.push(cur);
      } else if (c === 20 && cur) cur.y = parseFloat(v);
      else if (c === 42 && cur) cur.b = parseFloat(v);
    }
    return this.base(g, 'pline', { pts, closed: !!(DxfReader.num(g, 70, 0) & 1) });
  }

  /**
   * POLYLINE: the vertices follow as separate entities up to SEQEND.
   * @private
   * @param {Array} g the group list of the POLYLINE entity
   * @param {number} k the pair index after it
   * @param {number} b the end of the section
   * @returns {{e: object, k: number}} the entity and the pair index after SEQEND
   */
  readPolyline(g, k, b) {
    const { pairs } = this;
    const { num } = DxfReader;
    const pts = [];
    while (k < b && pairs[k][1].trim() !== 'SEQEND') {
      const v = DxfReader.readEntity(pairs, k);
      if (v.type === 'VERTEX' && !(num(v.g, 70, 0) & 16))
        pts.push({ x: num(v.g, 10), y: num(v.g, 20), b: num(v.g, 42, 0) });
      k = v.next;
    }
    if (k < b) k = DxfReader.readEntity(pairs, k).next;
    return { e: this.base(g, 'pline', { pts, closed: !!(num(g, 70, 0) & 1) }), k };
  }

  /** @private SPLINE: a NURBS curve is sampled; without knots the fit or control points are used. */
  readSpline(g) {
    const { all, num } = DxfReader;
    const fx = all(g, 11);
    const fy = all(g, 21);
    const cx = all(g, 10);
    const cy = all(g, 20);
    const knots = all(g, 40);
    const wts = all(g, 41);
    const degree = num(g, 71, 3);
    const ctrl = cx.map((x, ix) => ({ x, y: cy[ix] }));
    let pts;
    if (ctrl.length > degree && knots.length === ctrl.length + degree + 1)
      pts = G.nurbsPoints(ctrl, degree, knots, wts, 16);
    else if (fx.length >= 2) pts = fx.map((x, ix) => ({ x, y: fy[ix] }));
    else {
      pts = ctrl;
      this.warnings.add(
        'Spline without knots imported through its control points (shape approximate)',
      );
    }
    if (pts.length < 2) return null;
    const e = this.base(g, 'spline', {
      pts,
      closed: false,
      dense: ctrl.length > degree && knots.length === ctrl.length + degree + 1,
    });
    if (e.dense) e.nurbs = { deg: degree, knots, ctrl, w: wts.length === ctrl.length ? wts : null };
    return e;
  }

  // ---------------------------------------------------------------- hatch

  /** @private HATCH: boundary paths are polyline paths (flag bit 2) or edge paths (line / arc / ellipse / spline edges). */
  readHatch(g) {
    const { get, num } = DxfReader;
    const loops = [];
    let idx = g.findIndex((x) => x[0] === 91);
    const npaths = idx >= 0 ? parseInt(g[idx][1], 10) : 0;
    idx += 1;
    for (let pi = 0; pi < npaths && idx < g.length; pi += 1) {
      while (idx < g.length && g[idx][0] !== 92) idx += 1;
      const flag = parseInt((g[idx] || [0, 0])[1], 10);
      idx += 1;
      if (flag & 2) {
        const r = this.hatchPolylinePath(g, idx);
        idx = r.idx;
        if (r.loop) loops.push(r.loop);
      } else {
        const r = this.hatchEdgePath(g, idx);
        idx = r.idx;
        if (r.loop) loops.push(r.loop);
      }
      while (idx < g.length && g[idx][0] !== 92 && g[idx][0] !== 75 && g[idx][0] !== 97) idx += 1;
      if (idx < g.length && g[idx][0] === 97) {
        idx += 1;
        const ns = parseInt(g[idx - 1][1], 10);
        idx += ns;
      }
    }
    if (!loops.length) {
      this.warnings.add('A HATCH without a usable boundary was skipped');
      return null;
    }
    const pn = String(get(g, 2, 'SOLID')).toUpperCase();
    const solid = num(g, 70, 0) === 1 || pn === 'SOLID';
    return this.base(g, 'hatch', {
      loops,
      pattern: solid ? 'SOLID' : E.HATCH_PATTERNS[pn] !== undefined ? pn : 'ANSI31',
      scale: num(g, 41, 1) || 1,
      angle: rad(num(g, 52, 0)),
    });
  }

  /** @private A polyline boundary path of a HATCH. @returns {{loop: object[]|null, idx: number}} */
  hatchPolylinePath(g, idx) {
    const vs = [];
    while (idx < g.length && g[idx][0] !== 97 && g[idx][0] !== 92) {
      const [c, v] = g[idx];
      if (c === 10) vs.push({ x: parseFloat(v), y: 0, b: 0 });
      else if (c === 20 && vs.length) vs[vs.length - 1].y = parseFloat(v);
      else if (c === 42 && vs.length) vs[vs.length - 1].b = parseFloat(v);
      idx += 1;
    }
    return {
      loop: vs.length >= 3 ? E.closedLoop(E.mk('pline', { pts: vs, closed: true })) : null,
      idx,
    };
  }

  /** @private An edge boundary path of a HATCH (line, arc, ellipse and spline edges joined into one loop). @returns {{loop: object[]|null, idx: number}} */
  hatchEdgePath(g, idx) {
    const nEdges = parseInt((g[idx] || [0, 0])[0] === 93 ? g[idx][1] : 0, 10);
    idx += 1;
    const pts = [];
    for (let k = 0; k < nEdges && idx < g.length; k += 1) {
      const et = parseInt(g[idx][1], 10);
      idx += 1;
      const f = {};
      while (idx < g.length && g[idx][0] !== 72 && g[idx][0] !== 97 && g[idx][0] !== 92) {
        (f[g[idx][0]] ||= []).push(parseFloat(g[idx][1]));
        idx += 1;
      }
      let seg = [];
      if (et === 1)
        seg = [
          { x: f[10][0], y: f[20][0] },
          { x: f[11][0], y: f[21][0] },
        ];
      else if (et === 2) {
        const c = { x: f[10][0], y: f[20][0] };
        const r = f[40][0];
        let a0 = rad(f[50][0]);
        let a1 = rad(f[51][0]);
        if (f[73] && f[73][0] === 0) {
          const t = a0;
          a0 = -a1;
          a1 = -t;
        }
        if (a1 <= a0) a1 += TAU;
        seg = G.arcPoints(c, r, a0, a1, Math.max(r / 300, 1e-6));
        if (f[73] && f[73][0] === 0) seg = seg.map((q) => ({ x: q.x, y: 2 * c.y - q.y })).reverse();
      } else if (et === 3) {
        const c = { x: f[10][0], y: f[20][0] };
        const mj = { x: f[11][0], y: f[21][0] };
        seg = E.ellipsePts(
          E.makeEllipse(
            c,
            G.add(c, mj),
            f[40][0],
            rad(f[50][0]),
            rad(f[51][0]) <= rad(f[50][0]) ? rad(f[51][0]) + TAU : rad(f[51][0]),
          ),
          48,
        );
      } else if (et === 4 && f[10]) {
        const ctrl = f[10].map((x, i) => ({ x, y: f[20][i] }));
        seg = G.nurbsPoints(ctrl, f[94] ? f[94][0] : 3, f[40], null, 12);
      }
      if (
        pts.length &&
        seg.length &&
        G.dist(pts[pts.length - 1], seg[0]) > G.dist(pts[pts.length - 1], seg[seg.length - 1])
      )
        seg.reverse();
      for (const q of seg) if (!pts.length || G.dist(pts[pts.length - 1], q) > 1e-9) pts.push(q);
    }
    return { loop: pts.length >= 3 ? pts : null, idx };
  }

  // ---------------------------------------------------------------- blocks and model space

  /** @private BLOCKS section: block definitions (the model / paper space blocks are skipped). */
  readBlocks() {
    const { pairs, sections, doc } = this;
    if (!sections.BLOCKS) return;
    const [a, b] = sections.BLOCKS;
    let k = a;
    while (k < b) {
      if (pairs[k][0] === 0 && pairs[k][1].trim() === 'BLOCK') {
        const hd = DxfReader.readEntity(pairs, k);
        let j = hd.next;
        const s = j;
        while (j < b && !(pairs[j][0] === 0 && pairs[j][1].trim() === 'ENDBLK')) j += 1;
        const nm = DxfReader.get(hd.g, 2, '');
        if (nm && !/^\*(Model|Paper)_Space/i.test(nm))
          doc.defineBlock(
            nm,
            DxfReader.P2(hd.g),
            this.readEntities(s, j).map((e) => {
              delete e.paper;
              return e;
            }),
          );
        k = j + 1;
      } else k += 1;
    }
  }

  /** @private ENTITIES section: model space objects (paper space objects go to Layout1). */
  readModelSpace() {
    const { sections, doc } = this;
    if (!sections.ENTITIES) return;
    const [a, b] = sections.ENTITIES;
    for (const e of this.readEntities(a, b)) {
      const paper = e.paper;
      delete e.paper;
      if (paper) doc.add(e, 'Layout1');
      else doc.add(e, 'model');
    }
  }
}

/* ============================================================================================
 * 5. COMPATIBILITY EXPORTS
 * ========================================================================================== */

/** @returns {string} the DXF text of a drawing. @see DxfWriter.write */
export const exportDXF = DxfWriter.write;

/** @returns {{doc: object, warnings: string[]}} the drawing in DXF text. @see DxfReader.read */
export const importDXF = DxfReader.read;

/** @returns {string} the plain text of an MTEXT string (formatting codes removed). */
export function cleanMText(s) {
  return parseMText(s).text;
}
