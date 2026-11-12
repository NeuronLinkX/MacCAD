/**
 * @file ui.js
 * @brief The main window in the style of AutoCAD 2006: title bar, pull-down menus, toolbars, drawing
 *        area with scroll bars, layout and drawing tabs, command line, status bar, context menus and
 *        keyboard handling.
 *
 * `initUI(app)` builds the window once and returns the `ui` object (dialogs, file functions and
 * window actions) that commands use as `c.ui`. After that the parts update themselves from the
 * application events.
 *
 * Layout: ToolbarBuilder (toolbar buttons), MenuModel (the pull-down menus as data) and
 * MainWindow (the window, built in steps: build... = the parts, wire... = the behaviour).
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import { ICONS } from './icons.js';
import { aciHex, colorName, LINEWEIGHTS, newLayout } from './doc.js';
import * as E from './entities.js';
import { fmtLen } from './units.js';
import { editText } from './commands_modify.js';
import { fontStack } from './fonts.js';
import { FONT_K } from './svg.js';
import { dialogs, dialog, popupMenu, closePopups, macKeys } from './dialogs.js';
import { io } from './io.js';
import { license } from './license.js';
import { buildProps } from './props.js';
import './dialogs_lisp.js';
import './dialogs_more.js';
import './dialogs_license.js';
import { applyCustomAliases } from './commands_sys.js';
import { init3DUI, VSTYLES, VIEW_ITEMS } from './ui3d.js';
import { initHistory } from './navpanel.js';
import { COMMANDS } from './registry.js';
import { HAS_3D, commandAvailable } from './features.js';

/** Shorthand for `querySelector`. */
const $ = (sel, el = document) => el.querySelector(sel);

/** Tiny element factory: `h('div', {class: 'x', onclick: fn}, child, 'text')`. */
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};

/** Removes build-edition commands and cleans empty submenus/separators. */
const availableMenuItems = (items) => {
  const visible = [];
  for (const item of items) {
    if (!item) continue;
    if ((item.feature === '3d' && !HAS_3D) || (item.cmd && !commandAvailable(COMMANDS[item.cmd]))) continue;
    const next = item.sub ? { ...item, sub: availableMenuItems(item.sub) } : item;
    if (item.sub && !next.sub.length) continue;
    if (next.sep && (!visible.length || visible.at(-1).sep)) continue;
    visible.push(next);
  }
  while (visible.at(-1)?.sep) visible.pop();
  return visible;
};

/** The Standard toolbar: [icon, command, tooltip, argument?] per button; '|' is a separator. */
const TB_STANDARD = [
  ['new', 'NEW', 'New (Ctrl+N)'],
  ['open', 'OPEN', 'Open (Ctrl+O)'],
  ['save', 'SAVE', 'Save (Ctrl+S)'],
  ['plot', 'PLOT', 'Plot (Ctrl+P)'],
  ['preview', 'PREVIEW', 'Plot Preview'],
  '|',
  ['cut', 'CUTCLIP', 'Cut to Clipboard'],
  ['copyclip', 'COPYCLIP', 'Copy to Clipboard'],
  ['paste', 'PASTECLIP', 'Paste from Clipboard'],
  ['matchprop', 'MATCHPROP', 'Match Properties'],
  '|',
  ['undo', 'UNDO1', 'Undo (Ctrl+Z)'],
  ['redo', 'REDO', 'Redo (Ctrl+Y)'],
  '|',
  ['pan', 'PAN', 'Pan Realtime'],
  ['zoomrt', 'ZOOM', 'Zoom Realtime', ''],
  ['zoomwin', 'ZOOM', 'Zoom Window', 'Window'],
  ['zoomprev', 'ZOOM', 'Zoom Previous', 'Previous'],
  ['zoomext', 'ZOOM', 'Zoom Extents', 'Extents'],
  '|',
  ['props', 'PROPERTIES', 'Properties (Ctrl+1)'],
  ['help', 'HELP', 'Help (F1)'],
];

/** The Draw toolbar. */
const TB_DRAW = [
  ['line', 'LINE', 'Line'],
  ['xline', 'XLINE', 'Construction Line'],
  ['pline', 'PLINE', 'Polyline'],
  ['polygon', 'POLYGON', 'Polygon'],
  ['rect', 'RECTANG', 'Rectangle'],
  ['arc', 'ARC', 'Arc'],
  ['circle', 'CIRCLE', 'Circle'],
  ['revcloud', 'REVCLOUD', 'Revision Cloud'],
  ['spline', 'SPLINE', 'Spline'],
  ['ellipse', 'ELLIPSE', 'Ellipse'],
  ['ellipsearc', 'ELLIPSE', 'Ellipse Arc', 'arc'],
  '|',
  ['insert', 'INSERT', 'Insert Block'],
  ['block', 'BLOCK', 'Make Block'],
  ['point', 'POINT', 'Point'],
  ['hatch', 'HATCH', 'Hatch'],
  ['table', 'TABLE', 'Table'],
  ['mtext', 'MTEXT', 'Multiline Text'],
];

/** The Modify toolbar. */
const TB_MODIFY = [
  ['erase', 'ERASE', 'Erase'],
  ['copy', 'COPY', 'Copy Object'],
  ['mirror', 'MIRROR', 'Mirror'],
  ['offset', 'OFFSET', 'Offset'],
  ['array', 'ARRAY', 'Array'],
  ['move', 'MOVE', 'Move'],
  ['rotate', 'ROTATE', 'Rotate'],
  ['scale', 'SCALE', 'Scale'],
  ['stretch', 'STRETCH', 'Stretch'],
  ['lengthen', 'LENGTHEN', 'Lengthen'],
  ['trim', 'TRIM', 'Trim'],
  ['extend', 'EXTEND', 'Extend'],
  ['breakpt', 'BREAKATPOINT', 'Break at Point'],
  ['break', 'BREAK', 'Break'],
  ['join', 'JOIN', 'Join'],
  ['chamfer', 'CHAMFER', 'Chamfer'],
  ['fillet', 'FILLET', 'Fillet'],
  ['explode', 'EXPLODE', 'Explode'],
];

/** The Modeling / 3D toolbar. */
const TB_SOLIDS = [
  ['history', 'HISTORY', 'Model History (undo any step, layers)'],
  '|',
  ['box', 'BOX', 'Box'],
  ['wedge', 'WEDGE', 'Wedge'],
  ['cone', 'CONE', 'Cone'],
  ['sphere', 'SPHERE', 'Sphere'],
  ['cylinder', 'CYLINDER', 'Cylinder'],
  ['torus', 'TORUS', 'Torus'],
  ['pyramid', 'PYRAMID', 'Pyramid'],
  '|',
  ['extrude', 'EXTRUDE', 'Extrude'],
  ['revolve', 'REVOLVE', 'Revolve'],
  ['slice', 'SLICE', 'Slice'],
  '|',
  ['union', 'UNION', 'Union'],
  ['subtract', 'SUBTRACT', 'Subtract'],
  ['intersect', 'INTERSECT', 'Intersect'],
  ['interfere', 'INTERFERE', 'Interference'],
  '|',
  ['filletedge', 'FILLETEDGE', 'Fillet Edge'],
  ['chamferedge', 'CHAMFEREDGE', 'Chamfer Edge'],
  '|',
  ['move3d', '3DMOVE', '3D Move'],
  ['rotate3d', 'ROTATE3D', '3D Rotate'],
  ['mirror3d', '3DMIRROR', '3D Mirror'],
  ['orbit', '3DORBIT', '3D Orbit'],
  ['massprop', 'MASSPROP', 'Region/Mass Properties'],
];

/** The Dimension toolbar. */
const TB_DIM = [
  ['dimlinear', 'DIMLINEAR', 'Linear Dimension'],
  ['dimaligned', 'DIMALIGNED', 'Aligned Dimension'],
  ['dimradius', 'DIMRADIUS', 'Radius Dimension'],
  ['dimdiameter', 'DIMDIAMETER', 'Diameter Dimension'],
  ['dimangular', 'DIMANGULAR', 'Angular Dimension'],
  ['dimbaseline', 'DIMBASELINE', 'Baseline Dimension'],
  ['dimcontinue', 'DIMCONTINUE', 'Continue Dimension'],
  ['leader', 'MLEADER', 'Multileader'],
  ['dimstyle', 'DIMSTYLE', 'Dimension Style...'],
];

/** The items of Draw > Arc: [label, command, argument]. */
const arcSub = [
  ['3 Points', 'ARC', '3p'],
  ['Start, Center, End', 'ARC', 'sce'],
  ['Start, Center, Angle', 'ARC', 'sca'],
  ['Start, Center, Length', 'ARC', 'scl'],
  ['Start, End, Angle', 'ARC', 'sea'],
  ['Start, End, Radius', 'ARC', 'ser'],
  ['Center, Start, End', 'ARC', 'cse'],
  ['Center, Start, Angle', 'ARC', 'csa'],
  ['Continue', 'ARC', 'continue'],
];

/**
 * Builds the main window into #app and returns the `ui` object (dialogs, file functions and window actions that commands use as `c.ui`).
 * @param {object} app the application
 */
export function initUI(app) {
  return new MainWindow(app).build();
}
export { $, h };

/* ============================================================================================
 * 2. TOOLBARBUILDER
 * ========================================================================================== */

/** Builds the toolbar buttons from the toolbar tables (TB_STANDARD, TB_DRAW, ...). */
export class ToolbarBuilder {
  /** One toolbar button: icon, tooltip and the command it runs. @param {object} app @param {Array} def [icon, command, tip, argument?] */
  static button(app, [ic, cmd, tip, arg]) {
    const b = h('button', { class: 'tb', title: tip, html: ICONS[ic] || '' });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.title = macKeys(tip);
    b.addEventListener('click', () => {
      closePopups();
      app.exec(cmd, typeof arg === 'string' && arg ? arg.toLowerCase() : undefined);
    });
    return b;
  }

  /** A group of toolbar buttons; '|' in the table makes a separator. */
  static group(app, items) {
    const g = h('div', { class: 'tbgroup' });
    let separator = true;
    for (const it of items) {
      if (it === '|') { separator = true; continue; }
      if (!commandAvailable(COMMANDS[it[1]])) continue;
      if (separator && g.childElementCount) g.append(h('div', { class: 'tbsep' }));
      g.append(ToolbarBuilder.button(app, it));
      separator = false;
    }
    return g;
  }
}

/* ============================================================================================
 * 3. MENUMODEL
 * ========================================================================================== */

/** The pull-down menus as data: [[title, () => items], ...]; an item is {label, cmd, arg?, key?, check?, sub?, run?} or a separator. */
export class MenuModel {
  /** The menus of the menu bar for an application. @returns {Array<[string, Function]>} title and a function that returns the current items (check marks follow the settings) */
  static build(app) {
    const M = (label, cmd, extra = {}) => ({ label, cmd, ...extra });
    const S = { sep: true };
    const menus = [
      [
        'File',
        () => [
          M('Start Page', 'START'),
          M('New...', 'NEW', { key: 'Ctrl+N', icon: 'new' }),
          M('Open...', 'OPEN', { key: 'Ctrl+O', icon: 'open' }),
          M('Close', 'CLOSE', { key: 'Ctrl+W' }),
          S,
          M('Save', 'SAVE', { key: 'Ctrl+S', icon: 'save' }),
          M('Save As...', 'SAVEAS', { key: 'Ctrl+Shift+S' }),
          M('Export...', 'EXPORT'),
          M('Import DXF...', 'DXFIN'),
          M('Import PDF...', 'PDFIMPORT'),
          M('Import STEP...', 'STEPIN'),
          S,
          M('Page Setup Manager...', 'PAGESETUP'),
          M('Plot...', 'PLOT', { key: 'Ctrl+P', icon: 'plot' }),
          M('Plot Preview', 'PREVIEW', { icon: 'preview' }),
          S,
          { label: 'Drawing Utilities', sub: [M('Units...', 'UNITS'), M('Purge', 'PURGE')] },
          S,
          M('Exit', 'QUIT', { key: 'Ctrl+Q' }),
        ],
      ],
      [
        'Edit',
        () => [
          M(
            `Undo ${app.doc.undoStack.length ? app.doc.undoStack[app.doc.undoStack.length - 1].label.charAt(0) + app.doc.undoStack[app.doc.undoStack.length - 1].label.slice(1).toLowerCase() : ''}`.trim(),
            'UNDO1',
            { key: 'Ctrl+Z', icon: 'undo', disabled: !app.doc.undoStack.length },
          ),
          M('Redo', 'REDO', { key: 'Ctrl+Y', icon: 'redo', disabled: !app.doc.redoStack.length }),
          S,
          M('Cut', 'CUTCLIP', { key: 'Ctrl+X', icon: 'cut' }),
          M('Copy', 'COPYCLIP', { key: 'Ctrl+C', icon: 'copyclip' }),
          M('Copy with Base Point', 'COPYBASE', { key: 'Ctrl+Shift+C', icon: 'copyclip' }),
          M('Copy Link', 'COPYLINK'),
          M('Paste', 'PASTECLIP', { key: 'Ctrl+V', icon: 'paste' }),
          M('Paste as Block', 'PASTEBLOCK', { key: 'Ctrl+Shift+V', icon: 'paste' }),
          M('Paste as Hyperlink', 'PASTEHYPERLINK'),
          M('Paste to Original Coordinates', 'PASTEORIG', { icon: 'paste' }),
          M('Paste Special...', 'PASTESPECIAL'),
          S,
          M('Delete', 'ERASE', { key: 'Del', icon: 'delete' }),
          M('Select All', 'SELECTALL', { key: 'Ctrl+A', icon: 'selall' }),
          S,
          {
            label: 'Show and Hide',
            sub: [
              M('Hide Objects', 'HIDEOBJECTS', { key: 'Ctrl+B' }),
              M('Swap Hidden and Shown', 'SWAPHIDDEN', { key: 'Ctrl+Shift+B' }),
              M('Show All', 'SHOWALLOBJECTS', { key: 'Ctrl+Shift+U' }),
            ],
          },
          S,
          M('Hyperlinks...', 'HYPERLINK'),
          S,
          M('Find...', 'FIND', { icon: 'find' }),
        ],
      ],
      [
        'View',
        () => [
          M('Redraw', 'REDRAW'),
          M('Regen', 'REGEN'),
          M('Regen All', 'REGENALL'),
          S,
          {
            label: 'Zoom',
            sub: [
              M('Realtime', 'ZOOM', { arg: '' }),
              M('Previous', 'ZOOM', { arg: 'Previous' }),
              M('Window', 'ZOOM', { arg: 'Window' }),
              M('Dynamic', 'ZOOM', { arg: 'Dynamic' }),
              M('Scale', 'ZOOM', { arg: 'Scale' }),
              M('Center', 'ZOOM', { arg: 'Center' }),
              M('Object', 'ZOOM', { arg: 'Object' }),
              S,
              M('In', 'ZOOM', { arg: 'In' }),
              M('Out', 'ZOOM', { arg: 'Out' }),
              S,
              M('All', 'ZOOM', { arg: 'All' }),
              M('Extents', 'ZOOM', { arg: 'Extents', icon: 'zoomext' }),
            ],
          },
          M('Pan', 'PAN', { icon: 'pan' }),
          M('3D Orbit', '3DORBIT', { icon: 'orbit' }),
          S,
          {
            label: '3D Views',
            feature: '3d',
            sub: [
              ...VIEW_ITEMS.map(([k, t]) => ({ label: t, run: () => app.setPreset3D(k) })),
              S,
              M('Plan View', 'PLAN'),
              S,
              M('Viewpoint...', 'VPOINT'),
              M('Perspective', 'PERSPECTIVE'),
              M('Parallel', 'PARALLEL'),
            ],
          },
          {
            label: 'Visual Styles',
            feature: '3d',
            sub: VSTYLES.map(([k, t]) => ({
              label: t,
              icon: {
                '2dwireframe': 'vs2d',
                wireframe: 'vswire',
                hidden: 'vshidden',
                conceptual: 'vsconcept',
                shaded: 'vsshaded',
                shadedEdges: 'vsshaded',
                xray: 'vsxray',
              }[k],
              check: () => (app.settings.vstyle || '2dwireframe') === k,
              run: () => app.setVisualStyle(k),
            })),
          },
          S,
          M('Studio (Scene and Material)...', 'STUDIO'),
          {
            label: 'Viewports',
            sub: [
              M('1 Viewport', 'MVIEW', { arg: 'Fit' }),
              M('2 Viewports', 'MVIEW', { arg: '2' }),
              M('3 Viewports', 'MVIEW', { arg: '3' }),
              M('4 Viewports', 'MVIEW', { arg: '4' }),
            ],
          },
          S,
          {
            label: 'Display',
            sub: [
              {
                label: 'Clean Screen',
                key: 'Ctrl+0',
                check: () => app.settings.cleanScreen,
                run: () => app.toggle('cleanScreen'),
              },
              {
                label: 'UCS Icon',
                check: () => app.settings.ucsIcon,
                run: () => app.toggle('ucsIcon'),
              },
              { label: 'Grid', check: () => app.settings.grid, run: () => app.toggle('grid') },
            ],
          },
          M('Model History', 'HISTORY', { icon: 'history' }),
          M('Toolbars...', 'TOOLBAR'),
          M('Named Views...', 'VIEW'),
          M('Text Window', 'TEXTSCR', { key: 'F2' }),
          M('Properties', 'PROPERTIES', { key: 'Ctrl+1', icon: 'props' }),
        ],
      ],
      [
        'Insert',
        () => [
          M('Block...', 'INSERT', { icon: 'insert' }),
          M('DWG Reference (Xref)...', 'XREF'),
          S,
          {
            label: 'Layout',
            sub: [
              M('New Layout', 'LAYOUT'),
              M('Layout from Template...', 'LAYOUTTEMPLATE'),
            ],
          },
        ],
      ],
      [
        'Format',
        () => [
          M('Layer...', 'LAYER', { icon: 'layermgr' }),
          M('Color...', 'COLOR'),
          M('Linetype...', 'LINETYPE'),
          M('Lineweight...', 'LWEIGHT'),
          M('LTscale...', 'LTSCALE'),
          S,
          M('Text Style...', 'STYLE', { icon: 'style' }),
          M('Dimension Style...', 'DIMSTYLE', { icon: 'dimstyle' }),
          M('Point Style...', 'DDPTYPE'),
          S,
          M('Units...', 'UNITS', { icon: 'units' }),
          M('Drawing Limits', 'LIMITS'),
          M('Rename...', 'RENAME'),
        ],
      ],
      [
        'Tools',
        () => [
          M('Quick Select...', 'QSELECT'),
          M('Calculator', 'QUICKCALC'),
          M('AI Assistant (local model)...', 'AI'),
          M('Clean Up Drawing...', 'CLEANUP'),
          S,
          {
            label: 'AutoLISP',
            sub: [
              M('Load Application...', 'APPLOAD'),
              M('Visual LISP Editor', 'VLIDE'),
              M('Run Script...', 'SCRIPT'),
            ],
          },
          {
            label: 'Customize',
            sub: [M('Edit Command Aliases...', 'ALIASEDIT'), M('Toolbars...', 'TOOLBAR')],
          },
          S,
          {
            label: 'Inquiry',
            sub: [
              M('Distance', 'DIST', { icon: 'dist' }),
              M('Area', 'AREA', { icon: 'area' }),
              M('List', 'LIST', { icon: 'list' }),
              M('ID Point', 'ID'),
              M('Status', 'STATUS'),
            ],
          },
          {
            label: 'Draw Order',
            sub: [M('Bring to Front', 'DRAWORDER'), M('Send to Back', 'DRAWORDER')],
          },
          S,

        ],
      ],
      [
        'Settings',
        () => [M('Settings…', 'OPTIONS', { key: 'Ctrl+,' }), M('Drafting Settings…', 'DSETTINGS'), M('Command Aliases…', 'ALIASEDIT'), M('AI Settings…', 'AISETTINGS'), M('Subscription / Licence…', 'LICENSE')],
      ],
      [
        'Draw',
        () => [
          M('Line', 'LINE', { icon: 'line' }),
          M('Ray', 'RAY', { icon: 'ray' }),
          M('Construction Line', 'XLINE', { icon: 'xline' }),
          M('Multiline', 'MLINE'),
          M('Polyline', 'PLINE', { icon: 'pline' }),
          M('Polygon', 'POLYGON', { icon: 'polygon' }),
          M('Rectangle', 'RECTANG', { icon: 'rect' }),
          { label: 'Arc', icon: 'arc', sub: arcSub.map(([l, c, a]) => M(l, c, { arg: a })) },
          {
            label: 'Circle',
            icon: 'circle',
            sub: [
              M('Center, Radius', 'CIRCLE'),
              M('2 Points', 'CIRCLE', { arg: '2p' }),
              M('3 Points', 'CIRCLE', { arg: '3p' }),
              M('Tan, Tan, Radius', 'CIRCLE', { arg: 'ttr' }),
            ],
          },
          M('Donut', 'DONUT'),
          M('Spline', 'SPLINE', { icon: 'spline' }),
          {
            label: 'Ellipse',
            icon: 'ellipse',
            sub: [
              M('Center', 'ELLIPSE', { arg: 'center' }),
              M('Axis, End', 'ELLIPSE'),
              M('Arc', 'ELLIPSE', { arg: 'arc' }),
            ],
          },
          S,
          {
            label: 'Block',
            sub: [M('Make...', 'BLOCK', { icon: 'block' }), M('Define Attributes...', 'ATTDEF')],
          },
          {
            label: 'Point',
            sub: [
              M('Single Point', 'POINT', { arg: 'single' }),
              M('Multiple Point', 'POINT', { icon: 'point' }),
              S,
              M('Divide', 'DIVIDE'),
              M('Measure', 'MEASURE'),
            ],
          },
          M('Hatch...', 'HATCH', { icon: 'hatch' }),
          M('Region', 'REGION'),
          {
            label: 'Modeling',
            sub: [
              M('Box', 'BOX', { icon: 'box' }),
              M('Wedge', 'WEDGE', { icon: 'wedge' }),
              M('Cone', 'CONE', { icon: 'cone' }),
              M('Sphere', 'SPHERE', { icon: 'sphere' }),
              M('Cylinder', 'CYLINDER', { icon: 'cylinder' }),
              M('Torus', 'TORUS', { icon: 'torus' }),
              M('Pyramid', 'PYRAMID', { icon: 'pyramid' }),
              S,
              M('Extrude', 'EXTRUDE', { icon: 'extrude' }),
              M('Revolve', 'REVOLVE', { icon: 'revolve' }),
              M('Slice', 'SLICE', { icon: 'slice' }),
              S,
              M('Union', 'UNION', { icon: 'union' }),
              M('Subtract', 'SUBTRACT', { icon: 'subtract' }),
              M('Intersect', 'INTERSECT', { icon: 'intersect' }),
              M('Interference', 'INTERFERE', { icon: 'interfere' }),
            ],
          },
          M('Table...', 'TABLE', { icon: 'table' }),
          {
            label: 'Text',
            sub: [
              M('Multiline Text...', 'MTEXT', { icon: 'mtext' }),
              M('Single Line Text', 'TEXT'),
            ],
          },
          M('Revision Cloud', 'REVCLOUD', { icon: 'revcloud' }),
        ],
      ],
      [
        'Dimension',
        () => [
          M('Linear', 'DIMLINEAR', { icon: 'dimlinear' }),
          M('Aligned', 'DIMALIGNED', { icon: 'dimaligned' }),
          M('Ordinate', 'DIMORDINATE'),
          M('Radius', 'DIMRADIUS', { icon: 'dimradius' }),
          M('Diameter', 'DIMDIAMETER', { icon: 'dimdiameter' }),
          M('Angular', 'DIMANGULAR', { icon: 'dimangular' }),
          M('Quick Dimension', 'QDIM'),
          S,
          M('Baseline', 'DIMBASELINE', { icon: 'dimbaseline' }),
          M('Continue', 'DIMCONTINUE', { icon: 'dimcontinue' }),
          S,
          M('Leader', 'LEADER', { icon: 'leader' }),
          M('Multileader', 'MLEADER'),
          M('Tolerance...', 'TOLERANCE'),
          S,
          M('Dimension Style...', 'DIMSTYLE', { icon: 'dimstyle' }),
        ],
      ],
      [
        'Modify',
        () => [
          M('Properties', 'PROPERTIES', { icon: 'props' }),
          M('Match Properties', 'MATCHPROP', { icon: 'matchprop' }),
          S,
          M('Erase', 'ERASE', { icon: 'erase' }),
          M('Copy', 'COPY', { icon: 'copy' }),
          M('Mirror', 'MIRROR', { icon: 'mirror' }),
          M('Offset', 'OFFSET', { icon: 'offset' }),
          M('Array...', 'ARRAY', { icon: 'array' }),
          M('Move', 'MOVE', { icon: 'move' }),
          M('Rotate', 'ROTATE', { icon: 'rotate' }),
          M('Scale', 'SCALE', { icon: 'scale' }),
          M('Stretch', 'STRETCH', { icon: 'stretch' }),
          M('Lengthen', 'LENGTHEN', { icon: 'lengthen' }),
          M('Trim', 'TRIM', { icon: 'trim' }),
          M('Extend', 'EXTEND', { icon: 'extend' }),
          M('Break', 'BREAK', { icon: 'break' }),
          M('Join', 'JOIN', { icon: 'join' }),
          M('Chamfer', 'CHAMFER', { icon: 'chamfer' }),
          M('Fillet', 'FILLET', { icon: 'fillet' }),
          S,
          {
            label: 'Solids Editing',
            sub: [
              M('Fillet Edge', 'FILLETEDGE', { icon: 'filletedge' }),
              M('Chamfer Edge', 'CHAMFEREDGE', { icon: 'chamferedge' }),
              S,
              M('Union', 'UNION', { icon: 'union' }),
              M('Subtract', 'SUBTRACT', { icon: 'subtract' }),
              M('Intersect', 'INTERSECT', { icon: 'intersect' }),
              S,
              M('Slice', 'SLICE', { icon: 'slice' }),
            ],
          },
          M('Flatshot (3D view to 2D)', 'FLATSHOT'),
          {
            label: '3D Operation',
            sub: [
              M('3D Move', '3DMOVE', { icon: 'move3d' }),
              M('3D Rotate', 'ROTATE3D', { icon: 'rotate3d' }),
              M('3D Mirror', '3DMIRROR', { icon: 'mirror3d' }),
              M('3D Array', '3DARRAY'),
            ],
          },
          M('Edit Polyline', 'PEDIT'),
          M('Edit Text...', 'DDEDIT'),
          M('Explode', 'EXPLODE', { icon: 'explode' }),
        ],
      ],
      [
        'Express',
        () => [
          {
            label: 'Layer Tools',
            sub: [
              M('Layer Isolate', 'LAYISO', { icon: 'layeriso' }),
              M('Layer Unisolate', 'LAYUNISO'),
              M('Layer Off', 'LAYOFF'),
              M('Turn All Layers On', 'LAYON'),
              M('Layer Freeze', 'LAYFRZ'),
              M('Thaw All Layers', 'LAYTHW'),
              M('Layer Lock', 'LAYLCK'),
              M('Layer Unlock', 'LAYULK'),
              M("Make Object's Layer Current", 'LAYMCUR'),
            ],
          },
          {
            label: 'Tools',
            sub: [M('Draw Order...', 'DRAWORDER'), M('Divide', 'DIVIDE'), M('Measure', 'MEASURE')],
          },
        ],
      ],
      [
        'Window',
        () => [
          M('Next Drawing', null, {
            key: 'Ctrl+Shift+]',
            run: () => app.nextTab(1),
            disabled: app.tabs.length < 2,
          }),
          M('Previous Drawing', null, {
            key: 'Ctrl+Shift+[',
            run: () => app.nextTab(-1),
            disabled: app.tabs.length < 2,
          }),
          M('Close All Drawings', null, { run: () => app.exec('CLOSEALL') }),
          S,
          ...app.tabs.map((t, i) => ({
            label: `${i + 1} ${t.doc.name}${t.doc.dirty ? ' *' : ''}`,
            check: () => i === app.tabIndex,
            run: () => app.activateTab(i),
          })),
        ],
      ],
      [
        'Help',
        () => [
          M('User Guide', null, { run: () => dialogs.manualDialog('guide'), icon: 'help' }),
          M('User Guide (English)', null, { run: () => dialogs.manualDialog('guide_en') }),
          M('Command Reference', null, { run: () => dialogs.manualDialog('commands') }),
          M('AI Assistant Guide', null, { run: () => dialogs.manualDialog('ai') }),
          M('Third-Party Notices and Licence', null, {
            run: () => dialogs.manualDialog('notices'),
          }),
          M('Keyboard Shortcuts and Aliases', 'HELP', { key: 'F1' }),
          S,
          M('3D Sample: Drafted Box with Hole', 'DRAFTDEMO'),
          M('Load Application... (APPLOAD)', 'APPLOAD'),
          M('Visual LISP Editor (VLIDE)', 'VLIDE'),
          S,
          M('Licence and Trial...', 'LICENSE'),
          M('About MacCAD 2027...', 'ABOUT'),
        ],
      ],
    ];
    return menus.map(([label, items]) => [label, () => availableMenuItems(items())]);
  }
}

/* ============================================================================================
 * 4. MAINWINDOW
 * ========================================================================================== */

/**
 * The main window: title bar, menu bar, toolbars, drawing area with scroll bars, layout tabs, command line, status bar. The window is built once; after that the parts update themselves from application events.
 */
export class MainWindow {
  /** @param {object} app the application */
  constructor(app) {
    this.app = app;
  }

  /** Builds the window in the order the parts appear on screen, then connects the input handlers. @returns the `ui` object */
  build() {
    this.buildRoot();
    this.buildTitleBar();
    this.buildMenuBar();
    this.buildToolbars();
    this.buildMainArea();
    this.buildHistoryPanel();
    this.buildCommandLine();
    this.buildStatusBar();
    this.wireCommandLine();
    this.wireCanvasInput();
    this.wireCanvasEditing();
    this.buildLayoutTabs();
    this.buildDrawingTabs();
    this.wireStatusSync();
    this.wireProperties();
    this.wireScrollbars();
    this.wireChrome();
    this.wireViewSizing();
    this.wireGlobalInput();
    return this.ui;
  }

  /** @private Clears #app and creates the `ui` object. */
  buildRoot() {
    const { app } = this;

    const root = $('#app');
    this.root = root;

    root.innerHTML = '';

    const ui = { app, io, ...dialogs, dialog };
    this.ui = ui;

    app.ui = ui;
  }

  /** @private Title bar: the native macOS traffic lights, or window buttons on other systems. */
  buildTitleBar() {
    const { root } = this;

    // title bar
    const winbtn = (cls, act) =>
      h(
        'button',
        { class: cls, title: act, onclick: () => (window.api ? window.api.win(act) : null) },
        h('i'),
      );

    // macOS: the window keeps its native traffic lights (close / minimize / zoom) at the left; the web preview draws look-alikes
    const mac = !window.api || window.api.platform === 'darwin';

    document.body.dataset.platform = mac ? 'darwin' : 'other';

    const traffic = !window.api
      ? h(
          'div',
          { class: 'traffic' },
          h('i', { class: 'c', title: 'Close' }),
          h('i', { class: 'm', title: 'Minimize' }),
          h('i', { class: 'z', title: 'Zoom' }),
        )
      : null;

    root.append(
      h(
        'div',
        { id: 'titlebar', class: mac ? 'mac' : '' },
        traffic,
        h('span', { class: 'logo', html: ICONS.acad }),
        h('span', { id: 'title-text' }),
        h(
          'div',
          { class: 'winbtns' },
          winbtn('min', 'minimize'),
          winbtn('max', 'maximize'),
          winbtn('close', 'close'),
        ),
      ),
    );
  }

  /** @private Menu bar: pull-down menus, and the native macOS menu bar when running in Electron. */
  buildMenuBar() {
    const { root, app } = this;

    // menu bar
    const menubar = h('div', { id: 'menubar' });

    const menus = MenuModel.build(app);

    let openIdx = -1;

    const showMenu = (i, el) => {
      closePopups();
      openIdx = i;
      menubar.querySelectorAll('.mi').forEach((m, j) => m.classList.toggle('open', j === i));
      const r = el.getBoundingClientRect();
      popupMenu(menus[i][1](), r.left, r.bottom - 1, {
        onClose: () => {
          openIdx = -1;
          menubar.querySelectorAll('.mi').forEach((m) => m.classList.remove('open'));
        },
        run: runItem,
      });
    };

    const runItem = (it) => {
      if (it.run) it.run();
      else if (it.cmd) app.exec(it.cmd, it.arg ? it.arg : undefined);
    };
    this.runItem = runItem;

    // ---- native macOS menu bar (Electron): the structure goes to the main process, which builds the real menu; clicks come back as ids
    const nativeMenu = !!(window.api && window.api.setMenu && window.api.platform === 'darwin');

    const menuMap = new Map();
    let menuSent = '';
    let menuTimer = 0;
    this.menuMap = menuMap;

    const serializeMenu = (list, ctr) =>
      list.map((it) => {
        if (it.sep) return { type: 'separator' };
        const id = ++ctr.n;
        menuMap.set(id, it);
        const o = {
          id,
          label: it.label,
          disabled: !!it.disabled || (!it.cmd && !it.run && !it.sub),
        };
        if (it.key) o.key = it.key;
        if (it.check) o.checked = !!it.check();
        if (it.sub) o.sub = serializeMenu(it.sub, ctr);
        return o;
      });

    const pushMenu = () => {
      menuMap.clear();
      const ctr = { n: 0 };
      const tree = menus.map(([label, fn]) => ({ label, items: serializeMenu(fn(), ctr) }));
      const json = JSON.stringify(tree);
      if (json !== menuSent) {
        menuSent = json;
        window.api.setMenu(tree);
      }
    };

    if (nativeMenu) {
      document.body.dataset.nativeMenu = '1';
      const later = () => {
        clearTimeout(menuTimer);
        menuTimer = setTimeout(pushMenu, 250);
      };
      for (const ev of ['doc', 'settings', 'selection', 'space', 'view3d', 'tabs'])
        app.on(ev, later);
      pushMenu();
    }

    menus.forEach(([label], i) => {
      const el = h('div', { class: 'mi' }, label);
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (openIdx === i) closePopups();
        else showMenu(i, el);
      });
      el.addEventListener('mouseenter', () => {
        if (openIdx >= 0 && openIdx !== i) showMenu(i, el);
      });
      menubar.append(el);
    });

    menubar.append(
      h(
        'div',
        { class: 'docbtns' },
        h('button', { title: 'Minimize', html: '&#8211;' }),
        h('button', { title: 'Restore', html: '&#9633;' }),
        h('button', { title: 'Close', html: '&times;', onclick: () => app.exec('CLOSE') }),
      ),
    );

    root.append(menubar);
  }

  /** @private Toolbar rows: standard, styles, layer / colour / linetype / lineweight controls, 3D toolbar. */
  buildToolbars() {
    const { root, app } = this;

    // toolbar rows
    const row1 = h('div', { class: 'trow', id: 'row1' });
    const row2 = h('div', { class: 'trow', id: 'row2' });

    row1.append(ToolbarBuilder.group(app, TB_STANDARD));

    const mkSel = (id, w) => h('select', { class: 'cb', id, style: `width:${w}px` });

    const styleSel = mkSel('cb-textstyle', 110);
    const dimSel = mkSel('cb-dimstyle', 110);
    this.styleSel = styleSel;
    this.dimSel = dimSel;

    row1.append(
      h(
        'div',
        { class: 'tbgroup' },
        h('button', {
          class: 'tb',
          title: 'Text Style...',
          html: ICONS.style,
          onclick: () => app.exec('STYLE'),
        }),
        styleSel,
        h('button', {
          class: 'tb',
          title: 'Dimension Style...',
          html: ICONS.dimstyle,
          onclick: () => app.exec('DIMSTYLE'),
        }),
        dimSel,
      ),
    );

    const layerSel = mkSel('cb-layer', 190);
    const colorSel = mkSel('cb-color', 110);
    // the colour list is a popup that shows the real colours (a native menu draws every "■" in the text colour)
    colorSel.addEventListener('mousedown', (e) => e.preventDefault()); // no native menu
    colorSel.addEventListener('click', () => {
      const r = colorSel.getBoundingClientRect();
      const swatchOf = (v) => {
        if (v === 'bylayer' || v === 'byblock') return 'linear-gradient(135deg,#fff 50%,#222 50%)';
        if (v === 'varies' || v === 'select') return 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)';
        const c = isNaN(+v) ? v : +v;
        return aciHex(c === 7 ? '#ffffff' : c);
      };
      const items = [...colorSel.options].map((o) => ({
        label: o.textContent.replace(/^■\s*/, ''),
        swatch: swatchOf(o.value),
        check: () => colorSel.value === o.value,
        value: o.value,
      }));
      popupMenu(items, r.left, r.bottom, {
        run: (it) => {
          colorSel.value = it.value;
          colorSel.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
    });
    const ltSel = mkSel('cb-ltype', 150);
    const lwSel = mkSel('cb-lw', 110);
    this.layerSel = layerSel;
    this.colorSel = colorSel;
    this.ltSel = ltSel;
    this.lwSel = lwSel;

    const lyrState = h(
      'div',
      { class: 'tbgroup' },
      h('button', {
        class: 'tb',
        title: 'Layer Properties Manager',
        html: ICONS.layermgr,
        onclick: () => app.exec('LAYER'),
      }),
      h('button', { class: 'tb', title: 'Toggle layer on/off', id: 'lyr-on', html: ICONS.bulb }),
      h('button', { class: 'tb', title: 'Freeze/Thaw', id: 'lyr-frz', html: ICONS.sun }),
      h('button', { class: 'tb', title: 'Lock/Unlock', id: 'lyr-lck', html: ICONS.unlock }),
      h('span', { class: 'swatch', id: 'lyr-sw', style: 'margin-left:4px' }),
      layerSel,
    );

    row2.append(lyrState, h('div', { class: 'tbgroup' }, colorSel, ltSel, lwSel));

    const row3 = HAS_3D ? h('div', { class: 'trow', id: 'row3' }) : null;

    const vsSel = mkSel('cb-vstyle', 130);
    const vwSel = mkSel('cb-view3d', 130);
    this.vsSel = vsSel;
    this.vwSel = vwSel;

    vsSel.title = 'Visual Style';

    vwSel.title = '3D View';

    for (const [k, t] of VSTYLES) vsSel.append(h('option', { value: k }, t));

    vwSel.append(h('option', { value: '' }, 'Custom View'));

    for (const [k, t] of VIEW_ITEMS) vwSel.append(h('option', { value: k }, t));

    if (row3) row3.append(
      ToolbarBuilder.group(app, TB_SOLIDS),
      h(
        'div',
        { class: 'tbgroup' },
        h('button', { class: 'tb', title: 'Visual Styles', html: ICONS.vshidden }),
        vsSel,
        h('button', { class: 'tb', title: '3D Views', html: ICONS.orbit }),
        vwSel,
      ),
    );

    root.append(h('div', { id: 'toolrows' }, row1, row2, ...(row3 ? [row3] : [])));
  }

  /** @private Main area: side toolbars, the drawing canvas (2D and WebGL), scroll bars, layout tabs, drawing tabs and the properties panel. */
  buildMainArea() {
    const { root, app } = this;

    // main area
    const left = h('div', { class: 'vtb', id: 'tb-left' }, ToolbarBuilder.group(app, TB_DRAW));
    this.left = left;

    const right = h(
      'div',
      { class: 'vtb dbl', id: 'tb-right' },
      h('div', { class: 'vcol' }, ToolbarBuilder.group(app, TB_DIM)),
      h('div', { class: 'vcol' }, ToolbarBuilder.group(app, TB_MODIFY)),
    );

    const canvas = app.renderer.cv;
    this.canvas = canvas;

    canvas.id = 'cv';

    canvas.tabIndex = 0;

    const glCanvas = h('canvas', { id: 'gl' });
    this.glCanvas = glCanvas;

    const hidBadge = h('div', {
      id: 'hidbadge',
      class: 'hidden',
      title: 'Click to swap hidden and shown (Cmd+Shift+B). Cmd+Shift+U shows all.',
      onclick: () => app.exec('SWAPHIDDEN'),
    });
    this.hidBadge = hidBadge;

    const viewarea = h(
      'div',
      { id: 'viewarea' },
      glCanvas,
      canvas,
      h('div', { id: 'dyn' }),
      hidBadge,
    );
    this.viewarea = viewarea;

    const vscroll = h('div', { id: 'vscroll' }, h('div', { class: 'sthumb' }));
    this.vscroll = vscroll;

    const tabs = h('div', { id: 'tabs' });
    const hscroll = h('div', { id: 'hscroll' }, h('div', { class: 'sthumb' }));
    this.tabs = tabs;
    this.hscroll = hscroll;

    const props = h('div', { id: 'props', class: 'hidden' });
    this.props = props;

    const doctabs = h('div', { id: 'doctabs' });
    this.doctabs = doctabs;

    const center = h(
      'div',
      { id: 'center' },
      doctabs,
      h('div', { id: 'centerrow' }, props, viewarea, vscroll),
      h('div', { id: 'hrow' }, tabs, hscroll, h('div', { style: 'width:17px;flex:none' })),
    );

    root.append(h('div', { id: 'main' }, left, center, right));
  }

  /** @private Model History (left of the drawing area): modelling steps with roll-back. */
  buildHistoryPanel() {
    const { app, ui, viewarea } = this;

    // Model History (left of the drawing area): modelling steps with roll-back, layers with show / hide / isolate
    const histPanel = initHistory(app, h, $('#centerrow'), viewarea);

    let histTouched = false;

    ui.showHistory = (on) => {
      histTouched = true;
      histPanel.show(on);
    };

    ui.toggleHistory = () => {
      histTouched = true;
      histPanel.toggle();
    };

    app.on('view3d', () => {
      if (app.v3 && !histTouched) histPanel.show(true);
    });
  }

  /** @private Command line: history, prompt and input box, and the text window. */
  buildCommandLine() {
    const { root } = this;
    // opens by itself the first time a 3D view is used

    // command line
    const hist = h('div', { id: 'cmdhist' });
    const prompt = h('span', { id: 'cmdprompt' }, 'Command: ');
    const input = h('input', { id: 'cmdinput', autocomplete: 'off', spellcheck: 'false' });
    this.hist = hist;
    this.prompt = prompt;
    this.input = input;

    const textwin = h(
      'div',
      { id: 'textwin', class: 'hidden' },
      h(
        'div',
        { class: 'th' },
        'MacCAD Text Window',
        h('b', { onclick: () => this.showText(false) }, '×'),
      ),
      h('pre'),
    );
    this.textwin = textwin;

    root.append(h('div', { id: 'cmd' }, hist, h('div', { id: 'cmdin' }, prompt, input), textwin));
  }

  /** @private Status bar: coordinates, mode buttons (snap, grid, ortho, polar, osnap, otrack, dyn, lwt), licence badge. */
  buildStatusBar() {
    const { root, app } = this;

    // status bar
    const coords = h('div', { id: 'coords' }, '0.0000, 0.0000, 0.0000');
    this.coords = coords;

    const FKEY = {
      snap: 'F9',
      grid: 'F7',
      ortho: 'F8',
      polar: 'F10',
      osnap: 'F3',
      otrack: 'F11',
      dyn: 'F12',
    };

    const sbtn = (label, key, cmd) => {
      const b = h(
        'button',
        { class: 'sb', title: FKEY[key] ? `${label} (${macKeys(FKEY[key])})` : label },
        label,
      );
      b.dataset.key = key || '';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => (cmd ? cmd() : app.toggle(key)));
      return b;
    };

    const modeBtn = sbtn('MODEL', '', () => {
      if (app.space === 'model') {
        const names = Object.keys(app.doc.layouts);
        app.switchSpace(names[0]);
      } else if (app.mspace) {
        app.mspace = null;
        app.emit('space');
        app.redraw();
      } else app.exec('MSPACE');
    });
    this.modeBtn = modeBtn;

    modeBtn.classList.add('mode');

    const sbs = [
      sbtn('SNAP', 'snap'),
      sbtn('GRID', 'grid'),
      sbtn('ORTHO', 'ortho'),
      sbtn('POLAR', 'polar'),
      sbtn('OSNAP', 'osnap'),
      sbtn('OTRACK', 'otrack'),
      sbtn('DYN', 'dyn'),
      sbtn('LWT', 'lwt'),
      modeBtn,
    ];
    this.sbs = sbs;

    sbs.forEach((b) => {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (
          b.dataset.key &&
          ['snap', 'grid', 'polar', 'osnap', 'otrack', 'dyn'].includes(b.dataset.key)
        )
          app.exec('DSETTINGS');
      });
    });

    const licBadge = h('button', {
      id: 'licbadge',
      class: 'hidden',
      title: 'Trial and licence (LICENSE)',
      onclick: () => app.exec('LICENSE'),
    });

    root.append(
      h(
        'div',
        { id: 'status' },
        coords,
        ...sbs,
        h('div', { class: 'spacer' }),
        licBadge,
        h('span', { class: 'ico', html: ICONS.lock, title: 'Toolbar/Window positions' }),
      ),
    );

    const syncLicense = () => {
      const b = license.badge();
      licBadge.classList.toggle('hidden', !b);
      licBadge.className = b ? `lv-${b.level}` : 'hidden';
      licBadge.textContent = b ? b.text : '';
    };

    license.on(syncLicense);
  }

  /** @private Command line behaviour: echo lines, prompt, text window, history keys, typing. */
  wireCommandLine() {
    const { app, ui, hist, prompt, input, textwin } = this;

    const historyIdx = { i: 0 };

    const MAXLINES = 400;

    const addLine = (text) => {
      for (const ln of String(text).split('\n')) {
        hist.append(h('div', {}, ln));
      }
      while (hist.children.length > MAXLINES) hist.firstChild.remove();
      const pre = $('pre', textwin);
      pre.textContent += String(text) + '\n';
      pre.scrollTop = pre.scrollHeight;
    };

    app.on('echo', addLine);

    app.on('prompt', (p) => {
      prompt.textContent = p.includes('\n') ? p.split('\n').pop() : p;
      if (p.includes('\n')) p.split('\n').slice(0, -1).forEach(addLine);
    });

    addLine('MacCAD 2027 (AutoCAD-style 2D drafting for macOS)');

    addLine('Regenerating model.');

    const showText = (on) => {
      textwin.classList.toggle('hidden', !on);
      if (on) {
        const pre = $('pre', textwin);
        pre.scrollTop = pre.scrollHeight;
      }
    };
    this.showText = showText;

    ui.showTextWindow = showText;

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = input.value;
        input.value = '';
        app.submit(v);
        e.preventDefault();
        historyIdx.i = app.cmdHistory.length;
        return;
      }
      // Space ends the command like Enter, except inside a LISP expression that is still open (AutoCAD keeps typing there): "(+ 1 2)" must not be sent at the first space
      const lispOpen = (t) => {
        if (!/^\s*[(!]/.test(t) || t.trim()[0] === '!') return false;
        let d = 0;
        let str = false;
        for (let i = 0; i < t.length; i += 1) {
          const c = t[i];
          if (str) {
            if (c === '\\') i += 1;
            else if (c === '"') str = false;
          } else if (c === '"') str = true;
          else if (c === ';') break;
          else if (c === '(') d += 1;
          else if (c === ')') d -= 1;
        }
        return d > 0 || str;
      };
      if (
        e.key === ' ' &&
        !(app.req && app.req.type === 'string') &&
        !input.value.includes(' ') &&
        !lispOpen(input.value)
      ) {
        const v = input.value;
        input.value = '';
        app.submit(v);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (historyIdx.i > 0) {
          historyIdx.i -= 1;
          input.value = app.cmdHistory[historyIdx.i] || '';
        }
        e.preventDefault();
      }
      if (e.key === 'ArrowDown') {
        if (historyIdx.i < app.cmdHistory.length) {
          historyIdx.i += 1;
          input.value = app.cmdHistory[historyIdx.i] || '';
        }
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        input.value = '';
        app.cancelReq();
        e.preventDefault();
      }
      // Cmd/Ctrl shortcuts (Undo, Save, ...) and F-keys must still reach the window handler while the command line has focus
      if (!(e.ctrlKey || e.metaKey || /^F\d+$/.test(e.key))) e.stopPropagation();
    });
  }

  /** @private Mouse input on the drawing canvas: press, move, release, wheel, context menu. */
  wireCanvasInput() {
    const { app, canvas, input } = this;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    let panning = null;

    canvas.addEventListener('mousedown', (e) => {
      closePopups();
      const p = pos(e);
      if (e.button === 1) {
        panning = { x: p.x, y: p.y, orbit: !!app.v3 && e.shiftKey };
        e.preventDefault();
        if (e.detail === 2) app.zoomExtents();
        return;
      }
      if (e.button === 0) {
        if (e.detail === 2 && !app.req) {
          e.preventDefault();
          app.grabPress();
          this.dblClick(p);
          return;
        } // preventDefault: the browser would otherwise move the focus to the canvas and close the edit box that dblClick has just opened
        app.mouseDown(p.x, p.y, 0, e.shiftKey);
      }
      input.focus();
    });

    window.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (panning) {
        if (panning.orbit) app.orbitBy(p.x - panning.x, p.y - panning.y);
        else app.panBy(p.x - panning.x, p.y - panning.y);
        panning = { x: p.x, y: p.y, orbit: panning.orbit };
        app.updateCursor(p.x, p.y, e.shiftKey);
        return;
      }
      if (e.target === canvas || app.selDrag || app.rtDrag) app.mouseMove(p.x, p.y, e.shiftKey);
    });

    canvas.addEventListener('mouseenter', () => {
      app.mouseIn = true;
    });

    canvas.addEventListener('mouseleave', () => {
      app.mouseIn = false;
      app.dyn = null;
      app.emit('dyn');
      app.redraw();
    });

    window.addEventListener('mouseup', (e) => {
      const p = pos(e);
      if (e.button === 1) panning = null;
      else app.mouseUp(p.x, p.y, e.button);
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = pos(e);
        const mouse =
          e.deltaMode === 1 ||
          (Math.abs(e.deltaY) >= 50 && e.deltaX === 0 && Number.isInteger(e.deltaY)) ||
          (e.shiftKey && Math.abs(e.deltaX) >= 50 && e.deltaY === 0 && Number.isInteger(e.deltaX)); // a notched wheel; Shift makes macOS report it sideways
        // Cmd + wheel (or two fingers on the trackpad): turn the model. Up / down tilts, left / right turns round; with a plain mouse wheel hold Shift as well to turn round.
        if (e.metaKey && !e.ctrlKey) {
          app.wheelOrbit(e.deltaX, e.deltaY, mouse, e.shiftKey);
          return;
        }
        if (e.ctrlKey) app.wheel(p.x, p.y, -e.deltaY);
        else if (e.altKey) {
          // Option + wheel (or two fingers): pan
          app.panBy(-e.deltaX, -e.deltaY);
          app.updateCursor(p.x, p.y, e.shiftKey);
        } else {
          // the plain wheel zooms in and out around the cursor, for a notched wheel and for a trackpad alike
          app.wheel(p.x, p.y, e.deltaY, mouse);
        }
      },
      { passive: false },
    );

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = pos(e);
      app.updateCursor(p.x, p.y, e.shiftKey);
      this.canvasMenu(e.clientX, e.clientY, e.shiftKey);
    });
  }

  /** @private In-place text editing, double click on objects and the context menus of the canvas. */
  wireCanvasEditing() {
    const { app, ui, viewarea, left, input } = this;

    // In-place text editing (double-click a TEXT): an edit box right on the text, same size and place. Enter or a click elsewhere applies, Esc cancels.
    // Returns the new string, null when cancelled, undefined when this view cannot show it (3D): the caller then asks on the command line.
    ui.editInPlace = (e) =>
      new Promise((resolve) => {
        if (app.v3 || app.mspace) return resolve(undefined);
        const v = app.activeViewDraw();
        const L = E.textLayout(e, app.doc);
        const it = L.items[0] || { x: 0, y: 0 };
        const fs = Math.max(11, e.h * v.zoom * FONT_K);
        const p = v.w2s(e.p);
        const left = p.x + it.x * v.zoom;
        const base = p.y - it.y * v.zoom;
        const st = L.st || {};
        const inp = h('input', {
          type: 'text',
          class: 'inplace',
          value: e.str,
          spellcheck: 'false',
        });
        const w = Math.max(
          160,
          E.measure(e.str, e.h, st) * v.zoom * (fs / (e.h * v.zoom * FONT_K || 1)) + 40,
        );
        inp.style.cssText = `left:${Math.round(left - 4)}px;top:${Math.round(base - fs * 0.95 - 2)}px;width:${Math.round(w)}px;height:${Math.round(fs * 1.25 + 4)}px;font:${fs}px ${fontStack(st.font)};${e.rot ? `transform-origin:left bottom;transform:rotate(${-(e.rot * 180) / Math.PI}deg);` : ''}`;
        let done = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          inp.remove();
          app.redraw();
          input.focus();
          resolve(val);
        };
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') {
            ev.preventDefault();
            finish(inp.value);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            finish(null);
          }
        });
        inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
        inp.addEventListener('blur', () => finish(inp.value));
        viewarea.append(inp);
        inp.focus();
        inp.select();
      });

    const ANNOT = ['text', 'mtext', 'dim', 'leader'];

    function dblClick(p) {
      const v = app.activeView();
      const w = v.s2w(p.x, p.y);
      if (app.space !== 'model') {
        const vps = app.doc.spaceList(app.space).filter((x) => x.type === 'viewport');
        const inVp = vps.find(
          (vp) =>
            app.view.s2w(p.x, p.y).x >= vp.p1.x &&
            app.view.s2w(p.x, p.y).x <= vp.p2.x &&
            app.view.s2w(p.x, p.y).y >= vp.p1.y &&
            app.view.s2w(p.x, p.y).y <= vp.p2.y,
        );
        if (app.mspace && !inVp) {
          app.mspace = null;
          app.emit('space');
          app.redraw();
          return;
        }
        if (!app.mspace && inVp) {
          app.activateViewport(inVp);
          return;
        }
      }
      let e = app.pickAt(w, v);
      if (!e || !ANNOT.includes(e.type)) {
        const t = app.pickAt(w, v, (x) => x.type === 'text' || x.type === 'mtext');
        if (t && E.distTo(t, w, app.doc) === 0) e = t;
      } // a double-click INSIDE a text's box edits the text even when a line passes through or next to it
      if (e && ANNOT.includes(e.type)) {
        app.setSel([e]);
        app.runInternal('DDEDIT', (c) => editText(c, e));
      } else if (e && e.type === 'pline') {
        app.setSel([e]);
        app.exec('PEDIT');
      }
    }
    this.dblClick = dblClick;

    function canvasMenu(x, y, shift) {
      const M = (label, run, extra = {}) => ({ label, run, ...extra });
      const S = { sep: true };
      let items = [];
      const r = app.req;
      if (r) {
        items.push(
          M('Enter', () => app.enter()),
          M('Cancel', () => app.cancelReq()),
        );
        if (r.kws.length) {
          items.push(S);
          for (const k of r.kws)
            items.push(
              M(k, () => {
                if (app.req) app.handleTyped(k);
              }),
            );
        }
        if (r.type === 'point' && shift) {
          items.push(S);
          for (const [k, l] of [
            ['end', 'Endpoint'],
            ['mid', 'Midpoint'],
            ['int', 'Intersection'],
            ['cen', 'Center'],
            ['per', 'Perpendicular'],
            ['tan', 'Tangent'],
            ['nea', 'Nearest'],
            ['qua', 'Quadrant'],
            ['nod', 'Node'],
            ['ins', 'Insertion'],
          ])
            items.push(
              M(l, () => {
                app.overrideSnap = k;
                app.echo(`${l} of`);
                app.updateCursorPoint();
              }),
            );
        }
        items.push(
          S,
          M('Pan', () => app.exec('PAN')),
          M('Zoom', () => app.exec('ZOOM')),
        );
      } else if (app.sel.size) {
        items = [
          M('Repeat ' + (app.lastCmd || ''), () => app.enter(), { disabled: !app.lastCmd }),
          S,
          M('Cut', () => app.exec('CUTCLIP')),
          M('Copy', () => app.exec('COPYCLIP')),
          M('Paste', () => app.exec('PASTECLIP')),
          S,
          M('Erase', () => app.exec('ERASE')),
          M('Move', () => app.exec('MOVE')),
          M('Copy Selection', () => app.exec('COPY')),
          M('Scale', () => app.exec('SCALE')),
          M('Rotate', () => app.exec('ROTATE')),
          S,
          M('Deselect All', () => app.clearSel()),
          M('Properties', () => app.exec('PROPERTIES')),
        ];
      } else {
        items = [
          M('Repeat ' + (app.lastCmd || ''), () => app.enter(), { disabled: !app.lastCmd }),
          S,
          M('Cut', () => app.exec('CUTCLIP')),
          M('Copy', () => app.exec('COPYCLIP')),
          M('Paste', () => app.exec('PASTECLIP')),
          M('Paste to Original Coordinates', () => app.exec('PASTEORIG')),
          S,
          M('Select All', () => app.exec('SELECTALL')),
          S,
          M('Zoom', () => app.exec('ZOOM')),
          M('Pan', () => app.exec('PAN')),
          M('Properties', () => app.exec('PROPERTIES')),
        ];
      }
      popupMenu(items, x, y, { run: (it) => it.run && it.run() });
    }
    this.canvasMenu = canvasMenu;
  }

  /** @private Layout tabs (Model, Layout1, ...) below the drawing. */
  buildLayoutTabs() {
    const { app, tabs, modeBtn } = this;

    const renderTabs = () => {
      tabs.innerHTML = '';
      const nb = (t, f) => h('button', { class: 'navb', onclick: f }, t);
      const names = ['model', ...Object.keys(app.doc.layouts)];
      tabs.append(
        nb('|◄', () => app.switchSpace(names[0])),
        nb('◄', () => app.switchSpace(names[Math.max(0, names.indexOf(app.space) - 1)])),
        nb('►', () =>
          app.switchSpace(names[Math.min(names.length - 1, names.indexOf(app.space) + 1)]),
        ),
        nb('►|', () => app.switchSpace(names[names.length - 1])),
      );
      for (const n of names) {
        const t = h(
          'div',
          { class: 'tab' + (n === app.space ? ' on' : '') + (n === 'model' ? '' : ' paper') },
          n === 'model' ? 'Model' : n,
        );
        t.addEventListener('click', () => app.switchSpace(n));
        t.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const M = (label, run, ex = {}) => ({ label, run, ...ex });
          popupMenu(
            [
              M('New Layout', () => app.exec('LAYOUT', undefined)),
              M(
                'Delete',
                () => {
                  if (n !== 'model') {
                    if (app.space === n) app.switchSpace('model');
                    if (Object.keys(app.doc.layouts).length > 1) {
                      app.runInternal('LAYOUT', async (c) => {
                        delete c.doc.layouts[n];
                        app.emit('space');
                      });
                    }
                  }
                },
                { disabled: n === 'model' },
              ),
              M('Page Setup Manager...', () => app.exec('PAGESETUP'), { disabled: n === 'model' }),
            ],
            e.clientX,
            e.clientY,
            { run: (it) => it.run() },
          );
        });
        tabs.append(t);
      }
      // [+]: one more layout (Layout3, Layout4 ...)
      const add = h('button', { class: 'navb tabadd', title: 'New layout' }, '+');
      add.addEventListener('click', () => {
        let i = Object.keys(app.doc.layouts).length + 1;
        while (app.doc.layouts[`Layout${i}`]) i += 1;
        const name = `Layout${i}`;
        app.runInternal('LAYOUT', async (c) => {
          const l = newLayout(name);
          l.ents.forEach((e) => {
            e.id = c.doc.nextId++;
          });
          c.doc.layouts[name] = l;
          app.emit('space');
        }).then(() => app.switchSpace(name));
      });
      tabs.append(add);
      modeBtn.textContent = app.space === 'model' ? 'MODEL' : app.mspace ? 'MODEL' : 'PAPER';
    };

    app.on('space', () => {
      renderTabs();
      this.syncStatus();
      this.syncProps();
    });

    renderTabs();
  }

  /** @private Drawing tabs above the drawing (one per open drawing). */
  buildDrawingTabs() {
    const { app, doctabs, input } = this;

    let tabSig = '';

    const renderDocTabs = () => {
      const sig = JSON.stringify([
        app.tabIndex,
        app.tabs.map((t) => [t.doc.name, t.doc.dirty, t.doc.path || t.doc.sourcePath || '']),
      ]);
      if (sig === tabSig) return;
      tabSig = sig;
      doctabs.textContent = '';
      app.tabs.forEach((t, i) => {
        const on = i === app.tabIndex;
        const name = `${t.doc.name}${/\.(dwg|dxf)$/i.test(t.doc.sourcePath || '') ? '' : ''}`;
        const full = t.doc.path || t.doc.sourcePath || `${t.doc.name} (not saved yet)`;
        const close = h(
          'button',
          {
            class: 'dtx',
            title: 'Close (Cmd+W)',
            onclick: (e) => {
              e.stopPropagation();
              io.closeTab(app, i);
            },
          },
          '\u00d7',
        );
        const el = h(
          'div',
          {
            class: `dtab${on ? ' on' : ''}${t.doc.dirty ? ' dirty' : ''}`,
            title: full,
            draggable: 'true',
            onmousedown: (e) => {
              if (e.button === 1) {
                e.preventDefault();
                io.closeTab(app, i);
              }
            },
            onclick: () => {
              app.activateTab(i);
              input.focus();
            },
            oncontextmenu: (e) => {
              e.preventDefault();
              tabMenu(i, e.clientX, e.clientY);
            },
            ondragstart: (e) => {
              e.dataTransfer.setData('text/x-maccad-tab', String(i));
              e.dataTransfer.effectAllowed = 'move';
            },
            ondragover: (e) => {
              if (e.dataTransfer.types.includes('text/x-maccad-tab')) {
                e.preventDefault();
                el.classList.add('over');
              }
            },
            ondragleave: () => el.classList.remove('over'),
            ondrop: (e) => {
              const from = parseInt(e.dataTransfer.getData('text/x-maccad-tab'), 10);
              el.classList.remove('over');
              if (!Number.isNaN(from)) {
                e.preventDefault();
                e.stopPropagation();
                app.moveTab(from, i);
              }
            },
          },
          h('span', { class: 'dtdot', title: 'Unsaved changes' }),
          h('span', { class: 'dtn' }, name),
          close,
        );
        doctabs.append(el);
      });
      doctabs.append(
        h(
          'button',
          { class: 'dtnew', title: 'New drawing (Cmd+N)', onclick: () => app.exec('NEW') },
          '+',
        ),
      );
    };

    const tabMenu = (i, x, y) => {
      const M = (label, run, extra = {}) => ({ label, run, ...extra });
      const S = { sep: true };
      const n = app.tabs.length;
      popupMenu(
        [
          M('Close', () => io.closeTab(app, i)),
          M(
            'Close Others',
            async () => {
              app.activateTab(i);
              for (let k = app.tabs.length - 1; k >= 0; k -= 1) {
                if (app.tabs[k].doc === app.tabs[app.tabIndex].doc) continue;
                if (!(await io.closeTab(app, k))) return;
              }
            },
            { disabled: n < 2 },
          ),
          M('Close All', () => io.closeAll(app)),
          S,
          M('Save', () => {
            app.activateTab(i);
            app.exec('SAVE');
          }),
          M('Save As...', () => {
            app.activateTab(i);
            app.exec('SAVEAS');
          }),
          S,
          M(
            'Reveal in Finder',
            () => {
              const f = app.tabs[i].doc.path || app.tabs[i].doc.sourcePath;
              if (f && window.api && window.api.reveal) window.api.reveal(f);
            },
            {
              disabled:
                !(app.tabs[i].doc.path || app.tabs[i].doc.sourcePath) ||
                !(window.api && window.api.reveal),
            },
          ),
        ],
        x,
        y,
        { run: (it) => it.run && it.run() },
      );
    };

    app.on('tabs', renderDocTabs);

    app.on('doc', renderDocTabs);

    renderDocTabs();

    doctabs.addEventListener('dblclick', (e) => {
      if (e.target === doctabs) app.exec('NEW');
    });
  }

  /** @private Keeps the status bar, the window title, the hidden-objects badge and the dynamic input tooltip up to date. */
  wireStatusSync() {
    const { app, hidBadge, viewarea, sbs, coords } = this;

    const syncStatus = () => {
      sbs.forEach((b) => {
        if (b.dataset.key) b.classList.toggle('on', !!app.settings[b.dataset.key]);
      });
    };
    this.syncStatus = syncStatus;

    app.on('settings', syncStatus);

    syncStatus();

    app.on('cursor', () => {
      const p = app.cursorW;
      const u = app.doc.units;
      coords.textContent = `${fmtLen(p.x, u)}, ${fmtLen(p.y, u)}, ${fmtLen(app.v3 ? (app.resolved && app.resolved.z) || 0 : 0, u)}`;
    });

    const syncTitle = () => {
      $('#title-text').textContent =
        `MacCAD 2027 - [${app.doc.name}.mcad]${app.doc.dirty ? ' *' : ''}`;
      document.title = `MacCAD 2027 - ${app.doc.name}`;
      if (window.api) window.api.setDirty && window.api.setDirty(app.doc.dirty);
    };

    app.on('doc', syncTitle);

    syncTitle();

    // how many objects are in the hidden space (Cmd+B)
    const syncHidden = () => {
      const n = app.curEnts().filter((e) => e.hid).length;
      hidBadge.classList.toggle('hidden', !n);
      hidBadge.textContent = n ? `${n} hidden   Cmd+Shift+B swaps   Cmd+Shift+U shows all` : '';
    };

    app.on('doc', syncHidden);

    app.on('tabs', syncHidden);

    syncHidden();

    // dyn tooltip
    const dyn = $('#dyn');

    app.on('dyn', () => {
      const d = app.dyn;
      if (!d) {
        dyn.style.display = 'none';
        return;
      }
      dyn.innerHTML = '';
      if (d.snap) dyn.append(h('div', { class: 'snaplbl' }, d.snap));
      d.lines.forEach((l, i) =>
        dyn.append(h('div', { class: i === 0 && d.lines.length > 1 ? 'l1' : '' }, l)),
      );
      dyn.style.display = 'block';
      dyn.style.left = `${d.x + 18}px`;
      dyn.style.top = `${d.y + 20}px`;
      const r = dyn.getBoundingClientRect();
      const vr = viewarea.getBoundingClientRect();
      if (r.right > vr.right) dyn.style.left = `${d.x - r.width - 10}px`;
      if (r.bottom > vr.bottom) dyn.style.top = `${d.y - r.height - 10}px`;
    });
  }

  /** @private Layer / colour / linetype / lineweight / style controls and the properties panel. */
  wireProperties() {
    const { app, ui, styleSel, dimSel, layerSel, colorSel, ltSel, lwSel, props, viewarea, input } =
      this;

    const fillCombos = () => {
      const doc = app.doc;
      const keep = (sel, fn) => {
        const v = sel.value;
        fn();
        if ([...sel.options].some((o) => o.value === v)) sel.value = v;
      };
      keep(styleSel, () => {
        styleSel.innerHTML = '';
        Object.keys(doc.textStyles).forEach((n) => styleSel.append(h('option', { value: n }, n)));
        styleSel.value = doc.curTextStyle;
      });
      keep(dimSel, () => {
        dimSel.innerHTML = '';
        Object.keys(doc.dimStyles).forEach((n) => dimSel.append(h('option', { value: n }, n)));
        dimSel.value = doc.curDimStyle;
      });
      layerSel.innerHTML = '';
      doc.layers.forEach((l) =>
        layerSel.append(
          h(
            'option',
            { value: l.name },
            `${l.on ? '' : '○ '}${l.frozen ? '❄ ' : ''}${l.locked ? '🔒 ' : ''}${l.name}`,
          ),
        ),
      );
      colorSel.innerHTML = '';
      for (const [v, t] of [
        ['bylayer', 'ByLayer'],
        ['byblock', 'ByBlock'],
        ['1', 'Red'],
        ['2', 'Yellow'],
        ['3', 'Green'],
        ['4', 'Cyan'],
        ['5', 'Blue'],
        ['6', 'Magenta'],
        ['7', 'White'],
        ['varies', 'VARIES'],
        ['select', 'Select Color...'],
      ])
        colorSel.append(h('option', { value: v }, `■ ${t}`));
      ltSel.innerHTML = '';
      ltSel.append(
        h('option', { value: 'bylayer' }, 'ByLayer'),
        h('option', { value: 'byblock' }, 'ByBlock'),
        h('option', { value: 'varies' }, 'VARIES'),
      );
      Object.keys(doc.ltypes).forEach((n) => ltSel.append(h('option', { value: n }, n)));
      lwSel.innerHTML = '';
      lwSel.append(
        h('option', { value: 'bylayer' }, 'ByLayer'),
        h('option', { value: 'byblock' }, 'ByBlock'),
        h('option', { value: 'varies' }, 'VARIES'),
      );
      LINEWEIGHTS.forEach((w) =>
        lwSel.append(h('option', { value: w }, w === 0 ? '0.00 mm' : `${w.toFixed(2)} mm`)),
      );
      syncProps();
    };

    const common = (ents, get) => {
      const s = new Set(ents.map(get));
      return s.size === 1 ? [...s][0] : 'varies';
    };

    const syncProps = () => {
      const doc = app.doc;
      const ents = app.selectedEnts();
      const cur = doc.cur;
      const colorKey = (c) => (c == null ? 'bylayer' : c === 'bb' ? 'byblock' : String(c));
      const layer = ents.length ? common(ents, (e) => e.layer) : cur.layer;
      if (layer !== 'varies') layerSel.value = layer;
      const col = ents.length ? common(ents, (e) => colorKey(e.color)) : colorKey(cur.color);
      if (![...colorSel.options].some((o) => o.value === col) && col !== 'varies') {
        const sw = String(col);
        colorSel.append(h('option', { value: sw }, `■ ${colorName(isNaN(+sw) ? sw : +sw)}`));
      }
      colorSel.value = col;
      const lt = ents.length
        ? common(ents, (e) =>
            e.ltype == null ? 'bylayer' : e.ltype === 'bb' ? 'byblock' : e.ltype,
          )
        : cur.ltype == null
          ? 'bylayer'
          : cur.ltype === 'bb'
            ? 'byblock'
            : cur.ltype;
      ltSel.value = lt;
      const lw = ents.length
        ? common(ents, (e) => (e.lw == null ? 'bylayer' : e.lw === 'bb' ? 'byblock' : e.lw))
        : cur.lw == null
          ? 'bylayer'
          : cur.lw === 'bb'
            ? 'byblock'
            : cur.lw;
      lwSel.value = String(lw);
      const L = doc.layer(layer === 'varies' ? cur.layer : layer);
      $('#lyr-sw').style.background =
        typeof L.color === 'number' ? aciHex(L.color === 7 ? 7 : L.color) : L.color;
      if (L.color === 7) $('#lyr-sw').style.background = '#fff';
      $('#lyr-on').innerHTML = L.on ? ICONS.bulb : ICONS.bulboff;
      $('#lyr-frz').innerHTML = L.frozen ? ICONS.snow : ICONS.sun;
      $('#lyr-lck').innerHTML = L.locked ? ICONS.lock : ICONS.unlock;
    };
    this.syncProps = syncProps;

    const applyProp = (label, key, val) => {
      app.edit(label, () => {
        const ents = app.selectedEnts();
        if (ents.length)
          ents.forEach((e) => {
            e[key] = val;
          });
        else app.doc.cur[key] = val;
      });
    };

    layerSel.addEventListener('change', () => {
      if (app.selectedEnts().length) applyProp('LAYER', 'layer', layerSel.value);
      else {
        app.doc.cur.layer = layerSel.value;
        app.emit('doc');
      }
      input.focus();
    });

    colorSel.addEventListener('change', async () => {
      const v = colorSel.value;
      if (v === 'varies') return syncProps();
      if (v === 'select') {
        const r = await dialogs.colorDialog(app.doc.cur.color);
        syncProps();
        if (r !== undefined) applyProp('COLOR', 'color', r);
        return;
      }
      applyProp('COLOR', 'color', v === 'bylayer' ? null : v === 'byblock' ? 'bb' : +v);
      input.focus();
    });

    ltSel.addEventListener('change', () => {
      const v = ltSel.value;
      if (v === 'varies') return syncProps();
      applyProp('LINETYPE', 'ltype', v === 'bylayer' ? null : v === 'byblock' ? 'bb' : v);
      input.focus();
    });

    lwSel.addEventListener('change', () => {
      const v = lwSel.value;
      if (v === 'varies') return syncProps();
      applyProp('LWEIGHT', 'lw', v === 'bylayer' ? null : v === 'byblock' ? 'bb' : parseFloat(v));
      input.focus();
    });

    styleSel.addEventListener('change', () => {
      app.doc.curTextStyle = styleSel.value;
      input.focus();
    });

    dimSel.addEventListener('change', () => {
      app.doc.curDimStyle = dimSel.value;
      input.focus();
    });

    const layerBtn = (id, prop) =>
      $(id).addEventListener('click', () => {
        const l = app.doc.layer(layerSel.value || app.doc.cur.layer);
        app.edit('LAYER', () => {
          l[prop] = prop === 'on' ? !l.on : !l[prop];
        });
      });

    layerBtn('#lyr-on', 'on');

    layerBtn('#lyr-frz', 'frozen');

    layerBtn('#lyr-lck', 'locked');

    app.on('doc', fillCombos);

    app.on('selection', syncProps);

    fillCombos();

    ui.toggleProps = (force) => {
      const show = force === undefined ? props.classList.contains('hidden') : force;
      props.classList.toggle('hidden', !show);
      if (show) buildProps(app, props, () => ui.toggleProps(false));
      app.renderer.resize(viewarea.clientWidth, viewarea.clientHeight);
    };

    const refreshProps = () => {
      if (!props.classList.contains('hidden')) buildProps(app, props, () => ui.toggleProps(false));
    };

    app.on('selection', refreshProps);

    app.on('doc', () => {
      if (!app.running) refreshProps();
    });
  }

  /** @private Scroll bars of the drawing area. */
  wireScrollbars() {
    const { app, vscroll, hscroll } = this;

    const sbars = { v: $('.sthumb', vscroll), hh: $('.sthumb', hscroll) };

    const range = () => {
      const v = app.activeView();
      const ext = app.extentsBox() || { x0: 0, y0: 0, x1: 420, y1: 297 };
      const vw = v.w / v.zoom;
      const vh = v.h / v.zoom;
      const x0 = Math.min(ext.x0, v.cx - vw / 2) - vw * 0.5;
      const x1 = Math.max(ext.x1, v.cx + vw / 2) + vw * 0.5;
      const y0 = Math.min(ext.y0, v.cy - vh / 2) - vh * 0.5;
      const y1 = Math.max(ext.y1, v.cy + vh / 2) + vh * 0.5;
      return { x0, x1, y0, y1, vw, vh, v };
    };

    const syncScroll = () => {
      const r = range();
      const W = hscroll.clientWidth;
      const H = vscroll.clientHeight;
      const tw = Math.max(18, (W * r.vw) / (r.x1 - r.x0));
      const th = Math.max(18, (H * r.vh) / (r.y1 - r.y0));
      sbars.hh.style.width = `${Math.min(W, tw)}px`;
      sbars.hh.style.left = `${Math.max(0, Math.min(W - tw, ((r.v.cx - r.vw / 2 - r.x0) / (r.x1 - r.x0)) * W))}px`;
      sbars.v.style.height = `${Math.min(H, th)}px`;
      sbars.v.style.top = `${Math.max(0, Math.min(H - th, ((r.y1 - (r.v.cy + r.vh / 2)) / (r.y1 - r.y0)) * H))}px`;
    };
    this.syncScroll = syncScroll;

    const dragThumb = (thumb, horiz) =>
      thumb.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r0 = range();
        const start = horiz ? e.clientX : e.clientY;
        const c0 = horiz ? r0.v.cx : r0.v.cy;
        const move = (ev) => {
          const d = (horiz ? ev.clientX : ev.clientY) - start;
          const len = horiz ? hscroll.clientWidth : vscroll.clientHeight;
          const world = horiz ? (d / len) * (r0.x1 - r0.x0) : -(d / len) * (r0.y1 - r0.y0);
          const vp = app.viewport();
          const v = app.view;
          if (horiz) {
            if (vp) vp.cx = c0 + world;
            else v.cx = c0 + world;
          } else if (vp) vp.cy = c0 + world;
          else v.cy = c0 + world;
          app.changed();
          app.emit('view');
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });

    dragThumb(sbars.v, false);

    dragThumb(sbars.hh, true);

    app.on('view', syncScroll);

    app.on('space', syncScroll);

    app.on('doc', syncScroll);
  }

  /** @private Toolbar visibility and clean screen; startup AutoLISP files. */
  wireChrome() {
    const { app, viewarea } = this;

    // toolbar visibility / clean screen
    const applyChrome = () => {
      const t = {
        standard: true,
        layers: true,
        draw: true,
        modify: true,
        dim: true,
        solids: true,
        ...(app.settings.toolbars || {}),
      };
      const clean = !!app.settings.cleanScreen;
      const solidsRow = $('#row3');
      if (solidsRow) solidsRow.style.display = !clean && t.solids ? '' : 'none';
      $('#row1').style.display = !clean && t.standard ? '' : 'none';
      $('#row2').style.display = !clean && t.layers ? '' : 'none';
      $('#tb-left').style.display = !clean && t.draw ? '' : 'none';
      $('#tb-right').style.display = !clean && (t.modify || t.dim) ? '' : 'none';
      $('#toolrows').style.display = !clean && (t.standard || t.layers || t.solids) ? '' : 'none';
      $('#menubar').style.display = clean ? 'none' : '';
      $('#status').style.display = clean ? 'none' : '';
      app.renderer.resize(viewarea.clientWidth, viewarea.clientHeight);
    };

    app.on('settings', applyChrome);

    applyChrome();

    applyCustomAliases(app.settings);

    app.loadStartupLisp().catch((e) => app.echo(`Startup LISP error: ${e.message}`));
  }

  /** @private 3D view controls and resizing of the drawing area. */
  wireViewSizing() {
    const { app, vsSel, vwSel, canvas, glCanvas, viewarea, input, syncScroll } = this;

    const ui3 = init3DUI(app, h, viewarea, glCanvas, canvas);

    const syncVsel = () => {
      vsSel.value = app.settings.vstyle || '2dwireframe';
      vwSel.value = app.v3 ? app.v3.preset || '' : '';
    };

    vsSel.addEventListener('change', () => {
      app.setVisualStyle(vsSel.value);
      input.focus();
    });

    vwSel.addEventListener('change', () => {
      if (vwSel.value) app.setPreset3D(vwSel.value);
      input.focus();
    });

    app.on('view3d', syncVsel);

    app.on('settings', syncVsel);

    syncVsel();

    void ui3;

    const ro = new ResizeObserver(() => {
      app.cvW = viewarea.clientWidth;
      app.cvH = viewarea.clientHeight;
      app.renderer.resize(app.cvW, app.cvH);
      syncScroll();
    });

    ro.observe(viewarea);

    // left / right toolbar widths follow content
    app.cvW = viewarea.clientWidth;

    app.cvH = viewarea.clientHeight;

    app.renderer.resize(app.cvW || 800, app.cvH || 600);

    app.zoomExtents(false);

    app.emit('view');
  }

  /** @private Keyboard shortcuts, drag and drop of files, events from the native menu and window, unsaved-changes check on close. */
  wireGlobalInput() {
    const { app, ui, runItem, menuMap, showText, input, textwin } = this;

    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const mod = e.ctrlKey || e.metaKey;
      app.keys.shift = e.shiftKey;
      if (e.key === 'Escape') {
        if (document.querySelector('.modal-bg')) return;
        closePopups();
        showText(false);
        app.cancelReq();
        if (!app.req) app.clearSel();
        e.preventDefault();
        return;
      }
      if (inField && !(e.target === input)) {
        if (/^F\d+$/.test(e.key)) {
          /* fall through to F keys */
        } else return;
      }
      const toggleGridStyle = () => {
        const next = app.settings.gridStyle === 'dots' ? 'lines' : 'dots';
        app.set('gridStyle', next);
        if (!app.settings.grid) app.set('grid', true);
        app.echo(`Grid style: ${next}.`);
      }; // Shift+F7
      const fk = {
        F1: () => app.exec('HELP'),
        F2: () => showText(textwin.classList.contains('hidden')),
        F3: () => app.toggle('osnap'),
        F7: () => (e.shiftKey ? toggleGridStyle() : app.toggle('grid')),
        F8: () => app.toggle('ortho'),
        F9: () => app.toggle('snap'),
        F10: () => app.toggle('polar'),
        F11: () => app.toggle('otrack'),
        F12: () => app.toggle('dyn'),
      };
      if (fk[e.key]) {
        e.preventDefault();
        fk[e.key]();
        return;
      }
      if (mod) {
        const k = e.key.toLowerCase();
        if (e.shiftKey && (e.key === '}' || e.key === ']')) {
          e.preventDefault();
          app.nextTab(1);
          return;
        }
        if (e.shiftKey && (e.key === '{' || e.key === '[')) {
          e.preventDefault();
          app.nextTab(-1);
          return;
        }
        const map = {
          n: 'NEW',
          o: 'OPEN',
          s: e.shiftKey ? 'SAVEAS' : 'SAVE',
          p: 'PLOT',
          z: e.shiftKey ? 'REDO' : 'UNDO1',
          y: 'REDO',
          c: e.shiftKey ? 'COPYBASE' : 'COPYCLIP',
          x: 'CUTCLIP',
          v: e.shiftKey ? 'PASTEBLOCK' : 'PASTECLIP',
          a: 'SELECTALL',
          1: 'PROPERTIES',
          0: 'CLEANSCREENON',
          b: e.shiftKey ? 'SWAPHIDDEN' : 'HIDEOBJECTS',
          u: e.shiftKey ? 'SHOWALLOBJECTS' : undefined,
          q: 'QUIT',
          w: 'CLOSE',
        };
        if (e.target === input && ['c', 'x', 'v', 'a', 'z'].includes(k) && input.value) return; // native text editing
        if (map[k]) {
          e.preventDefault();
          app.exec(map[k]);
          return;
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!app.req && app.sel.size && e.target !== input) {
          e.preventDefault();
          app.exec('ERASE');
          return;
        }
        if (e.key === 'Delete' && !input.value) return;
      }
      if (e.target === input) return;
      if (e.key === 'Enter' || (e.key === ' ' && !(app.req && app.req.type === 'string'))) {
        e.preventDefault();
        app.enter();
        return;
      }
      if (e.key.length === 1 && !e.altKey) {
        input.focus();
      }
    });

    window.addEventListener('keyup', (e) => {
      app.keys.shift = e.shiftKey;
    });

    window.addEventListener('blur', () => {
      app.keys.shift = false;
    });

    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.popup') && !e.target.closest('#menubar')) closePopups();
    });

    // drag & drop of drawings / scripts onto the window
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      if (!files.length) return;
      for (const f of files) {
        if (window.api) {
          const p = window.api.pathForFile(f);
          if (/\.pdf$/i.test(p)) {
            await app.exec('PDFIMPORT', p);
            continue;
          }
          if (/\.(lsp|scr)$/i.test(p)) {
            await app.exec(/\.scr$/i.test(p) ? 'SCRIPT' : 'LOAD', p);
            continue;
          }
          const r = await window.api.readFile(p);
          if (r && r.error) {
            await ui.alert(r.error);
            continue;
          }
          if (r) io.openData(app, r);
        } else {
          const text = await f.text();
          if (/\.(lsp)$/i.test(f.name)) {
            if (app.lisp) await app.lisp.evalString(text);
            continue;
          }
          io.openData(app, { name: f.name, path: null, data: text });
        }
      }
    });

    // native menu / window events from the main process
    if (window.api) {
      window.api.on('open-file', (f) => io.openData(app, f));
      window.api.on('menu', (cmd) => app.exec(cmd));
      // menu accelerators take the keys first: route plain text editing (command line, dialog fields) back to native editing
      window.api.on('menu-run', (id) => {
        const it = menuMap.get(id);
        if (!it) return;
        const ae = document.activeElement;
        const field = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
        const inCmd = ae === input;
        const EDIT = {
          UNDO1: 'undo',
          REDO: 'redo',
          CUTCLIP: 'cut',
          COPYCLIP: 'copy',
          PASTECLIP: 'paste',
          SELECTALL: 'selectAll',
        };
        if (field && EDIT[it.cmd] && (!inCmd || input.value)) {
          window.api.editAction(EDIT[it.cmd]);
          return;
        }
        closePopups();
        runItem(it);
      });
      window.api.onCloseRequest(async () => {
        const ok = await io.confirmAll(app);
        window.api.closeAnswer(ok);
      });
    }

    window.addEventListener('beforeunload', (e) => {
      if (app.tabs.some((t) => t.doc.dirty) && !window.api) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    input.focus();
  }
}
