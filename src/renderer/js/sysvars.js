/**
 * @file sysvars.js
 * @brief System variables (GETVAR / SETVAR) mapped onto application and document state.
 *
 * `buildSysvars(app)` returns a table `{NAME: {get(), set?(v)}}`; a variable without `set` is
 * read-only. Values are plain JS numbers, strings or `[x, y, z]` arrays. SETVAR and the AutoLISP
 * functions getvar / setvar use this table (`lisp.sysvars`).
 *
 * To add a variable, add one `this.def('NAME', () => value, (v) => { ...; app.changed(); })`
 * line to the group it belongs to. The ORDER of the definitions is the order of the lists in the
 * generated guidebook, so add new ones at the end of their group.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import * as G from './geom.js';
import { fmtLen } from './units.js';

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

/** @returns {number} 1 for a true value, else 0. */
const bool = (v) => (v ? 1 : 0);

/** The bits of the OSMODE value, one per object snap mode. */
const OSMODE_BITS = {
  end: 1,
  mid: 2,
  cen: 4,
  nod: 8,
  qua: 16,
  int: 32,
  ins: 64,
  per: 128,
  tan: 256,
  nea: 512,
  gcen: 1024,
  app: 2048,
  ext: 4096,
  par: 8192,
};

/** Drawing limits when none were set. */
const DEFAULT_LIMITS = { x0: 0, y0: 0, x1: 420, y1: 297 };
/** LUNITS value (1..5) by unit type. */
const LUNITS_BY_TYPE = {
  scientific: 1,
  decimal: 2,
  engineering: 3,
  architectural: 4,
  fractional: 5,
};
/** Unit type by LUNITS value. */
const LUNITS_TYPES = ['', 'scientific', 'decimal', 'engineering', 'architectural', 'fractional'];
/** AUNITS value (0..3) by angle unit. */
const AUNITS_BY_TYPE = { deg: 0, dms: 1, grad: 2, rad: 3 };
/** Angle unit by AUNITS value. */
const AUNITS_TYPES = ['deg', 'dms', 'grad', 'rad'];
/** The Julian date of 1970-01-01 00:00 UTC, and the milliseconds in a day (for DATE). */
const JULIAN_UNIX_EPOCH = 2440587.5;
const MS_PER_DAY = 86400000;

const { rad } = G;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Builds the table of system variables for one application. */
export class SystemVariables {
  /** @param {object} app the application */
  constructor(app) {
    this.app = app;
    /** The table: `{NAME: {get, set}}`. */
    this.table = {};
    this.defineDisplayAndSnap();
    this.defineCurrentProperties();
    this.defineUnits();
    this.defineCommandDefaults();
    this.defineDimensionStyle();
    this.defineSession();
    this.defineSpacesFilesAndView();
    this.defineTimeAndProduct();
    this.defineResultsAndUserVars();
    this.defineConstants();
  }

  // ---------------------------------------------------------------- helpers

  /** @private The document. */
  d() {
    return this.app.doc;
  }

  /** @private The settings. */
  s() {
    return this.app.settings;
  }

  /**
   * Defines one variable.
   * @param {string} name
   * @param {Function} get returns the value
   * @param {Function} [set] stores a value (absent = read-only)
   */
  def(name, get, set) {
    this.table[name] = { get, set };
  }

  /** @private A variable with a fixed value that accepts (and ignores) a new value. */
  constant(name, value) {
    this.def(
      name,
      () => value,
      () => {},
    );
  }

  /** @private A variable that reflects a value of the application (a no-op setter). */
  live(name, get) {
    this.def(name, get, () => {});
  }

  /** @private A variable stored in a boolean setting of the application (shown as 0 / 1). */
  flag(name, key) {
    const app = this.app;
    this.def(
      name,
      () => bool(this.s()[key]),
      (v) => app.set(key, !!v),
    );
  }

  /** @private A variable stored as is in a setting of the application. */
  setting(name, key) {
    const app = this.app;
    this.def(
      name,
      () => this.s()[key],
      (v) => app.set(key, v),
    );
  }

  /** @private A number of the current dimension style (DIMTXT, DIMASZ, ...). */
  dimNumber(name, key) {
    const app = this.app;
    this.def(
      name,
      () => (this.d().dimStyles[this.d().curDimStyle] || {})[key],
      (v) => {
        this.d().dimStyles[this.d().curDimStyle][key] = v;
        app.changed();
      },
    );
  }

  // ---------------------------------------------------------------- groups

  /** @private Object snap, ortho, polar, grid, snap, dynamic input, display options. */
  defineDisplayAndSnap() {
    const app = this.app;
    const s = () => this.s();
    this.def(
      'OSMODE',
      () => s().osnapModes.reduce((n, k) => n | (OSMODE_BITS[k] || 0), 0),
      (v) => {
        s().osnapModes = Object.keys(OSMODE_BITS).filter((k) => v & OSMODE_BITS[k]);
        app.set('osnapModes', s().osnapModes);
      },
    );
    this.flag('ORTHOMODE', 'ortho');
    this.flag('POLARMODE', 'polar');
    this.flag('GRIDMODE', 'grid');
    this.def(
      'GRIDSTYLE',
      () => (s().gridStyle === 'dots' ? 1 : 0),
      (v) => app.set('gridStyle', v ? 'dots' : 'lines'),
    );
    this.def(
      'GRIDMAJOR',
      () => s().gridMajor || 5,
      (v) => app.set('gridMajor', Math.max(2, Math.round(v) || 5)),
    );
    this.flag('SNAPMODE', 'snap');
    this.def(
      'GRIDUNIT',
      () => [s().gridSpacing, s().gridSpacing],
      (v) => app.set('gridSpacing', Array.isArray(v) ? v[0] : v),
    );
    this.def(
      'SNAPUNIT',
      () => [s().snapSpacing, s().snapSpacing],
      (v) => app.set('snapSpacing', Array.isArray(v) ? v[0] : v),
    );
    this.constant('AUTOSNAP', 63);
    this.def(
      'DYNMODE',
      () => (s().dyn ? 3 : 0),
      (v) => app.set('dyn', v !== 0),
    );
    this.flag('LWDISPLAY', 'lwt');
    this.setting('PICKBOX', 'pickbox');
    this.setting('APERTURE', 'aperture');
    this.flag('GRIPS', 'grips');
    this.setting('CURSORSIZE', 'crosshair');
    this.def(
      'UCSICON',
      () => (s().ucsIcon ? 3 : 0),
      (v) => app.set('ucsIcon', !!v),
    );
    this.flag('ZOOMWHEEL', 'zoomWheelReverse');
  }

  /** @private Current layer, colour, linetype, lineweight, styles, text size. */
  defineCurrentProperties() {
    const app = this.app;
    const d = () => this.d();
    this.def(
      'CLAYER',
      () => d().cur.layer,
      (v) => {
        if (!d().hasLayer(v)) throw new Error('Invalid layer name');
        d().cur.layer = d().layer(v).name;
        app.emit('doc');
      },
    );
    this.def(
      'CECOLOR',
      () => {
        const c = d().cur.color;
        return c == null ? 'BYLAYER' : c === 'bb' ? 'BYBLOCK' : String(c);
      },
      (v) => {
        const u = String(v).toUpperCase();
        d().cur.color =
          u === 'BYLAYER' ? null : u === 'BYBLOCK' ? 'bb' : /^#/.test(u) ? v : parseInt(u, 10);
        app.emit('doc');
      },
    );
    this.def(
      'CELTYPE',
      () => d().cur.ltype || 'BYLAYER',
      (v) => {
        d().cur.ltype = /^bylayer$/i.test(v) ? null : /^byblock$/i.test(v) ? 'bb' : v;
        app.emit('doc');
      },
    );
    this.def(
      'CELWEIGHT',
      () => (d().cur.lw == null ? -1 : d().cur.lw === 'bb' ? -2 : Math.round(d().cur.lw * 100)),
      (v) => {
        d().cur.lw = v === -1 ? null : v === -2 ? 'bb' : v / 100;
      },
    );
    this.constant('CELTSCALE', 1);
    this.def(
      'LTSCALE',
      () => d().ltscale,
      (v) => {
        if (v > 0) {
          d().ltscale = v;
          app.changed();
        }
      },
    );
    this.def(
      'PDMODE',
      () => d().pdmode,
      (v) => {
        d().pdmode = v;
        app.changed();
      },
    );
    this.def(
      'PDSIZE',
      () => d().pdsize,
      (v) => {
        d().pdsize = v;
        app.changed();
      },
    );
    this.def(
      'TEXTSTYLE',
      () => d().curTextStyle,
      (v) => {
        if (d().textStyles[v]) d().curTextStyle = v;
      },
    );
    this.def(
      'DIMSTYLE',
      () => d().curDimStyle,
      (v) => {
        if (d().dimStyles[v]) d().curDimStyle = v;
      },
    );
    this.def(
      'TEXTSIZE',
      () => app.textH || 2.5,
      (v) => {
        app.textH = v;
      },
    );
  }

  /** @private Length and angle units. */
  defineUnits() {
    const d = () => this.d();
    this.def(
      'LUNITS',
      () => LUNITS_BY_TYPE[d().units.type] || 2,
      (v) => {
        d().units.type = LUNITS_TYPES[v] || 'decimal';
      },
    );
    this.def(
      'LUPREC',
      () => d().units.prec,
      (v) => {
        d().units.prec = v;
      },
    );
    this.def(
      'AUNITS',
      () => AUNITS_BY_TYPE[d().units.angType] || 0,
      (v) => {
        d().units.angType = AUNITS_TYPES[v] || 'deg';
      },
    );
    this.def(
      'AUPREC',
      () => d().units.aprec,
      (v) => {
        d().units.aprec = v;
      },
    );
    this.def(
      'ANGDIR',
      () => bool(d().units.angCW),
      (v) => {
        d().units.angCW = !!v;
      },
    );
    this.def(
      'ANGBASE',
      () => d().units.angBase || 0,
      (v) => {
        d().units.angBase = v;
      },
    );
  }

  /** @private Defaults remembered by FILLET, CHAMFER, OFFSET, POLYGON and HATCH. */
  defineCommandDefaults() {
    const app = this.app;
    this.def(
      'FILLETRAD',
      () => (app.filletOpts ? app.filletOpts.r : 0),
      (v) => {
        (app.filletOpts ||= { r: 0, multi: false }).r = v;
      },
    );
    this.def(
      'CHAMFERA',
      () => (app.chamOpts ? app.chamOpts.d1 : 0),
      (v) => {
        (app.chamOpts ||= { d1: 0, d2: 0 }).d1 = v;
      },
    );
    this.def(
      'CHAMFERB',
      () => (app.chamOpts ? app.chamOpts.d2 : 0),
      (v) => {
        (app.chamOpts ||= { d1: 0, d2: 0 }).d2 = v;
      },
    );
    this.def(
      'OFFSETDIST',
      () => (app.offset ? app.offset.d : 10),
      (v) => {
        (app.offset ||= { d: 10, erase: false }).d = v;
      },
    );
    this.def(
      'POLYSIDES',
      () => app.polySides || 4,
      (v) => {
        app.polySides = v;
      },
    );
    this.def(
      'HPNAME',
      () => (app.hatchOpts ? app.hatchOpts.pattern : 'ANSI31'),
      (v) => {
        (app.hatchOpts ||= { pattern: 'ANSI31', scale: 1, angle: 0 }).pattern = v;
      },
    );
    this.def(
      'HPSCALE',
      () => (app.hatchOpts ? app.hatchOpts.scale : 1),
      (v) => {
        (app.hatchOpts ||= { pattern: 'ANSI31', scale: 1, angle: 0 }).scale = v;
      },
    );
    this.def(
      'HPANG',
      () => (app.hatchOpts ? rad(app.hatchOpts.angle) : 0),
      (v) => {
        (app.hatchOpts ||= { pattern: 'ANSI31', scale: 1, angle: 0 }).angle = (v * 180) / Math.PI;
      },
    );
  }

  /** @private The current dimension style. */
  defineDimensionStyle() {
    const app = this.app;
    const d = () => this.d();
    this.def(
      'DIMSCALE',
      () => (d().dimStyles[d().curDimStyle] || {}).scale || 1,
      (v) => {
        (d().dimStyles[d().curDimStyle] || {}).scale = v;
        app.changed();
      },
    );
    this.dimNumber('DIMTXT', 'h');
    this.dimNumber('DIMASZ', 'asz');
    this.dimNumber('DIMEXO', 'eo');
    this.dimNumber('DIMEXE', 'ee');
    this.dimNumber('DIMGAP', 'gap');
    this.dimNumber('DIMDEC', 'prec');
  }

  /** @private The running session: last point and angle, command echo, active command, ... */
  defineSession() {
    const app = this.app;
    this.def(
      'LASTPOINT',
      () => [app.lastPoint.x, app.lastPoint.y, 0],
      (v) => {
        app.lastPoint = { x: v[0], y: v[1] };
      },
    );
    this.live('LASTANGLE', () => app.lastAngle || 0);
    this.def(
      'CMDECHO',
      () => (app.cmdEcho === false ? 0 : 1),
      (v) => {
        app.cmdEcho = !!v;
      },
    );
    this.live('CMDACTIVE', () => (app.running ? 1 : 0));
    this.live('CMDNAMES', () => app.cmdName || '');
    this.constant('FILEDIA', 1);
    this.constant('REGENMODE', 1);
    this.constant('MIRRTEXT', 0);
    this.constant('BLIPMODE', 0);
    this.constant('HIGHLIGHT', 1);
    this.constant('PICKFIRST', 1);
    this.constant('PICKADD', 1);
    this.constant('PICKSTYLE', 0);
    this.constant('DELOBJ', 1);
  }

  /** @private Model / layout space, file name, insert units, limits, view. */
  defineSpacesFilesAndView() {
    const app = this.app;
    const d = () => this.d();
    this.def(
      'TILEMODE',
      () => bool(app.space === 'model'),
      (v) => {
        if (v) app.switchSpace('model');
        else {
          const n = Object.keys(d().layouts)[0];
          if (n) app.switchSpace(n);
        }
      },
    );
    this.live('CVPORT', () => (app.mspace ? 2 : 1));
    this.live('DWGNAME', () => `${d().name}.mcad`);
    this.live('DWGPREFIX', () => (d().path ? d().path.replace(/[^\\/]*$/, '') : ''));
    this.live('DWGTITLED', () => bool(d().path));
    this.live('DBMOD', () => bool(d().dirty));
    this.def(
      'INSUNITS',
      () => d().insUnits ?? 0,
      (v) => {
        d().insUnits = v;
      },
    );
    this.def(
      'LIMMIN',
      () => {
        const l = d().limits || DEFAULT_LIMITS;
        return [l.x0, l.y0];
      },
      (v) => {
        d().limits = { ...(d().limits || DEFAULT_LIMITS), x0: v[0], y0: v[1] };
      },
    );
    this.def(
      'LIMMAX',
      () => {
        const l = d().limits || DEFAULT_LIMITS;
        return [l.x1, l.y1];
      },
      (v) => {
        d().limits = { ...(d().limits || DEFAULT_LIMITS), x1: v[0], y1: v[1] };
      },
    );
    this.def(
      'VIEWCTR',
      () => [app.activeView().cx, app.activeView().cy, 0],
      (v) => app.setZoom(v[0], v[1], app.view.zoom, false),
    );
    this.live('VIEWSIZE', () => app.activeView().h / app.activeView().zoom);
    this.live('SCREENSIZE', () => [app.view.w, app.view.h]);
  }

  /** @private Date, time, user and program identification. */
  defineTimeAndProduct() {
    this.live('CDATE', () => {
      const n = new Date();
      const p = (x, l = 2) => String(x).padStart(l, '0');
      return +`${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}.${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
    });
    this.live('DATE', () => JULIAN_UNIX_EPOCH + new Date().getTime() / MS_PER_DAY);
    this.live('MILLISECS', () => Math.round(performance.now()));
    this.constant('USERNAME', 'user');
    this.constant('ACADVER', '16.2');
    this.constant('PRODUCT', 'MacCAD 2027');
    this.constant('PLATFORM', 'macOS');
  }

  /** @private Results of the last measurement, the LISP error number and the USERI1..USERS5 slots. */
  defineResultsAndUserVars() {
    const app = this.app;
    this.live('PERIMETER', () => app.lastPerimeter || 0);
    this.live('AREA', () => app.lastArea || 0);
    this.live('DISTANCE', () => app.lastDistance || 0);
    this.def(
      'ERRNO',
      () => app.lispErrno || 0,
      (v) => {
        app.lispErrno = v;
      },
    );
    for (let i = 1; i <= 5; i += 1) {
      this.def(
        `USERI${i}`,
        () => app.userVars?.[`I${i}`] ?? 0,
        (v) => {
          (app.userVars ||= {})[`I${i}`] = v;
        },
      );
      this.def(
        `USERR${i}`,
        () => app.userVars?.[`R${i}`] ?? 0,
        (v) => {
          (app.userVars ||= {})[`R${i}`] = v;
        },
      );
      this.def(
        `USERS${i}`,
        () => app.userVars?.[`S${i}`] ?? '',
        (v) => {
          (app.userVars ||= {})[`S${i}`] = v;
        },
      );
    }
  }

  /** @private Variables that exist for compatibility with AutoCAD programs and always have the same value. */
  defineConstants() {
    this.constant('TEXTEVAL', 0);
    this.constant('ATTMODE', 1);
    this.constant('SPLFRAME', 0);
    this.constant('MEASUREMENT', 1);
    this.constant('FIELDEVAL', 31);
    this.constant('PSLTSCALE', 1);
    this.constant('MSLTSCALE', 1);
    this.constant('TREEDEPTH', 3020);
    this.constant('UCSNAME', '');
    this.constant('WORLDUCS', 1);
    this.constant('SAVEFILE', '');
    this.constant('TDUPDATE', 0);
    this.constant('FACETRES', 0.5);
  }
}

/* ============================================================================================
 * 4. FACTORY AND COMPATIBILITY EXPORTS
 * ========================================================================================== */

/**
 * Builds the system variable table for an application.
 * @param {object} app the application
 * @returns {Object<string, {get: Function, set?: Function}>}
 */
export function buildSysvars(app) {
  return new SystemVariables(app).table;
}
export const FMT = fmtLen;
