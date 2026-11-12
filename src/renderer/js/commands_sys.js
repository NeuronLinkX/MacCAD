/**
 * @file commands_sys.js
 * @brief System commands: layer command line, rename, named views, limits, system variables,
 *        undo control, audit, UI toggles, block insertion.
 *
 * Commands registered here: -LAYER, LAYDEL, LAYMRG, LAYULKALL, LAYWALK, RENAME, -RENAME, VIEW,
 * -VIEW, LIMITS, UCS, PLAN, REGENAUTO, SETVAR, UNDO, MREDO, UNDO1, AUDIT, RECOVER, BASE, DWGPROPS,
 * DWGUNITS, CLEANSCREEN(ON/OFF), TOOLBAR, FULLSCREEN, ALIASEDIT, REDRAWALL, NEWWIN, SAVEALL,
 * CLOSEALL, OPENDWG, EXPORTPDF, -PURGE, -INSERT, MINSERT.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { def, alias, COMMANDS, ALIASES } from './registry.js';
import * as E from './entities.js';
import * as G from './geom.js';
import { fmtLen } from './units.js';

/* ============================================================================================
 * 2. CONSTANTS AND HELPERS
 * ========================================================================================== */

/** @returns {boolean} true when v is a point {x, y}. */
const isPt = (v) => v && typeof v === 'object' && 'x' in v;

/** Colour names accepted by -LAYER Color. */
const COLOR_NAMES = { red: 1, yellow: 2, green: 3, cyan: 4, blue: 5, magenta: 6, white: 7 };

/** Insert unit names of DWGUNITS (index = INSUNITS value). */
const INSERT_UNIT_NAMES = [
  'Unitless',
  'Inches',
  'Feet',
  'Miles',
  'Millimeters',
  'Centimeters',
  'Meters',
  'Kilometers',
];

/**
 * Turns a wildcard list ("A*,B?") into a case-insensitive regular expression.
 * @param {string} p comma separated patterns; `*` = any text, `?` = one character
 * @returns {RegExp}
 */
const wildToRe = (p) =>
  new RegExp(
    '^' +
      p
        .split(',')
        .map((x) => x.trim())
        .map((x) =>
          x
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.'),
        )
        .join('|^') +
      '$',
    'i',
  );

/** @returns {object[]} the layers whose name matches the wildcard pattern. */
const matchLayers = (doc, pat) => {
  const re = wildToRe(pat);
  return doc.layers.filter((l) => re.test(l.name));
};

/** @returns {string[]} the names of all spaces: 'model' and every layout. */
const allSpaces = (doc) => ['model', ...Object.keys(doc.layouts)];

/* ============================================================================================
 * 3. RENAME TARGETS
 * ========================================================================================== */

/**
 * The kinds of named objects that RENAME can rename, each with `list()` and `ren(old, new)`
 * (which throws an Error with a readable message when the rename is not allowed).
 * @param {object} doc the document
 * @returns {Object<string, {list: Function, ren: Function}>}
 */
export function renameTargets(doc) {
  return {
    Layers: {
      list: () => doc.layers.map((l) => l.name),
      ren: (o, n) => {
        if (o === '0') throw new Error('Layer 0 cannot be renamed.');
        if (doc.hasLayer(n)) throw new Error('That name already exists.');
        doc.layers.forEach((l) => {
          if (l.name === o) l.name = n;
        });
        for (const sp of allSpaces(doc))
          doc.spaceList(sp).forEach((e) => {
            if (e.layer === o) e.layer = n;
          });
        Object.values(doc.blocks).forEach((b) =>
          b.ents.forEach((e) => {
            if (e.layer === o) e.layer = n;
          }),
        );
        if (doc.cur.layer === o) doc.cur.layer = n;
      },
    },
    Blocks: {
      list: () => Object.keys(doc.blocks),
      ren: (o, n) => {
        if (doc.blocks[n]) throw new Error('That name already exists.');
        const b = doc.blocks[o];
        b.name = n;
        doc.blocks[n] = b;
        delete doc.blocks[o];
        for (const sp of allSpaces(doc))
          doc.spaceList(sp).forEach((e) => {
            if (e.type === 'insert' && e.name === o) e.name = n;
          });
        Object.values(doc.blocks).forEach((bb) =>
          bb.ents.forEach((e) => {
            if (e.type === 'insert' && e.name === o) e.name = n;
          }),
        );
        doc.blockVer += 1;
      },
    },
    'Text styles': {
      list: () => Object.keys(doc.textStyles),
      ren: (o, n) => {
        if (o === 'Standard') throw new Error('Standard cannot be renamed.');
        if (doc.textStyles[n]) throw new Error('That name already exists.');
        doc.textStyles[n] = doc.textStyles[o];
        delete doc.textStyles[o];
        for (const sp of allSpaces(doc))
          doc.spaceList(sp).forEach((e) => {
            if (e.style === o) e.style = n;
          });
        if (doc.curTextStyle === o) doc.curTextStyle = n;
      },
    },
    'Dimension styles': {
      list: () => Object.keys(doc.dimStyles),
      ren: (o, n) => {
        if (o === 'Standard') throw new Error('Standard cannot be renamed.');
        if (doc.dimStyles[n]) throw new Error('That name already exists.');
        doc.dimStyles[n] = doc.dimStyles[o];
        delete doc.dimStyles[o];
        for (const sp of allSpaces(doc))
          doc.spaceList(sp).forEach((e) => {
            if (e.style === o) e.style = n;
          });
        if (doc.curDimStyle === o) doc.curDimStyle = n;
      },
    },
    Views: {
      list: () => Object.keys(doc.views || {}),
      ren: (o, n) => {
        doc.views[n] = doc.views[o];
        delete doc.views[o];
      },
    },
  };
}

/* ============================================================================================
 * 4. CLASS
 * ========================================================================================== */

/** The system commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class SysCommands {
  // ---------------------------------------------------------------- layers

  /** -LAYER: the layer command line (make, set, new, on/off, colour, linetype, freeze, lock, ...). */
  static async layerCmd(c) {
    const doc = c.doc;
    for (;;) {
      const o = await c.keyword(
        'Enter an option [?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock]',
        [
          '?',
          'Make',
          'Set',
          'New',
          'ON',
          'OFF',
          'Color',
          'Ltype',
          'LWeight',
          'Freeze',
          'Thaw',
          'LOck',
          'Unlock',
        ],
        null,
      );
      if (o === null) return;
      if (o === '?') {
        c.echo('Layer name        State    Color  Linetype');
        doc.layers.forEach((l) =>
          c.echo(
            `${l.name.padEnd(17)} ${(l.on ? 'On ' : 'Off') + (l.frozen ? ' Frz' : '') + (l.locked ? ' Lck' : '')}  ${String(l.color).padEnd(6)} ${l.ltype}`,
          ),
        );
        c.ui.showTextWindow(true);
        continue;
      }
      if (o === 'Make' || o === 'Set') {
        const n = await c.string(
          `Enter layer name to ${o === 'Make' ? 'make current' : 'set current'}`,
          { def: doc.cur.layer },
        );
        if (!n) continue;
        if (!doc.hasLayer(n)) {
          if (o === 'Set') {
            c.echo(`Layer "${n}" not found.`);
            continue;
          }
          doc.addLayer(n);
        }
        doc.cur.layer = doc.layer(n).name;
        c.app.emit('doc');
        continue;
      }
      if (o === 'New') {
        const n = await c.string('Enter name list for new layer(s)');
        (n || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .forEach((x) => doc.addLayer(x));
        c.app.emit('doc');
        continue;
      }
      let val;
      if (o === 'Color') val = await c.string('Enter color name or number (1-255)', { def: '7' });
      else if (o === 'Ltype')
        val = await c.string('Enter loaded linetype name', { def: 'Continuous' });
      else if (o === 'LWeight') val = await c.number('Enter lineweight (mm)', { def: 0.25 });
      if (
        ['Color', 'Ltype', 'LWeight'].includes(o) &&
        (val === null || val === undefined || val === '')
      )
        continue;
      const pat = await c.string('Enter layer name(s) (wildcards allowed)', {
        def: doc.cur.layer,
      });
      if (!pat) continue;
      const ls = matchLayers(doc, pat);
      if (!ls.length) {
        c.echo('No matching layer found.');
        continue;
      }
      if (o === 'ON')
        ls.forEach((l) => {
          l.on = true;
        });
      else if (o === 'OFF')
        ls.forEach((l) => {
          l.on = false;
        });
      else if (o === 'Freeze')
        ls.forEach((l) => {
          if (l.name !== doc.cur.layer) l.frozen = true;
        });
      else if (o === 'Thaw')
        ls.forEach((l) => {
          l.frozen = false;
        });
      else if (o === 'LOck')
        ls.forEach((l) => {
          l.locked = true;
        });
      else if (o === 'Unlock')
        ls.forEach((l) => {
          l.locked = false;
        });
      else if (o === 'Color') {
        const n = parseInt(val, 10);
        const col = COLOR_NAMES[String(val).toLowerCase()] || n;
        if (col >= 1 && col <= 255)
          ls.forEach((l) => {
            l.color = col;
          });
        else c.echo('Invalid color.');
      } else if (o === 'Ltype') {
        const key = Object.keys(doc.ltypes).find(
          (k) => k.toLowerCase() === String(val).toLowerCase(),
        );
        if (key)
          ls.forEach((l) => {
            l.ltype = key;
          });
        else c.echo('Linetype not loaded.');
      } else if (o === 'LWeight')
        ls.forEach((l) => {
          l.lw = val;
        });
      c.app.emit('doc');
      c.bump();
    }
  }

  /** LAYDEL: deletes a layer with all its objects. */
  static async layerDelete(c) {
    const r = await c.pick('Select object on the layer to be deleted');
    if (!r || !r.e) return;
    const n = r.e.layer;
    if (n === '0' || n === c.doc.cur.layer)
      return c.fail('Layer 0 and the current layer cannot be deleted.');
    const y = await c.keyword(
      `Delete layer "${n}" and all of its objects? [Yes/No]`,
      ['Yes', 'No'],
      'No',
    );
    if (y !== 'Yes') return;
    for (const sp of allSpaces(c.doc)) {
      const ids = c.doc
        .spaceList(sp)
        .filter((e) => e.layer === n)
        .map((e) => e.id);
      c.doc.remove(ids, sp);
    }
    c.doc.layers = c.doc.layers.filter((l) => l.name !== n);
    c.echo(`Layer "${n}" deleted.`);
    c.bump();
  }

  /** LAYMRG: moves the objects of one layer to another and removes the first layer. */
  static async layerMerge(c) {
    const a = await c.pick('Select object on the layer to merge');
    if (!a || !a.e) return;
    const b = await c.pick('Select object on the target layer');
    if (!b || !b.e) return;
    const from = a.e.layer;
    const to = b.e.layer;
    if (from === to) return;
    for (const sp of allSpaces(c.doc))
      c.doc.spaceList(sp).forEach((e) => {
        if (e.layer === from) e.layer = to;
      });
    if (from !== '0' && from !== c.doc.cur.layer)
      c.doc.layers = c.doc.layers.filter((l) => l.name !== from);
    c.echo(`Layer "${from}" merged into "${to}".`);
    c.bump();
  }

  /** LAYULKALL: unlocks every layer. */
  static async layerUnlockAll(c) {
    c.doc.layers.forEach((l) => {
      l.locked = false;
    });
    c.echo('All layers unlocked.');
    c.bump();
  }

  /** LAYWALK: opens the layer manager. */
  static async layerWalk(c) {
    c.ui.layerManager(c);
  }

  // ---------------------------------------------------------------- rename

  /** RENAME: the Rename window. */
  static async rename(c) {
    await c.ui.renameDialog(c);
  }

  /** -RENAME: renames at the command line. */
  static async renameCmd(c) {
    const T = renameTargets(c.doc);
    const kinds = Object.keys(T);
    const k = await c.keyword(`Enter object type to rename [${kinds.join('/')}]`, kinds, null);
    if (!k) return;
    const old = await c.string('Enter old name');
    const nw = await c.string('Enter new name');
    if (!old || !nw) return;
    try {
      T[k].ren(old, nw);
      c.bump();
      c.app.emit('doc');
    } catch (e) {
      c.fail(e.message);
    }
  }

  // ---------------------------------------------------------------- views, limits, UCS

  /** VIEW: the View Manager window. */
  static async view(c) {
    await c.ui.viewDialog(c);
  }

  /** -VIEW: named views at the command line (?, Save, Restore, Delete). */
  static async viewCmd(c) {
    const doc = c.doc;
    doc.views ||= {};
    const o = await c.keyword(
      'Enter an option [?/Delete/Restore/Save/Window]',
      ['?', 'Delete', 'Restore', 'Save', 'Window'],
      null,
    );
    if (!o) return;
    if (o === '?') {
      Object.keys(doc.views).forEach((n) => c.echo(n));
      return;
    }
    const n = await c.string('Enter view name');
    if (!n) return;
    if (o === 'Save') {
      const v = c.app.activeView();
      doc.views[n] = {
        cx: v.cx,
        cy: v.cy,
        zoom: c.app.viewport() ? c.app.view.zoom * c.app.viewport().scale : v.zoom,
        space: c.app.space,
      };
      c.echo(`View "${n}" saved.`);
    } else if (o === 'Restore') {
      const v = doc.views[n];
      if (!v) return c.fail('View not found.');
      c.app.setZoom(v.cx, v.cy, v.zoom);
    } else if (o === 'Delete') delete doc.views[n];
  }

  /** LIMITS: the drawing limits (lower left and upper right corner, ON / OFF). */
  static async limits(c) {
    const cur = c.doc.limits || { x0: 0, y0: 0, x1: 420, y1: 297 };
    const a = await c.point(`Specify lower left corner or [ON/OFF] <${cur.x0},${cur.y0}>`, {
      kw: ['ON', 'OFF'],
      def: { x: cur.x0, y: cur.y0 },
      noOrtho: true,
    });
    if (a === 'ON') {
      c.app.set('limitsOn', true);
      return;
    }
    if (a === 'OFF') {
      c.app.set('limitsOn', false);
      return;
    }
    const p0 = isPt(a) ? a : { x: cur.x0, y: cur.y0 };
    const b = await c.point(`Specify upper right corner <${cur.x1},${cur.y1}>`, {
      base: p0,
      def: { x: cur.x1, y: cur.y1 },
      noOrtho: true,
    });
    const p1 = isPt(b) ? b : { x: cur.x1, y: cur.y1 };
    c.doc.limits = { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
    c.bump();
    c.app.emit('doc');
  }

  /** UCS: world, 3-point, face, view and named user coordinate systems. */
  static async ucs(c, forced = null) {
    const table=c.doc.ucs||(c.doc.ucs={current:null,previous:null,named:{}}),copy=p=>p?E.clone(p):null;
    let o=forced||c.arg||await c.keyword('Enter an option [World/Previous/3point/Face/View/Origin/Save/Restore/Delete/?] <World>',['World','Previous','3point','Face','View','Origin','Save','Restore','Delete','?'],'World');
    if(!o)return;
    const set=(plane,label)=>{table.previous=copy(table.current);table.current=copy(plane);if(table.current)table.current.name=label||table.current.name||'UCS';c.bump();c.app.emit('view3d');c.echo(table.current?`UCS = ${table.current.name}`:'UCS = World');};
    const vec=(a,b)=>[b.x-a.x,b.y-a.y,(b.z||0)-(a.z||0)],unit=v=>{const n=Math.hypot(...v);if(!(n>1e-9))throw new Error('UCS points must be different.');return v.map(x=>x/n);},cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    if(o==='World')return set(null,'World');
    if(o==='Previous'){const prior=copy(table.previous);table.previous=copy(table.current);table.current=prior;c.bump();c.app.emit('view3d');return c.echo(table.current?`UCS = ${table.current.name||'Previous'}`:'UCS = World');}
    if(o==='3point'){
      const origin=await c.point('Specify new UCS origin',{world3d:true,noOrtho:true});if(!origin)return;const xp=await c.point('Specify point on positive X axis',{world3d:true,noOrtho:true,base:origin});if(!xp)return;const yp=await c.point('Specify point in positive XY plane',{world3d:true,noOrtho:true,base:origin});if(!yp)return;
      const x=unit(vec(origin,xp)),toward=vec(origin,yp),n=unit(cross(x,toward)),y=cross(n,x);return set({o:[origin.x,origin.y,origin.z||0],x,y,n},'3 Point');
    }
    if(o==='Face'){if(!c.app.v3)c.app.enter3D('swiso');const hit=await c.app.request('face','Select planar face for UCS');if(!hit)return;const plane=c.app.faceDrawingPlane(hit);if(!plane)throw new Error('The selected face has no usable coordinate frame.');return set(plane,'Face');}
    if(o==='View'){if(!c.app.v3)c.app.enter3D('swiso');const plane=c.app.sideDrawingPlane()||c.app.viewPlane();if(!plane)throw new Error('Open a 3D view before using View UCS.');return set(plane,'View');}
    if(o==='Origin'){const p=await c.point('Specify new UCS origin',{world3d:true,noOrtho:true});if(!p)return;const base=table.current||{x:[1,0,0],y:[0,1,0],n:[0,0,1]};return set({...base,o:[p.x,p.y,p.z||0]},base.name||'Moved');}
    if(o==='Save'){if(!table.current)throw new Error('Set a user coordinate system before saving it.');const name=await c.string('Enter UCS name',{def:table.current.name||'UCS1'});if(!name)return;table.named[name]=copy({...table.current,name});table.current.name=name;c.bump();c.app.emit('view3d');return c.echo(`UCS "${name}" saved.`);}
    if(o==='Restore'){const names=Object.keys(table.named);if(!names.length)throw new Error('No named UCS has been saved.');const name=await c.string(`Enter UCS name [${names.join('/')}]`,{def:names[0]});if(!table.named[name])throw new Error(`UCS "${name}" was not found.`);return set(table.named[name],name);}
    if(o==='Delete'){const names=Object.keys(table.named);if(!names.length)throw new Error('No named UCS has been saved.');const name=await c.string(`Enter UCS name to delete [${names.join('/')}]`,{def:names[0]});if(!table.named[name])throw new Error(`UCS "${name}" was not found.`);delete table.named[name];c.bump();return c.echo(`UCS "${name}" deleted.`);}
    if(o==='?')return c.echo(`Current: ${table.current?.name||'World'}; Named UCS: ${Object.keys(table.named).join(', ')||'(none)'}`);
  }

  /** PLAN: zooms to the drawing. */
  static async plan(c) {
    c.app.zoomExtents();
  }

  // ---------------------------------------------------------------- system variables

  /** SETVAR: shows or changes a system variable ("?" lists them). */
  static async setvar(c) {
    const sv = c.app.lisp.sysvars;
    for (;;) {
      const n = await c.string('Enter variable name or [?]', { def: '' });
      if (!n) return;
      if (n === '?') {
        const pat = await c.string('Enter variable(s) to list', { def: '*' });
        const re = wildToRe(pat || '*');
        Object.keys(sv)
          .filter((k) => re.test(k))
          .sort()
          .forEach((k) => {
            let v = sv[k].get();
            if (Array.isArray(v)) v = v.map((x) => +(+x).toFixed(4)).join(',');
            c.echo(`${k.padEnd(14)} ${v}${sv[k].set ? '' : '  (read-only)'}`);
          });
        c.ui.showTextWindow(true);
        continue;
      }
      const key = n.toUpperCase();
      const v = sv[key];
      if (!v) {
        c.echo(`Unknown variable name "${n}". Enter ? to list variables.`);
        continue;
      }
      let cur = v.get();
      if (Array.isArray(cur)) cur = cur.join(',');
      if (!v.set) {
        c.echo(`${key} = ${cur}  (read-only)`);
        return;
      }
      const val = await c.string(`Enter new value for ${key} <${cur}>`, {
        def: String(cur),
        showDef: false,
      });
      if (val === null || val === String(cur)) return;
      const num = Number(val);
      v.set(Number.isNaN(num) || typeof v.get() === 'string' ? val : num);
      c.app.emit('doc');
      c.bump();
      return;
    }
  }

  // ---------------------------------------------------------------- undo control

  /** UNDO: undoes N steps; Mark / Back go back to a marked step. */
  static async undo(c) {
    const o = await c.string(
      'Enter the number of operations to undo or [Auto/Control/BEgin/End/Mark/Back] <1>',
      { def: '1', showDef: false },
    );
    const doc = c.app.doc;
    const t = String(o ?? '1')
      .trim()
      .toLowerCase();
    if (t === 'm' || t === 'mark') {
      c.app.undoMark = doc.undoStack.length;
      c.echo('Mark set.');
      return;
    }
    if (t === 'b' || t === 'back') {
      if (c.app.undoMark == null) return c.echo('Nothing marked.');
      const n = doc.undoStack.length - c.app.undoMark;
      for (let i = 0; i < n; i += 1) doc.undo();
      c.app.afterHistory('UNDO Back');
      return;
    }
    if (['a', 'auto', 'c', 'control', 'be', 'begin', 'e', 'end'].includes(t)) {
      c.echo('Undo grouping is automatic: every command is one undo step.');
      return;
    }
    const n = Math.max(1, parseInt(t, 10) || 1);
    setTimeout(() => {
      for (let i = 0; i < n; i += 1) c.app.undo();
    }, 0);
  }

  /** MREDO: redoes N steps. */
  static async multiRedo(c) {
    const n = await c.number('Enter number of actions or [All]', { def: 1, kw: ['All'] });
    if (n === 'All') {
      for (let i = 0; i < 10000 && c.doc.redoStack && c.doc.redoStack.length; i += 1) c.app.redo();
      return;
    }
    for (let i = 0; i < (n || 1); i += 1) c.app.redo();
  }

  /** UNDO1 / U: undoes one step (after the running command has ended). */
  static async undoOne(c) {
    setTimeout(() => c.app.undo(), 0);
  }

  // ---------------------------------------------------------------- audit, base point, units

  /** AUDIT: adds missing layers and reports block references without a definition. */
  static async audit(c) {
    let fixed = 0;
    const missing = [];
    const scan = (ents) =>
      ents.forEach((e) => {
        if (!c.doc.hasLayer(e.layer)) {
          c.doc.addLayer(e.layer);
          fixed += 1;
        }
        if (e.type === 'insert' && !c.doc.blocks[e.name]) missing.push(e.name);
      });
    scan(c.doc.model);
    Object.values(c.doc.layouts).forEach((l) => scan(l.ents));
    Object.values(c.doc.blocks).forEach((b) => scan(b.ents));
    c.echo('Auditing Header\nAuditing Tables\nAuditing Entities Pass 1\nAuditing Blocks');
    c.echo(
      `Total errors found ${fixed + missing.length} (${fixed} fixed, ${missing.length} unresolved block references${missing.length ? ': ' + [...new Set(missing)].join(', ') : ''})`,
    );
  }

  /** RECOVER: opens a file (the readers repair what they can). */
  static async recover(c) {
    await c.ui.io.openFile(c.app);
  }

  /** BASE: the insertion base point of the drawing. */
  static async base(c) {
    const p = await c.point('Enter base point', { def: c.doc.base || { x: 0, y: 0 } });
    if (isPt(p)) {
      c.doc.base = { x: p.x, y: p.y };
      c.echo(`Base point = ${c.fmt(p.x)},${c.fmt(p.y)}`);
    }
  }

  /** DWGPROPS: the Drawing Properties window. */
  static async dwgProps(c) {
    await c.ui.dwgPropsDialog(c);
  }

  /** DWGUNITS: the unit that block insertion assumes. */
  static async dwgUnits(c) {
    const names = INSERT_UNIT_NAMES;
    const v = await c.keyword(
      `Enter insert units [${names.join('/')}]`,
      names,
      names[c.doc.insUnits || 0],
    );
    if (v) {
      c.doc.insUnits = names.indexOf(v);
      c.echo(`Drawing units: ${v}`);
    }
  }

  // ---------------------------------------------------------------- UI toggles and file shortcuts

  /** TOOLBAR: the Toolbars window. */
  static async toolbars(c) {
    await c.ui.toolbarDialog(c);
  }

  /** FULLSCREEN: maximises the window. */
  static async fullscreen(c) {
    if (c.app.api) c.app.api.win('maximize');
  }

  /** NEWWIN: opens an independent drawing window. */
  static async newWindow(c) {
    if(c.app.api?.newWindow)c.app.api.newWindow();
    else c.echo('A second window is available in the desktop app.');
  }

  /** ALIASEDIT: the command alias editor. */
  static async aliasEdit(c) {
    await c.ui.aliasEditDialog(c);
  }

  /** SAVEALL */
  static async saveAll(c) {
    await c.ui.io.saveFile(c.app, false);
  }

  /** CLOSEALL */
  static async closeAll(c) {
    await c.ui.io.closeAll(c.app);
  }

  /** OPENDWG / OPENDXF */
  static async openDwg(c) {
    await c.ui.io.openFile(c.app);
  }

  /** EXPORTPDF / PDFOUT: opens the plot window. */
  static async exportPdf(c) {
    await c.ui.plotDialog(c);
  }

  // ---------------------------------------------------------------- blocks

  /** -INSERT: inserts a block at the command line (asks for attribute values). */
  static async insertCmd(c) {
    const names = Object.keys(c.doc.blocks);
    const n = await c.string(`Enter block name or [?]`, { def: names[0] || '' });
    if (!n) return;
    if (n === '?') {
      names.forEach((x) => c.echo(x));
      return;
    }
    if (!c.doc.blocks[n]) return c.fail(`Block "${n}" not found.`);
    const p = await c.point('Specify insertion point', {
      preview: (q) => [c.mk('insert', { name: n, p: q, rot: 0, sx: 1, sy: 1 })],
    });
    if (!isPt(p)) return;
    const sx = await c.number('Enter X scale factor', { def: 1 });
    const rot = await c.angle('Specify rotation angle', { base: p, def: 0 });
    const ins = c.mk('insert', {
      name: n,
      p,
      rot: typeof rot === 'number' ? rot : 0,
      sx: sx || 1,
      sy: sx || 1,
    });
    const defs = c.doc.blocks[n].ents.filter((x) => x.attdef);
    if (defs.length) {
      ins.attribs = {};
      for (const x of defs) {
        const v = await c.string(x.attdef.prompt, { def: x.attdef.def, defText: x.attdef.def });
        ins.attribs[x.attdef.tag] = v === null ? x.attdef.def : v;
      }
    }
    c.add(ins);
  }

  /** MINSERT: inserts a rows x columns array of one block. */
  static async multiInsert(c) {
    const names = Object.keys(c.doc.blocks);
    const n = await c.string('Enter block name', { def: names[0] || '' });
    if (!n || !c.doc.blocks[n]) return c.fail('Block not found.');
    const p = await c.point('Specify insertion point');
    if (!isPt(p)) return;
    const rows = await c.number('Enter number of rows', { def: 2 });
    const cols = await c.number('Enter number of columns', { def: 2 });
    const dy = await c.dist('Enter distance between rows', { def: 10 });
    const dx = await c.dist('Enter distance between columns', { def: 10 });
    for (let r = 0; r < Math.max(1, rows); r += 1)
      for (let k = 0; k < Math.max(1, cols); k += 1)
        c.add(
          c.mk('insert', {
            name: n,
            p: { x: p.x + k * dx, y: p.y + r * dy },
            rot: 0,
            sx: 1,
            sy: 1,
          }),
        );
  }

  // ---------------------------------------------------------------- registration

  /** Registers all commands of this file. */
  static register() {
    def('-LAYER -LA LAYERCMD', SysCommands.layerCmd);
    def('LAYDEL', SysCommands.layerDelete);
    def('LAYMRG', SysCommands.layerMerge);
    def('LAYULKALL', SysCommands.layerUnlockAll);
    def('LAYWALK', SysCommands.layerWalk);
    def('RENAME REN', SysCommands.rename);
    def('-RENAME', SysCommands.renameCmd);
    def('VIEW V', SysCommands.view);
    def('-VIEW', SysCommands.viewCmd);
    def('LIMITS', SysCommands.limits);
    def('UCS', SysCommands.ucs);
    def('UCSWORLD', c=>SysCommands.ucs(c,'World'));
    def('UCSPREV', c=>SysCommands.ucs(c,'Previous'));
    def('UCS3POINT', c=>SysCommands.ucs(c,'3point'));
    def('UCSFACE', c=>SysCommands.ucs(c,'Face'));
    def('UCSVIEW', c=>SysCommands.ucs(c,'View'));
    def('UCSMAN UC', SysCommands.ucs);
    def('PLAN', SysCommands.plan);
    def('REGENAUTO', async (c) => c.echo('REGENAUTO is always on.'));
    def('SETVAR SET', SysCommands.setvar);
    def('UNDO', SysCommands.undo);
    def('MREDO', SysCommands.multiRedo);
    alias('U', 'UNDO1');
    def('UNDO1 U', SysCommands.undoOne);
    def('AUDIT', SysCommands.audit);
    def('RECOVER RECOVERALL', SysCommands.recover);
    def('BASE', SysCommands.base);
    def('DWGPROPS', SysCommands.dwgProps);
    def('DWGUNITS INSUNITS', SysCommands.dwgUnits);
    def('CLEANSCREENON CLEANSCREEN', async (c) => c.app.toggle('cleanScreen'));
    def('CLEANSCREENOFF', async (c) => c.app.set('cleanScreen', false));
    def('TOOLBAR TOOLBARS', SysCommands.toolbars);
    def('FULLSCREEN', SysCommands.fullscreen);
    def('ALIASEDIT', SysCommands.aliasEdit);
    def('REDRAWALL', async (c) => {
      c.bump();
    });
    def('NEWWIN', SysCommands.newWindow);
    def('SAVEALL', SysCommands.saveAll);
    def('CLOSEALL', SysCommands.closeAll);
    def('OPENDWG OPENDXF', SysCommands.openDwg);
    def('EXPORTPDF PDFOUT', SysCommands.exportPdf);
    def('-PURGE', async (c) => {
      setTimeout(() => c.app.exec('PURGE'), 0);
    }); // not awaited: exec() waits for the running command, which is this one
    def('-INSERT', SysCommands.insertCmd);
    def('MINSERT', SysCommands.multiInsert);
  }
}

SysCommands.register();

/* ============================================================================================
 * 5. STARTUP: USER ALIASES
 * ========================================================================================== */

/**
 * Applies the user's own aliases (made in ALIASEDIT) at startup.
 * @param {{aliases?: Object<string, string>}} settings
 */
export function applyCustomAliases(settings) {
  for (const [a, cmd] of Object.entries(settings.aliases || {})) {
    const name = ALIASES[cmd.toLowerCase()] || cmd.toUpperCase();
    if (COMMANDS[name]) ALIASES[a.toLowerCase()] = name;
  }
}
export const _ = { fmtLen, G, E };
