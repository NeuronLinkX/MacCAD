/**
 * @file commands_alias.js
 * @brief Commands and aliases that complete the default AutoCAD alias table (acad.pgp).
 *
 * test/aliases.test.js checks the whole table, so when an alias is added here the test list must
 * be updated too. This module must be imported after the command modules it adds aliases for.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { def, alias } from './registry.js';

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Dimension variables DIMOVERRIDE accepts, mapped to the field stored on the dimension entity. */
const DIMVARS = {
  DIMTXT: 'h', //     text height
  DIMASZ: 'asz', //   arrow size
  DIMEXO: 'eo', //    extension line offset
  DIMEXE: 'ee', //    extension line extension
  DIMGAP: 'gap', //   text gap
  DIMSCALE: 'scale', // overall scale
  DIMDEC: 'prec', //  decimal places
};

/* ============================================================================================
 * 3. COMMAND CLASS
 * ========================================================================================== */

/** Extra commands and aliases that make the command line behave like AutoCAD's. */
export class AliasCommands {
  /** Registers every command and alias of this module. */
  static register() {
    def('REDRAW R', AliasCommands.redraw);
    def('ROUND RND', async (c) => AliasCommands.later(c, 'FILLETEDGE'));
    def('REGENALL REA', AliasCommands.regenAll);
    AliasCommands.registerPlainAliases();
    def('HISTORY NAV PN', AliasCommands.history);
    def('FILTER FI', async (c) => AliasCommands.later(c, 'QSELECT'));
    def('DDGRIPS GR', async (c) => AliasCommands.later(c, 'OPTIONS'));
    def('IMPORT IMP', AliasCommands.importFile);
    def('HIDE HI', AliasCommands.hide);
    def('TILEMODE TI', AliasCommands.tileMode);
    def('THICKNESS TH', AliasCommands.thickness);
    def('SPELL SP', AliasCommands.spell);
    def('DIMOVERRIDE DOV', AliasCommands.dimOverride);
  }

  /** Plain "typed name -> existing command" aliases, no handler of their own. */
  static registerPlainAliases() {
    alias('ra', 'REDRAWALL');
    alias('rectangle', 'RECTANG');
    alias('qsave', 'SAVE');
    alias('pastespec', 'PASTECLIP');
    alias('pa', 'PASTECLIP');
    alias('sha', 'VSCURRENT');
    alias('lo', 'LAYOUT');
    alias('to', 'TOOLBAR');
    alias('sn', '-SNAP');
    alias('qleader', 'LEADER');
    alias('fs', 'FLATSHOT'); // 3D view -> 2D lines (SOLVIEW / SOLDRAW)
    alias('gs', 'GRIDSTYLE'); // grid as lines or dots
  }

  /**
   * Runs another command after the current one has finished.
   * (A command must never wait for another command from inside itself: the app would hang in the
   * "running" state, so the follow-up is scheduled instead.)
   * @param {object} c command context
   * @param {string} name command to run
   * @param {*} [arg] optional argument for it
   */
  static later(c, name, arg) {
    setTimeout(() => c.app.exec(name, arg), 0);
  }

  /** SPELL: edits selected annotation text in a native spellcheck-enabled field. */
  static async spell(c){
    const ents=await c.select('Select text, multiline text or dimensions to check',{filter:e=>e.type==='text'||e.type==='mtext'||e.type==='dim'});if(!ents.length)return;
    let changed=0;for(const e of ents){const key=e.type==='dim'?'text':'str',current=e[key]??(e.type==='dim'?'<>':'');const body=document.createElement('div'),area=document.createElement('textarea');area.value=current;area.spellcheck=true;area.lang=navigator.language||'en';area.rows=5;area.style.width='420px';body.append('Use the red underlines and the macOS context menu to correct spelling.',area);const value=await c.ui.dialog({title:'Spelling',body,collect:()=>area.value});if(value!==null&&value!==undefined&&value!==current){e[key]=value==='<>'&&e.type==='dim'?null:value;changed++;}}
    if(changed)c.bump();c.echo(`SPELL: checked ${ents.length} annotation(s), updated ${changed}.`);
  }

  /**
   * REDRAW / R. R is REDRAW in AutoCAD, but in a 3D view with solids it means "round": pick edges
   * and give a radius (same as FE / ROUND).
   */
  static async redraw(c) {
    if (c.app.v3 && c.app.solids().length) {
      c.echo('Round: select the edges to round.');
      AliasCommands.later(c, 'FILLETEDGE');
      return;
    }
    c.bump();
  }

  /** REGENALL: regenerates the drawing (everything is redrawn from the data anyway). */
  static async regenAll(c) {
    c.bump();
    c.echo('Regenerating model.');
  }

  /** HISTORY / NAV: shows or hides the model history panel. */
  static async history(c) {
    if (c.ui.toggleHistory) c.ui.toggleHistory();
  }

  /** IMPORT: asks for the file type, then runs the matching import command. */
  static async importFile(c) {
    const k = await c.keyword('Import file type [DXF/PDF/STEP]', ['DXF', 'PDF', 'STEP'], 'DXF');
    if (!k) return;
    AliasCommands.later(c, k === 'PDF' ? 'PDFIMPORT' : k === 'STEP' ? 'STEPIN' : 'DXFIN');
  }

  /** HIDE: hidden-line view; only meaningful in the 3D view. */
  static async hide(c) {
    if (!c.app.v3)
      return c.echo(
        'HIDE removes hidden lines in a 3D view. Type 3D first to switch to the 3D view.',
      );
    c.app.setVisualStyle('hidden');
  }

  /** TILEMODE: 1 = model space, 0 = the first paper-space layout. */
  static async tileMode(c) {
    const v = await c.number('Enter new value for TILEMODE', {
      def: c.app.space === 'model' ? 1 : 0,
    });
    if (typeof v !== 'number') return;
    if (v === 1) c.app.switchSpace('model');
    else {
      const names = Object.keys(c.doc.layouts);
      if (names.length) c.app.switchSpace(names[0]);
    }
  }

  /** THICKNESS: stored with the drawing only; solids are made with EXTRUDE. */
  static async thickness(c) {
    const v = await c.number('Enter new value for THICKNESS', { def: c.doc.thickness || 0 });
    if (typeof v !== 'number') return;
    c.doc.thickness = v;
    c.echo(
      'THICKNESS is stored with the drawing; it is not rendered as height in this version. Use EXTRUDE for 3D.',
    );
  }

  /**
   * DIMOVERRIDE: per-dimension overrides of the dimension style (text height, arrow size, offsets,
   * scale, precision). Asks for variable / value pairs until an empty answer, then for the
   * dimensions; "Clear" removes the overrides instead.
   */
  static async dimOverride(c) {
    const ov = {};
    let clear = false;
    for (;;) {
      const t = await c.string('Enter dimension variable name to override or [Clear overrides]', {
        def: null,
      });
      if (t === null || t === '') break;
      if (/^c/i.test(t)) {
        clear = true;
        break;
      }
      const key = DIMVARS[t.trim().toUpperCase()];
      if (!key) {
        c.echo(`Unknown dimension variable. Available: ${Object.keys(DIMVARS).join(', ')}`);
        continue;
      }
      const val = await c.number(`Enter new value for dimension variable ${t.toUpperCase()}`);
      if (typeof val !== 'number') return;
      ov[key] = val;
    }
    if (!clear && !Object.keys(ov).length) return;
    const ents = await c.select('Select objects', { filter: (e) => e.type === 'dim' });
    if (!ents.length) return;
    for (const e of ents) {
      if (clear) delete e.ov;
      else e.ov = { ...(e.ov || {}), ...ov };
    }
    c.bump();
    c.echo(`${ents.length} dimension(s) ${clear ? 'cleared of overrides' : 'overridden'}.`);
  }
}

AliasCommands.register();
