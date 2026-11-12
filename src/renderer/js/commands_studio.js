/**
 * @file commands_studio.js
 * @brief STUDIO / SCENE / MATERIAL / PAINT / LOOK commands.
 *
 * Ready-made materials for solids (glossy plastic, car paint, glass, aluminum, chrome ...), one
 * colour per part, a look for a whole model, and ready-made scenes (white studio, study, sea,
 * factory floor, machining table). The data itself lives in studio.js.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { def as registerCommand } from './registry.js';
const def = (names, fn, opts = {}) => registerCommand(names, fn, { ...opts, feature: '3d' });
import {
  MATERIALS,
  SCENES,
  SCENE_IDS,
  COLORS,
  LOOKS,
  LOOK_IDS,
  parseColor,
  setScene,
  applyMaterial,
  applyPaint,
  applyLook,
} from './studio.js';

/* ============================================================================================
 * 2. KEYWORD LISTS (what the command line offers at each prompt)
 * ========================================================================================== */

/** @returns {string} s with the first letter in upper case. */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const MAT_KW = [...Object.keys(MATERIALS).map(cap), 'Default'];
const SCENE_KW = SCENE_IDS.map(cap);
const COLOR_KW = [...Object.keys(COLORS).map(cap), 'Default'];
const LOOK_KW = [...LOOK_IDS.map(cap), 'Default'];

/* ============================================================================================
 * 3. COMMAND CLASS
 * ========================================================================================== */

/** Materials, scenes and looks for 3D solids. */
export class StudioCommands {
  /** Registers every command of this module. */
  static register() {
    def('STUDIO', StudioCommands.studio);
    def('SCENE', StudioCommands.scene);
    def('MATERIAL MAT', StudioCommands.material);
    def('PAINT', StudioCommands.paint);
    def('LOOK', StudioCommands.look);
  }

  /** STUDIO: opens the Studio dialog. */
  static async studio(c) {
    await c.ui.studioDialog(c);
  }

  /** SCENE: picks the room around the model; "None" turns the scene off. */
  static async scene(c) {
    const o = await c.keyword(`Enter a scene [${SCENE_KW.join('/')}]`, SCENE_KW, null);
    if (!o) return;
    const id = o.toLowerCase();
    setScene(c.app, id);
    const n = c.app.solids().length;
    c.echo(
      id === 'none'
        ? 'Scene off: plain background.'
        : `Scene: ${SCENES[id].label}.${n ? '' : ' It shows as soon as the drawing has 3D solids.'}`,
    );
  }

  /** MATERIAL: gives every solid one of the ready-made materials ("Default" restores each solid's own). */
  static async material(c) {
    const o = await c.keyword(`Enter a material [${MAT_KW.join('/')}]`, MAT_KW, null);
    if (!o) return;
    const key = o === 'Default' ? null : o.toLowerCase();
    const n = applyMaterial(c.app, key);
    c.echo(
      n
        ? `${n} solid(s): ${key ? MATERIALS[key].label : 'default look'}.`
        : 'There are no 3D solids.',
    );
  }

  /** PAINT: paints every solid with a named colour, #rrggbb or r,g,b ("Default" = own colour again). */
  static async paint(c) {
    const s = await c.string(`Enter a colour [${COLOR_KW.join('/')}] or #rrggbb or r,g,b`, {
      def: 'Orange',
    });
    if (s == null) return;
    if (/^(d|default)$/i.test(s.trim())) {
      const n = applyPaint(c.app, null);
      return c.echo(n ? `${n} solid(s): own colour again.` : 'There are no 3D solids.');
    }
    const hex =
      parseColor(s) ||
      parseColor(COLOR_KW.find((k) => k.toLowerCase().startsWith(s.trim().toLowerCase())) || '');
    if (!hex)
      return c.echo(
        `"${s}" is not a colour. Use a name (${Object.keys(COLORS).join(', ')}), #rrggbb or r,g,b.`,
      );
    const n = applyPaint(c.app, hex);
    c.echo(n ? `${n} solid(s) painted ${hex}.` : 'There are no 3D solids.');
  }

  /** LOOK: dresses the whole model (big castings, mid-size parts, small parts) in one ready-made scheme. */
  static async look(c) {
    const o = await c.keyword(`Enter a look [${LOOK_KW.join('/')}]`, LOOK_KW, null);
    if (!o) return;
    if (o === 'Default') {
      const n = applyMaterial(c.app, null);
      applyPaint(c.app, null);
      return c.echo(n ? `${n} solid(s): default look.` : 'There are no 3D solids.');
    }
    const id = o.toLowerCase();
    const n = await applyLook(c.app, id);
    c.echo(n ? `${n} solid(s): ${LOOKS[id].label}. ${LOOKS[id].note}` : 'There are no 3D solids.');
  }
}

StudioCommands.register();
