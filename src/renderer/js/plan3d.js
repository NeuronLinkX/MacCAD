/**
 * @file plan3d.js
 * @brief AI 3D modelling: a "plan" is a short list of modelling steps in JSON.
 *
 * A language model can write that reliably (the format is small, it is enforced by a JSON schema
 * and every number is checked), and THIS program builds the solid with the OpenCascade kernel. The
 * model never touches the drawing.
 *
 *   { "name": "flange", "steps": [ {"id":"disc","op":"cylinder","r":40,"h":12}, {"id":"hole","op":"cylinder","r":20,"h":12}, {"id":"f","op":"subtract","a":"disc","b":["hole"]} ], "result": "f" }
 *
 * Units are millimetres, Z is up. Pure functions + the kernel: tested in test/plan3d.test.js.
 * The schema and the prompts are plain constants; the work is done by three classes:
 * PlanValidator (checks the model's answer), PlanBuilder (builds the solid) and AutoModeler (asks
 * the model, repairs the answer and builds it).
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import * as K from './kernel3d.js';
import { holesOf } from './reference3d.js';
export const OPS = [
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'polygon',
  'revolve',
  'extrude_outline',
  'extrude_circle',
  'tube',
  'prism',
  'section',
  'gear',
  'union',
  'subtract',
  'intersect',
  'hole',
  'hole_circle',
  'pocket',
  'shell',
  'fillet',
  'chamfer',
  'move',
  'rotate',
  'mirror',
  'linear_array',
  'polar_array',
];
export const SECTIONS = ['L', 'U', 'T', 'I'];
const FEATURES = ['hole', 'hole_circle', 'pocket', 'shell', 'fillet', 'chamfer'];
export const EDGE_SETS = ['all', 'vertical', 'top', 'bottom', 'top_bottom'];
const num = { type: 'number' };
const vec3 = { type: 'array', items: num, minItems: 3, maxItems: 3 };
const vec2 = { type: 'array', items: num, minItems: 2, maxItems: 2 };
// JSON schema handed to the model server (Ollama "format" / OpenAI json_schema): the model can only answer in this shape, and every op has exactly its own fields
const AX = { type: 'string', enum: ['x', 'y', 'z'] };
const ES = { type: 'string', enum: EDGE_SETS };
const step = (op, props, required) => ({
  type: 'object',
  properties: { id: { type: 'string' }, op: { type: 'string', enum: [op] }, ...props },
  required: ['id', 'op', ...required],
  additionalProperties: false,
});
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        anyOf: [
          step('box', { size: vec3, at: vec3 }, ['size', 'at']),
          step('cylinder', { r: num, h: num, at: vec3, axis: AX }, ['r', 'h', 'at', 'axis']),
          step('sphere', { r: num, at: vec3 }, ['r', 'at']),
          step('cone', { r1: num, r2: num, h: num, at: vec3, axis: AX }, [
            'r1',
            'r2',
            'h',
            'at',
            'axis',
          ]),
          step('torus', { R: num, r: num, at: vec3 }, ['R', 'r', 'at']),
          step(
            'polygon',
            { points: { type: 'array', items: vec2, minItems: 3 }, h: num, at: vec3 },
            ['points', 'h', 'at'],
          ),
          step('revolve', { profile: { type: 'array', items: vec2, minItems: 3 }, at: vec3 }, [
            'profile',
            'at',
          ]),
          step(
            'extrude_outline',
            { outline: { type: 'string' }, h: num, z: num, holes: { type: 'boolean' } },
            ['outline', 'h', 'z', 'holes'],
          ),
          step('extrude_circle', { circle: { type: 'string' }, h: num, z: num }, [
            'circle',
            'h',
            'z',
          ]),
          step('tube', { ro: num, ri: num, h: num, at: vec3, axis: AX }, [
            'ro',
            'ri',
            'h',
            'at',
            'axis',
          ]),
          step(
            'prism',
            { sides: { type: 'integer' }, across_flats: num, h: num, at: vec3, hole_r: num },
            ['sides', 'across_flats', 'h', 'at'],
          ),
          step(
            'section',
            {
              shape: { type: 'string', enum: SECTIONS },
              w: num,
              hgt: num,
              t: num,
              len: num,
              at: vec3,
            },
            ['shape', 'w', 'hgt', 't', 'len', 'at'],
          ),
          step('gear', { teeth: { type: 'integer' }, module: num, h: num, bore_r: num, at: vec3 }, [
            'teeth',
            'module',
            'h',
            'at',
          ]),
          step(
            'union',
            { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' }, minItems: 1 } },
            ['a', 'b'],
          ),
          step(
            'subtract',
            { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' }, minItems: 1 } },
            ['a', 'b'],
          ),
          step(
            'intersect',
            { a: { type: 'string' }, b: { type: 'array', items: { type: 'string' }, minItems: 1 } },
            ['a', 'b'],
          ),
          step(
            'hole',
            {
              of: { type: 'string' },
              at: { type: 'array', items: vec2, minItems: 1 },
              r: num,
              depth: num,
              from: { type: 'string', enum: ['top', 'bottom'] },
            },
            ['of', 'at', 'r', 'depth', 'from'],
          ),
          step(
            'hole_circle',
            {
              of: { type: 'string' },
              center: vec2,
              R: num,
              count: { type: 'integer' },
              r: num,
              depth: num,
              from: { type: 'string', enum: ['top', 'bottom'] },
            },
            ['of', 'center', 'R', 'count', 'r', 'depth', 'from'],
          ),
          step(
            'pocket',
            {
              of: { type: 'string' },
              at: vec2,
              size: vec2,
              depth: num,
              from: { type: 'string', enum: ['top', 'bottom'] },
            },
            ['of', 'at', 'size', 'depth', 'from'],
          ),
          step(
            'shell',
            { of: { type: 'string' }, t: num, open: { type: 'string', enum: ['top', 'bottom'] } },
            ['of', 't', 'open'],
          ),
          step('fillet', { of: { type: 'string' }, r: num, edges: ES }, ['of', 'r', 'edges']),
          step('chamfer', { of: { type: 'string' }, d: num, edges: ES }, ['of', 'd', 'edges']),
          step('move', { of: { type: 'string' }, by: vec3 }, ['of', 'by']),
          step('rotate', { of: { type: 'string' }, deg: num, axis: AX, center: vec3 }, [
            'of',
            'deg',
            'axis',
            'center',
          ]),
          step(
            'mirror',
            { of: { type: 'string' }, plane: { type: 'string', enum: ['xy', 'yz', 'xz'] } },
            ['of', 'plane'],
          ),
          step('linear_array', { of: { type: 'string' }, count: { type: 'integer' }, step: vec3 }, [
            'of',
            'count',
            'step',
          ]),
          step(
            'polar_array',
            { of: { type: 'string' }, count: { type: 'integer' }, center: vec3, deg: num },
            ['of', 'count', 'center', 'deg'],
          ),
        ],
      },
    },
    result: { type: 'string' },
  },
  required: ['name', 'steps', 'result'],
};
// the instructions for the model
export const PLAN_PROMPT = `You are the 3D modelling engine of a CAD program. Turn the user's request into a JSON modelling plan. Reply with JSON only.
Units: millimetres. Axes: X right, Y back, Z up. A plan is {"name": short name, "steps": [...], "result": id of the final step}.
Every step has a unique "id" and an "op"; later steps refer to earlier ids. Keep the plan short (usually 1 to 8 steps). Prefer the ready-made ops over building shapes by hand.
Base shapes:
- box:       "size":[x,y,z], "at":[x,y,z] = corner with the smallest coordinates.
- cylinder:  "r", "h", "at" = centre of the first end, "axis":"z"|"x"|"y" (direction of the height).
- sphere:    "r", "at" = centre.        - cone: "r1" base radius, "r2" top radius (0 = point), "h", "at", "axis".        - torus: "R" ring radius, "r" tube radius, "at".
- tube:      pipe / bush / washer / ring: "ro" outer radius, "ri" inner radius, "h", "at" = centre of the first end, "axis".
- prism:     regular polygon prism: "sides" (6 = hexagon nut/bolt head), "across_flats" = distance between opposite flat sides, "h", "at" = centre of the bottom, optional "hole_r" = hole through the middle.
- section:   rolled profile: "shape" "L"|"U"|"T"|"I", "w" width, "hgt" height, "t" wall thickness, "len" length (extruded upward), "at" = corner. For angles, channels, beams, brackets.
- gear:      spur gear: "teeth", "module", "h" thickness, optional "bore_r", "at" = centre of the bottom.
- polygon:   any outline: "points":[[x,y],...] in order, "h" thickness upward, "at":[0,0,z]. 
- revolve:   "profile":[[r,z],...] closed outline (r >= 0) turned around the vertical axis through "at". For shafts, pulleys, bowls.
Features (these change an existing solid "of" and need the whole top/bottom of it, they work on the vertical axis):
- hole:        "of", "at":[[x,y],...] every hole centre, "r" radius, "depth" (0 = through), "from":"top"|"bottom".
- hole_circle: "of", "center":[x,y], "R" radius of the circle the holes sit on, "count", "r" hole radius, "depth" (0 = through), "from".
- pocket:      rectangular recess: "of", "at":[x,y] corner, "size":[w,d], "depth", "from".
- shell:       hollow out: "of", "t" wall thickness, "open":"top"|"bottom" = the side left open.
- fillet: "of", "r", "edges":"all"|"vertical"|"top"|"bottom"|"top_bottom".   chamfer: "of", "d", "edges".   (r / d must be smaller than half of the thinnest wall)
Combine: union / subtract / intersect: "a": id, "b": [ids]. Transform: move "of","by":[dx,dy,dz]; rotate "of","deg","axis","center"; mirror "of","plane" (adds the mirror image); linear_array "of","count","step":[dx,dy,dz]; polar_array "of","count","center":[x,y,z],"deg":360 (copies are joined, use before subtract).
Rules: use the exact numbers of the request. People give DIAMETERS (지름, dia, Ø): every "r", "ri", "ro", "hole_r", "R" is a RADIUS = diameter / 2. Use "hole" for holes at given positions (list every centre) and "hole_circle" only for holes on a circle (bolt circle). Every feature step (hole, hole_circle, pocket, shell, fillet, chamfer) uses the PREVIOUS step as "of", so the features add up. Fillet / chamfer come last; "result" is the last step.
Examples:
"50 x 30 x 10 plate, 10 mm hole in the middle, corners rounded R4": {"name":"plate","steps":[{"id":"p","op":"box","size":[50,30,10],"at":[0,0,0]},{"id":"h","op":"hole","of":"p","at":[[25,15]],"r":5,"depth":0,"from":"top"},{"id":"f","op":"fillet","of":"h","r":4,"edges":"vertical"}],"result":"f"}
"disc diameter 60, 8 thick, 4 holes of diameter 6 on a 40 mm circle": {"name":"disc","steps":[{"id":"d","op":"cylinder","r":30,"h":8,"at":[0,0,0],"axis":"z"},{"id":"b","op":"hole_circle","of":"d","center":[0,0],"R":20,"count":4,"r":3,"depth":0,"from":"top"}],"result":"b"}
"plate 100 x 60 x 10 with four holes of diameter 8, 10 mm from the corners": {"name":"plate","steps":[{"id":"p","op":"box","size":[100,60,10],"at":[0,0,0]},{"id":"h","op":"hole","of":"p","at":[[10,10],[90,10],[10,50],[90,50]],"r":4,"depth":0,"from":"top"}],"result":"h"}
"open box 80 x 50 x 30, walls 3": {"name":"box","steps":[{"id":"b","op":"box","size":[80,50,30],"at":[0,0,0]},{"id":"s","op":"shell","of":"b","t":3,"open":"top"}],"result":"s"}
"hex nut M10, 17 across flats, 8 thick": {"name":"nut","steps":[{"id":"n","op":"prism","sides":6,"across_flats":17,"h":8,"at":[0,0,0],"hole_r":4.2}],"result":"n"}
"L bracket, legs 60 and 40, 5 thick, 20 long": {"name":"bracket","steps":[{"id":"l","op":"section","shape":"L","w":60,"hgt":40,"t":5,"len":20,"at":[0,0,0]}],"result":"l"}
"stepped shaft: diameter 20 length 30, then diameter 30 length 40": {"name":"shaft","steps":[{"id":"a","op":"cylinder","r":10,"h":30,"at":[0,0,0],"axis":"z"},{"id":"b","op":"cylinder","r":15,"h":40,"at":[0,0,30],"axis":"z"},{"id":"u","op":"union","a":"a","b":["b"]}],"result":"u"}`;
export const REF_PROMPT = `
A reference drawing is given in the user's message: outlines P1, P2, ... and circles C1, C2, ... with their real coordinates. Build from it instead of retyping numbers:
- extrude_outline: "outline": id (P1), "h": thickness, "z": height of the bottom (usually 0), "holes": true = every circle and smaller outline INSIDE that outline is cut out as a hole automatically. This is the plate of the drawing.
- extrude_circle: "circle": id (C1), "h", "z": a round boss or pin at that circle.
Use the thickness or height the user names (or a note in the reference such as "t10" / "t=10"). Features that are not in the drawing (fillets, chamfers, extra holes) are added with the usual steps. The solid keeps the drawing's coordinates.`;
// ------------------------------------------------------------------ validation: the model's plan -> a clean plan, or a list of problems it can fix
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const vecOf = (v, n, def) =>
  Array.isArray(v) && v.length >= n && v.slice(0, n).every(isNum) ? v.slice(0, n) : def;
const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
// ------------------------------------------------------------------ building
const AXIS_DIR = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const near = (a, b, t) => Math.abs(a - b) <= t;

/* ============================================================================================
 * 2. PLANVALIDATOR
 * ========================================================================================== */

/** Checks the model's answer and turns it into a clean plan, or a list of problems that the model can fix. */
export class PlanValidator {
  /** Validates the model's plan. @returns {{plan: object|null, errors: string[], warnings: string[]}} */
  static validate(raw, { ref: drawingRef = null } = {}) {
    const errors = [];
    const warnings = [];
    if (!raw || typeof raw !== 'object')
      return { plan: null, errors: ['The answer is not a plan object.'], warnings };
    const steps = Array.isArray(raw.steps) ? raw.steps : null;
    if (!steps || !steps.length)
      return { plan: null, errors: ['The plan has no "steps".'], warnings };
    if (steps.length > 60)
      return { plan: null, errors: ['The plan has too many steps (limit 60).'], warnings };
    const seen = new Map();
    const out = [];
    const latest = new Map(); // latest: base id -> the newest feature step built on it
    steps.forEach((s0, i) => {
      const s = { ...s0 };
      const tag = `step ${i + 1}`;
      if (!s || typeof s !== 'object' || !OPS.includes(s.op)) {
        errors.push(`${tag}: unknown op "${s && s.op}". Use one of: ${OPS.join(', ')}.`);
        return;
      }
      s.id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${i + 1}`;
      if (seen.has(s.id)) {
        errors.push(`${tag}: the id "${s.id}" is used twice.`);
        return;
      }
      const need = (cond, msg) => {
        if (!cond) errors.push(`${tag} (${s.op} "${s.id}"): ${msg}`);
        return cond;
      };
      const pos = (k) => need(isNum(s[k]) && s[k] > 0, `"${k}" must be a number greater than 0.`);
      const ref = (k) => {
        const id = s[k];
        const ok = typeof id === 'string' && seen.has(id);
        need(
          ok,
          `"${k}" must be the id of an EARLIER step (got ${JSON.stringify(id)}; available: ${[...seen.keys()].join(', ') || 'none'}).`,
        );
        return ok;
      };
      if (!['hole', 'hole_circle', 'pocket'].includes(s.op))
        s.at = vecOf(s.at, 3, vecOf(s.at, 2, null) ? [...s.at.slice(0, 2), 0] : [0, 0, 0]);
      switch (s.op) {
        case 'box': {
          const sz = vecOf(s.size, 3, null);
          if (
            need(
              sz && sz.every((x) => x > 0),
              '"size" must be [width, depth, height], all greater than 0.',
            )
          )
            s.size = sz;
          break;
        }
        case 'cylinder':
          pos('r');
          pos('h');
          s.axis = ['x', 'y', 'z'].includes(s.axis) ? s.axis : 'z';
          break;
        case 'sphere':
          pos('r');
          break;
        case 'cone':
          need(isNum(s.r1) && s.r1 >= 0, '"r1" must be a number >= 0.');
          need(isNum(s.r2) && s.r2 >= 0, '"r2" must be a number >= 0.');
          need((s.r1 || 0) + (s.r2 || 0) > 0, 'r1 and r2 cannot both be 0.');
          pos('h');
          s.axis = ['x', 'y', 'z'].includes(s.axis) ? s.axis : 'z';
          break;
        case 'torus':
          pos('R');
          pos('r');
          need(!(s.r >= s.R), '"r" (tube) must be smaller than "R" (ring).');
          break;
        case 'polygon': {
          const p = Array.isArray(s.points)
            ? s.points.filter((q) => vecOf(q, 2, null)).map((q) => [q[0], q[1]])
            : [];
          if (need(p.length >= 3, '"points" needs at least 3 [x,y] points.')) {
            while (p.length > 3 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1])
              p.pop();
            s.points = p;
          }
          pos('h');
          break;
        }
        case 'revolve': {
          const p = Array.isArray(s.profile)
            ? s.profile.filter((q) => vecOf(q, 2, null)).map((q) => [q[0], q[1]])
            : [];
          if (
            need(p.length >= 3, '"profile" needs at least 3 [r,z] points.') &&
            need(
              p.every((q) => q[0] >= 0),
              'every r in "profile" must be >= 0.',
            ) &&
            need(
              p.some((q) => q[0] > 0),
              '"profile" needs a point with r > 0.',
            )
          )
            s.profile = p;
          break;
        }
        case 'extrude_outline': {
          need(
            drawingRef && !drawingRef.empty,
            'there is no reference drawing: use polygon with explicit points instead.',
          );
          if (drawingRef)
            need(
              typeof s.outline === 'string' && drawingRef.outlines[s.outline],
              `"outline" must be one of: ${Object.keys(drawingRef.outlines).join(', ') || '(no outlines in the reference)'}.`,
            );
          pos('h');
          s.z = isNum(s.z) ? s.z : 0;
          s.holes = s.holes !== false;
          break;
        }
        case 'extrude_circle': {
          need(
            drawingRef && !drawingRef.empty,
            'there is no reference drawing: use cylinder with explicit numbers instead.',
          );
          if (drawingRef)
            need(
              typeof s.circle === 'string' && drawingRef.circles[s.circle],
              `"circle" must be one of: ${Object.keys(drawingRef.circles).join(', ') || '(no circles in the reference)'}.`,
            );
          pos('h');
          s.z = isNum(s.z) ? s.z : 0;
          break;
        }
        case 'tube':
          pos('ro');
          need(isNum(s.ri) && s.ri >= 0 && s.ri < s.ro, '"ri" must be >= 0 and smaller than "ro".');
          pos('h');
          s.axis = ['x', 'y', 'z'].includes(s.axis) ? s.axis : 'z';
          break;
        case 'prism':
          need(
            Number.isInteger(s.sides) && s.sides >= 3 && s.sides <= 64,
            '"sides" must be a whole number from 3 to 64.',
          );
          pos('across_flats');
          pos('h');
          if (s.hole_r != null)
            need(
              isNum(s.hole_r) && s.hole_r >= 0 && s.hole_r * 2 <= 0.8 * s.across_flats,
              '"hole_r" is a RADIUS and must be at most 0.4 x "across_flats" (did you give the diameter? use diameter / 2).',
            );
          break;
        case 'section':
          need(SECTIONS.includes(s.shape), `"shape" must be one of ${SECTIONS.join(', ')}.`);
          pos('w');
          pos('hgt');
          pos('t');
          pos('len');
          need(!(s.t * 2 >= Math.min(s.w, s.hgt)), '"t" is too large for "w" and "hgt".');
          break;
        case 'gear':
          need(
            Number.isInteger(s.teeth) && s.teeth >= 6 && s.teeth <= 200,
            '"teeth" must be a whole number from 6 to 200.',
          );
          pos('module');
          pos('h');
          if (s.bore_r != null && s.bore_r > 0)
            need(
              s.bore_r < (s.module * (s.teeth - 2.5)) / 2 - 1,
              '"bore_r" is too large for this gear.',
            );
          break;
        case 'hole': {
          ref('of');
          pos('r');
          const pts =
            Array.isArray(s.at) && Array.isArray(s.at[0])
              ? s.at.filter((q) => vecOf(q, 2, null)).map((q) => [q[0], q[1]])
              : vecOf(s.at, 2, null)
                ? [s.at.slice(0, 2)]
                : [];
          if (need(pts.length > 0, '"at" must list the hole centres as [[x,y],...].')) s.at = pts;
          s.depth = isNum(s.depth) && s.depth > 0 ? s.depth : 0;
          s.from = s.from === 'bottom' ? 'bottom' : 'top';
          break;
        }
        case 'hole_circle': {
          ref('of');
          pos('r');
          pos('R');
          need(
            Number.isInteger(s.count) && s.count >= 1 && s.count <= 100,
            '"count" must be a whole number from 1 to 100.',
          );
          s.center = vecOf(s.center, 2, vecOf(s.at, 2, [0, 0]));
          s.start = isNum(s.start) ? s.start : 0;
          s.depth = isNum(s.depth) && s.depth > 0 ? s.depth : 0;
          s.from = s.from === 'bottom' ? 'bottom' : 'top';
          break;
        }
        case 'pocket': {
          ref('of');
          const at = vecOf(s.at, 2, null);
          const sz = vecOf(s.size, 2, null);
          need(at, '"at" must be the corner [x,y].');
          need(sz && sz.every((x) => x > 0), '"size" must be [width, depth], both greater than 0.');
          pos('depth');
          s.from = s.from === 'bottom' ? 'bottom' : 'top';
          break;
        }
        case 'shell':
          ref('of');
          pos('t');
          s.open = s.open === 'bottom' ? 'bottom' : 'top';
          break;
        case 'union':
        case 'subtract':
        case 'intersect': {
          ref('a');
          s.b = asList(s.b);
          if (need(s.b.length > 0, '"b" must list at least one id.'))
            for (const id of s.b)
              need(seen.has(id), `"b" contains "${id}", which is not an earlier step.`);
          break;
        }
        case 'fillet':
          ref('of');
          pos('r');
          s.edges = EDGE_SETS.includes(s.edges) ? s.edges : 'all';
          break;
        case 'chamfer':
          ref('of');
          if (!isNum(s.d) && isNum(s.r)) s.d = s.r;
          pos('d');
          s.edges = EDGE_SETS.includes(s.edges) ? s.edges : 'all';
          break;
        case 'move':
          ref('of');
          s.by = vecOf(s.by, 3, vecOf(s.by, 2, null) ? [...s.by.slice(0, 2), 0] : null);
          need(s.by, '"by" must be [dx, dy, dz].');
          break;
        case 'rotate':
          ref('of');
          need(isNum(s.deg), '"deg" must be a number.');
          s.axis = ['x', 'y', 'z'].includes(s.axis) ? s.axis : 'z';
          s.center = vecOf(s.center, 3, [0, 0, 0]);
          break;
        case 'mirror':
          ref('of');
          s.plane = ['xy', 'yz', 'xz'].includes(s.plane) ? s.plane : 'yz';
          break;
        case 'linear_array':
          ref('of');
          need(
            Number.isInteger(s.count) && s.count >= 2 && s.count <= 200,
            '"count" must be a whole number from 2 to 200.',
          );
          s.step = vecOf(s.step, 3, vecOf(s.step, 2, null) ? [...s.step.slice(0, 2), 0] : null);
          need(s.step, '"step" must be [dx, dy, dz].');
          break;
        case 'polar_array':
          ref('of');
          need(
            Number.isInteger(s.count) && s.count >= 2 && s.count <= 200,
            '"count" must be a whole number from 2 to 200.',
          );
          s.center = vecOf(s.center, 3, [0, 0, 0]);
          s.deg = isNum(s.deg) && s.deg !== 0 ? s.deg : 360;
          break;
        default:
          break;
      }
      if (FEATURES.includes(s.op) && typeof s.of === 'string' && seen.has(s.of)) {
        // two features on the same base: the second one goes on top of the first (the model forgot to chain them)
        if (latest.has(s.of) && latest.get(s.of) !== s.id) {
          warnings.push(
            `step ${i + 1} (${s.op} "${s.id}") is applied on top of "${latest.get(s.of)}", so the earlier feature is kept.`,
          );
          const base = s.of;
          s.of = latest.get(base);
          latest.set(base, s.id);
        } else latest.set(s.of, s.id);
      }
      seen.set(s.id, s);
      out.push(s);
    });
    let result = typeof raw.result === 'string' ? raw.result.trim() : '';
    if (!result || !seen.has(result)) {
      if (result)
        warnings.push(`"result" ${JSON.stringify(result)} is not a step; the last step is used.`);
      result = out.length ? out[out.length - 1].id : '';
    }
    if (errors.length) return { plan: null, errors, warnings };
    return {
      plan: { name: String(raw.name || 'model').slice(0, 60), steps: out, result },
      errors,
      warnings,
    };
  }
}

/* ============================================================================================
 * 3. PLANBUILDER
 * ========================================================================================== */

/** Builds the solid of a validated plan with the kernel. */
export class PlanBuilder {
  // a shape built along +Z at the origin -> pointing along axis, base at "at"
  /** @private Turns a shape built along +Z at the origin so that it points along `axis` with its base at `at`. */
  static orient(shape, axis, at) {
    let s = shape;
    if (axis === 'x') s = s.rotate(90, [0, 0, 0], [0, 1, 0]);
    else if (axis === 'y') s = s.rotate(-90, [0, 0, 0], [1, 0, 0]);
    return s.translate(at[0], at[1], at[2]);
  }

  /** @private The size of a shape's bounding box: [dx, dy, dz]. */
  static sizeOf(shape) {
    const b = shape.boundingBox.bounds;
    return [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]];
  }

  // edge selection by position: the ids (hash codes) of the edges of a shape
  /** The ids (hash codes) of the edges of a shape that belong to an edge set (selection by position). */
  static edgeIds(shape, set) {
    const b = shape.boundingBox.bounds;
    const tol = 1e-4 * Math.max(1, ...PlanBuilder.sizeOf(shape));
    const zmin = b[0][2];
    const zmax = b[1][2];
    const ids = [];
    for (const e of shape.edges) {
      const eb = e.boundingBox.bounds;
      const z0 = eb[0][2];
      const z1 = eb[1][2];
      const flat = near(z0, z1, tol);
      const top = flat && near(z1, zmax, tol);
      const bottom = flat && near(z0, zmin, tol);
      const vertical =
        near(eb[0][0], eb[1][0], tol) && near(eb[0][1], eb[1][1], tol) && z1 - z0 > tol;
      if (
        set === 'all' ||
        (set === 'vertical' && vertical) ||
        (set === 'top' && top) ||
        (set === 'bottom' && bottom) ||
        (set === 'top_bottom' && (top || bottom))
      )
        ids.push(e.hashCode);
    }
    return ids;
  }

  // round / chamfer with a size the kernel can digest: too large a value can make OpenCascade run for ever, so it is limited first and halved if it fails
  /** @private Fillets or chamfers edges; a value that does not fit is reduced and reported in `warnings`. */
  static dress(shape, kind, value, set, warnings, tag) {
    const ids = PlanBuilder.edgeIds(shape, set);
    if (!ids.length) {
      warnings.push(`${tag}: there are no ${set} edges to ${kind}; skipped.`);
      return shape;
    }
    const limit = 0.45 * Math.min(...PlanBuilder.sizeOf(shape));
    let v = value;
    if (v > limit) {
      warnings.push(
        `${tag}: ${kind} ${+value.toPrecision(4)} is too large for this part, ${+limit.toPrecision(3)} is used.`,
      );
      v = limit;
    }
    let lastErr = null;
    for (let k = 0; k < 4; k += 1) {
      try {
        return kind === 'fillet' ? K.filletEdges(shape, v, ids) : K.chamferEdges(shape, v, ids);
      } catch (err) {
        lastErr = err;
        v *= 0.5;
        warnings.push(`${tag}: ${kind} failed, trying ${+v.toPrecision(3)}.`);
      }
    }
    warnings.push(
      `${tag}: the ${kind} could not be made (${(lastErr && lastErr.message) || 'kernel error'}), so it was left out.`,
    );
    return shape;
  }

  // a hole whose diameter is as large as the part (or a bolt circle larger than the part) is almost surely a diameter given as a radius: the model gets to fix it
  /** @private Throws when a radius does not fit into a shape. */
  static fitCheck(shape, r, tag, R = 0) {
    const b = shape.boundingBox.bounds;
    const w = b[1][0] - b[0][0];
    const d = b[1][1] - b[0][1];
    if (
      R > 0 &&
      R + r > 0.55 * Math.max(w, d) + 1e-9 &&
      R + r > 0.55 * Math.min(w, d) + 1e-9 &&
      2 * (R + r) > 1.02 * Math.max(w, d)
    )
      throw new Error(
        `${tag}: the circle of holes (R${+R.toFixed(3)} + r${+r.toFixed(3)}) does not fit in the part (${+w.toFixed(2)} x ${+d.toFixed(2)}). "R" and "r" are radii (half of the diameters).`,
      );
    if (!R && 2 * r >= 0.95 * Math.min(w, d))
      throw new Error(
        `${tag}: a hole of diameter ${+(2 * r).toFixed(3)} does not fit in a part ${+w.toFixed(2)} x ${+d.toFixed(2)}. "r" is a RADIUS (half of the diameter).`,
      );
  }

  // L / U / T / I profiles in the XY plane (origin at the lower left), extruded upward by len
  /** @private A structural section (I-beam, channel, angle, tube, ...) as a solid. */
  static sectionShape(s) {
    const { w, hgt: H, t } = s;
    let pts;
    if (s.shape === 'L')
      pts = [
        [0, 0],
        [w, 0],
        [w, t],
        [t, t],
        [t, H],
        [0, H],
      ];
    else if (s.shape === 'U')
      pts = [
        [0, 0],
        [w, 0],
        [w, H],
        [w - t, H],
        [w - t, t],
        [t, t],
        [t, H],
        [0, H],
      ];
    else if (s.shape === 'T') {
      const x0 = (w - t) / 2;
      pts = [
        [0, H],
        [0, H - t],
        [x0, H - t],
        [x0, 0],
        [x0 + t, 0],
        [x0 + t, H - t],
        [w, H - t],
        [w, H],
      ];
    } else {
      const x0 = (w - t) / 2;
      pts = [
        [0, 0],
        [w, 0],
        [w, t],
        [x0 + t, t],
        [x0 + t, H - t],
        [w, H - t],
        [w, H],
        [0, H],
        [0, H - t],
        [x0, H - t],
        [x0, t],
        [0, t],
      ];
    }
    return K.extrudeSketch(
      K.profileToSketch([pts.map(([x, y]) => ({ x: x + s.at[0], y: y + s.at[1], b: 0 }))], s.at[2]),
      s.len,
    );
  }

  // a simplified spur gear: trapezoid teeth between the root and the tip circle
  /** @private A spur gear as a solid. */
  static gearShape(s) {
    const lib = K.lib();
    const z = s.teeth;
    const ra = (s.module * (z + 2)) / 2;
    const rf = (s.module * (z - 2.5)) / 2;
    const pts = [];
    const step = (2 * Math.PI) / z;
    for (let i = 0; i < z; i += 1)
      for (const [r, d] of [
        [rf, -0.27],
        [ra, -0.12],
        [ra, 0.12],
        [rf, 0.27],
      ]) {
        const a = i * step + d * step;
        pts.push({ x: s.at[0] + r * Math.cos(a), y: s.at[1] + r * Math.sin(a), b: 0 });
      }
    let g = K.extrudeSketch(K.profileToSketch([pts], s.at[2]), s.h);
    if (s.bore_r > 0)
      g = g.cut(lib.makeCylinder(s.bore_r, s.h + 2, [s.at[0], s.at[1], s.at[2] - 1], [0, 0, 1]));
    return g;
  }

  // plan (validated) -> { shape, lines (what was built), warnings }
  /** Builds the solid of a validated plan. @returns the result shape and the messages */
  static build(plan, { ref = null } = {}) {
    const lib = K.lib();
    if (!lib) throw new Error('The 3D kernel is not loaded.');
    const shapes = new Map();
    const lines = [];
    const warnings = [];
    const get = (id) => shapes.get(id).clone(); // replicad operations consume their operands: every use gets its own copy, so a step can be used several times
    const f = (n) => +Number(n).toFixed(3);
    for (const s of plan.steps) {
      const tag = `${s.op} "${s.id}"`;
      let sh = null;
      let line = '';
      try {
        switch (s.op) {
          case 'box':
            sh = K.makeBox(s.size[0], s.size[1], s.size[2], s.at[0], s.at[1], s.at[2]);
            line = `box ${s.size.map(f).join(' x ')}`;
            break;
          case 'cylinder':
            sh = lib.makeCylinder(s.r, s.h, s.at, AXIS_DIR[s.axis]);
            line = `cylinder r=${f(s.r)} h=${f(s.h)} along ${s.axis.toUpperCase()}`;
            break;
          case 'sphere':
            sh = K.makeSphere(s.r, s.at[0], s.at[1], s.at[2]);
            line = `sphere r=${f(s.r)}`;
            break;
          case 'cone':
            sh = PlanBuilder.orient(K.makeCone(s.r1, s.r2, s.h, 0, 0, 0), s.axis, s.at);
            line = `cone r1=${f(s.r1)} r2=${f(s.r2)} h=${f(s.h)}`;
            break;
          case 'torus':
            sh = K.makeTorus(s.R, s.r, s.at[0], s.at[1], s.at[2]);
            line = `torus R=${f(s.R)} r=${f(s.r)}`;
            break;
          case 'polygon': {
            const loop = s.points.map(([x, y]) => ({ x: x + s.at[0], y: y + s.at[1], b: 0 }));
            sh = K.extrudeSketch(K.profileToSketch([loop], s.at[2]), s.h);
            line = `${s.points.length}-point outline extruded ${f(s.h)}`;
            break;
          }
          case 'revolve': {
            let pen = lib.draw(s.profile[0]);
            for (let i = 1; i < s.profile.length; i += 1) pen = pen.lineTo(s.profile[i]);
            sh = pen
              .close()
              .sketchOnPlane('XZ')
              .revolve([0, 0, 1])
              .translate(s.at[0], s.at[1], s.at[2]);
            line = `profile of ${s.profile.length} points revolved`;
            break;
          }
          case 'extrude_outline': {
            const o = ref.outlines[s.outline];
            const loops = [o.pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 }))];
            if (s.holes) {
              const h = holesOf(ref, s.outline);
              for (const id of h.outlines)
                loops.push(ref.outlines[id].pts.map((p) => ({ x: p.x, y: p.y, b: p.b || 0 })));
              for (const id of h.circles) {
                const c = ref.circles[id];
                loops.push([
                  { x: c.c.x - c.r, y: c.c.y, b: 1 },
                  { x: c.c.x + c.r, y: c.c.y, b: 1 },
                ]);
              }
              line = `${s.outline} extruded ${f(s.h)}${h.circles.length || h.outlines.length ? `, ${h.circles.length} round + ${h.outlines.length} other hole(s) cut` : ''}`;
            } else line = `${s.outline} extruded ${f(s.h)}`;
            sh = K.extrudeSketch(K.profileToSketch(loops, s.z), s.h);
            break;
          }
          case 'extrude_circle': {
            const c = ref.circles[s.circle];
            sh = lib.makeCylinder(c.r, s.h, [c.c.x, c.c.y, s.z], [0, 0, 1]);
            line = `${s.circle} extruded ${f(s.h)} (r=${f(c.r)})`;
            break;
          }
          case 'tube': {
            const outer = lib.makeCylinder(s.ro, s.h, [0, 0, 0], [0, 0, 1]);
            sh =
              s.ri > 0 ? outer.cut(lib.makeCylinder(s.ri, s.h + 2, [0, 0, -1], [0, 0, 1])) : outer;
            sh = PlanBuilder.orient(sh, s.axis, s.at);
            line = `tube ro=${f(s.ro)} ri=${f(s.ri)} h=${f(s.h)}`;
            break;
          }
          case 'prism': {
            const Rc = s.across_flats / (2 * Math.cos(Math.PI / s.sides));
            const loop = Array.from({ length: s.sides }, (_, i) => ({
              x: s.at[0] + Rc * Math.cos((2 * Math.PI * i) / s.sides),
              y: s.at[1] + Rc * Math.sin((2 * Math.PI * i) / s.sides),
              b: 0,
            }));
            sh = K.extrudeSketch(K.profileToSketch([loop], s.at[2]), s.h);
            if (s.hole_r > 0)
              sh = sh.cut(
                lib.makeCylinder(s.hole_r, s.h + 2, [s.at[0], s.at[1], s.at[2] - 1], [0, 0, 1]),
              );
            line = `${s.sides}-sided prism, ${f(s.across_flats)} across flats, h=${f(s.h)}${s.hole_r > 0 ? `, hole r=${f(s.hole_r)}` : ''}`;
            break;
          }
          case 'section':
            sh = PlanBuilder.sectionShape(s);
            line = `${s.shape} section ${f(s.w)} x ${f(s.hgt)}, t=${f(s.t)}, length ${f(s.len)}`;
            break;
          case 'gear':
            sh = PlanBuilder.gearShape(s);
            line = `spur gear ${s.teeth} teeth, module ${f(s.module)}, h=${f(s.h)}`;
            break;
          case 'hole': {
            PlanBuilder.fitCheck(get(s.of), s.r, tag);
            let acc = get(s.of);
            const b = acc.boundingBox.bounds;
            const z0 = s.from === 'top' ? b[1][2] : b[0][2];
            const span = b[1][2] - b[0][2];
            const len = s.depth > 0 ? s.depth : span;
            for (const [x, y] of s.at) {
              const z = s.from === 'top' ? z0 - len : z0 - 1;
              acc = acc.cut(lib.makeCylinder(s.r, len + 1, [x, y, z], [0, 0, 1]));
            }
            sh = acc;
            line = `${s.at.length} hole(s) r=${f(s.r)} ${s.depth > 0 ? `depth ${f(s.depth)}` : 'through'} on ${s.of}`;
            break;
          }
          case 'hole_circle': {
            PlanBuilder.fitCheck(get(s.of), s.r, tag, s.R);
            let acc = get(s.of);
            const b = acc.boundingBox.bounds;
            const z0 = s.from === 'top' ? b[1][2] : b[0][2];
            const span = b[1][2] - b[0][2];
            const len = s.depth > 0 ? s.depth : span;
            for (let i = 0; i < s.count; i += 1) {
              const a = ((s.start + (360 * i) / s.count) * Math.PI) / 180;
              const x = s.center[0] + s.R * Math.cos(a);
              const y = s.center[1] + s.R * Math.sin(a);
              const z = s.from === 'top' ? z0 - len : z0 - 1;
              acc = acc.cut(lib.makeCylinder(s.r, len + 1, [x, y, z], [0, 0, 1]));
            }
            sh = acc;
            line = `${s.count} holes r=${f(s.r)} on a circle R${f(s.R)} ${s.depth > 0 ? `depth ${f(s.depth)}` : 'through'}`;
            break;
          }
          case 'pocket': {
            const base = get(s.of);
            const b = base.boundingBox.bounds;
            const z0 = s.from === 'top' ? b[1][2] : b[0][2];
            const z = s.from === 'top' ? z0 - s.depth : z0 - 1;
            sh = base.cut(K.makeBox(s.size[0], s.size[1], s.depth + 1, s.at[0], s.at[1], z));
            line = `pocket ${s.size.map(f).join(' x ')} depth ${f(s.depth)}`;
            break;
          }
          case 'shell': {
            const base = get(s.of);
            const b = base.boundingBox.bounds;
            const zface = s.open === 'top' ? b[1][2] : b[0][2];
            sh = base.shell(s.t, (face) => face.inPlane('XY', zface));
            line = `hollow ${s.of}, wall ${f(s.t)}, open ${s.open}`;
            break;
          }
          case 'union':
            sh = s.b.reduce((acc, id) => K.fuse(acc, get(id)), get(s.a));
            line = `${s.a} + ${s.b.join(' + ')}`;
            break;
          case 'subtract':
            sh = s.b.reduce((acc, id) => K.cut(acc, get(id)), get(s.a));
            line = `${s.a} - ${s.b.join(' - ')}`;
            break;
          case 'intersect':
            sh = s.b.reduce((acc, id) => K.common(acc, get(id)), get(s.a));
            line = `${s.a} & ${s.b.join(' & ')}`;
            break;
          case 'fillet':
            sh = PlanBuilder.dress(get(s.of), 'fillet', s.r, s.edges, warnings, tag);
            line = `round ${s.edges} edges of ${s.of}, R${f(s.r)}`;
            break;
          case 'chamfer':
            sh = PlanBuilder.dress(get(s.of), 'chamfer', s.d, s.edges, warnings, tag);
            line = `chamfer ${s.edges} edges of ${s.of}, ${f(s.d)}`;
            break;
          case 'move':
            sh = get(s.of).translate(s.by[0], s.by[1], s.by[2]);
            line = `move ${s.of} by (${s.by.map(f).join(', ')})`;
            break;
          case 'rotate':
            sh = get(s.of).rotate(s.deg, s.center, AXIS_DIR[s.axis]);
            line = `rotate ${s.of} ${f(s.deg)} deg about ${s.axis.toUpperCase()}`;
            break;
          case 'mirror': {
            const n = { xy: [0, 0, 1], yz: [1, 0, 0], xz: [0, 1, 0] }[s.plane];
            sh = K.fuse(get(s.of), get(s.of).mirror(n, [0, 0, 0]));
            line = `${s.of} with its mirror image (${s.plane})`;
            break;
          }
          case 'linear_array': {
            let acc = get(s.of);
            for (let i = 1; i < s.count; i += 1)
              acc = K.fuse(acc, get(s.of).translate(s.step[0] * i, s.step[1] * i, s.step[2] * i));
            sh = acc;
            line = `${s.count} copies of ${s.of}, step (${s.step.map(f).join(', ')})`;
            break;
          }
          case 'polar_array': {
            const full = Math.abs(s.deg) >= 360 - 1e-9;
            const da = full ? s.deg / s.count : s.deg / (s.count - 1);
            let acc = get(s.of);
            for (let i = 1; i < s.count; i += 1)
              acc = K.fuse(acc, get(s.of).rotate(da * i, s.center, [0, 0, 1]));
            sh = acc;
            line = `${s.count} copies of ${s.of} around Z`;
            break;
          }
          default:
            throw new Error('unknown op');
        }
      } catch (err) {
        throw new Error(`${tag}: ${err.message || 'the kernel could not do this step'}`);
      }
      if (!sh) throw new Error(`${tag}: nothing was built.`);
      shapes.set(s.id, sh);
      lines.push(`${s.id}: ${line}`);
    }
    const shape = shapes.get(plan.result);
    if (!shape) throw new Error('The result step was not built.');
    for (const [id, sh] of shapes)
      if (id !== plan.result) {
        try {
          sh.delete();
        } catch {
          /* already consumed */
        }
      } // free the intermediate shapes (WebAssembly memory)
    return { shape, lines, warnings };
  }
}

/* ============================================================================================
 * 4. AUTOMODELER
 * ========================================================================================== */

/** Asks the language model for a plan, repairs the answer when it has problems, and builds the solid. */
export class AutoModeler {
  // every number of the request should show up in the plan: as it is, or (for a diameter) as a radius of half the size. A small model that forgot a dimension is caught here.
  /** The numbers of the request that the plan does not use (the model was told to keep every number). */
  static missingNumbers(request, plan) {
    const wanted = [
      ...String(request).matchAll(/(?<![A-Za-z0-9_.])(\d+(?:\.\d+)?)(?![0-9]*[dD](?![a-z])\b)/g),
    ]
      .map((m) => parseFloat(m[1]))
      .filter((n) => n > 0);
    const have = [];
    const radii = [];
    const RADIUS_KEYS = ['r', 'r1', 'r2', 'R', 'ro', 'ri', 'hole_r', 'bore_r'];
    const walk = (v, key) => {
      if (typeof v === 'number') {
        have.push(Math.abs(v));
        if (RADIUS_KEYS.includes(key)) radii.push(Math.abs(v));
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
    };
    walk(plan.steps, '');
    const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
    return [...new Set(wanted)].filter(
      (n) => !have.some((h) => close(h, n)) && !radii.some((r) => close(r * 2, n)),
    ); // a diameter in the request is a radius (half) in the plan
  }

  // ------------------------------------------------------------------ the whole automatic loop: ask -> validate -> build -> (tell the model what went wrong and ask again)
  /** @private Reads the JSON plan out of the model's text (it may be wrapped in a code fence or other words). */
  static parsePlanJson(text) {
    const t = String(text)
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim();
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fall through */
      }
    }
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error('The answer is not valid JSON.');
  }

  // ask(messages, opts) -> text (opts: {schema, think, temperature, numCtx}); previous = the plan being refined. Returns {plan, shape, lines, warnings, attempts}.
  /** Asks the model for a plan, validates and builds it; on problems the model is asked again with the list of problems. @returns the built solid and the plan */
  static async autoModel(
    ask,
    request,
    { previous = null, maxRepairs = 2, onStatus = () => {}, reference = null } = {},
  ) {
    const ref = reference && !reference.empty ? reference : null;
    const msgs = [{ role: 'system', content: PLAN_PROMPT + (ref ? REF_PROMPT : '') }];
    const refText = ref ? `${ref.summary}\n\n` : '';
    msgs.push({
      role: 'user',
      content: previous
        ? `${refText}Current plan:\n${JSON.stringify({ name: previous.name, steps: previous.steps, result: previous.result })}\n\nChange the model as follows and return the COMPLETE new plan: ${request}`
        : `${refText}${request}`,
    });
    let problem = '';
    let numberRetries = 0; // the missing-numbers check asks only once: a number can be missing for a good reason ("4 corners")
    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      onStatus(
        attempt
          ? `The plan had a problem, asking the model to fix it (${attempt + 1}/${maxRepairs + 1})...`
          : 'The model is planning the 3D model...',
      );
      const text = await ask(msgs, {
        schema: PLAN_SCHEMA,
        think: false,
        temperature: attempt ? 0.3 : 0.1,
        numCtx: 8192,
      });
      msgs.push({ role: 'assistant', content: text });
      let raw;
      try {
        raw = AutoModeler.parsePlanJson(text);
      } catch (err) {
        problem = err.message;
        msgs.push({
          role: 'user',
          content: `${problem} Reply with the complete plan as JSON only.`,
        });
        continue;
      }
      const v = PlanValidator.validate(raw, { ref });
      if (!v.plan) {
        problem = v.errors.slice(0, 8).join(' ');
        msgs.push({
          role: 'user',
          content: `The plan has problems: ${v.errors.slice(0, 8).join(' ')} Return the corrected COMPLETE plan.`,
        });
        continue;
      }
      const miss = previous ? [] : AutoModeler.missingNumbers(request, v.plan);
      if (miss.length && attempt < maxRepairs && numberRetries < 1) {
        numberRetries += 1;
        problem = `the numbers ${miss.join(', ')} of the request are not used`;
        msgs.push({
          role: 'user',
          content: `The plan does not use these numbers from the request: ${miss.join(', ')}. Check that every dimension of the request is used (a radius is half of a diameter) and return the corrected COMPLETE plan.`,
        });
        continue;
      }
      onStatus('Building the solid...');
      try {
        const built = PlanBuilder.build(v.plan, { ref });
        return {
          plan: v.plan,
          ...built,
          warnings: [
            ...v.warnings,
            ...(miss.length
              ? [
                  `These numbers of your request do not appear in the model: ${miss.join(', ')}. Check the result.`,
                ]
              : []),
            ...built.warnings,
          ],
          attempts: attempt + 1,
        };
      } catch (err) {
        problem = err.message;
        msgs.push({
          role: 'user',
          content: `Building the plan failed: ${err.message} Return the corrected COMPLETE plan (check the sizes, the order of the steps and that cutters overlap the part).`,
        });
      }
    }
    throw new Error(`The model could not produce a buildable plan. Last problem: ${problem}`);
  }

  // plan text for the user: every step on one line
  /** The plan as text for the user: every step on one line. */
  static describePlan(plan) {
    return plan.steps
      .map((s, i) => `${i + 1}. ${s.id}: ${s.op}${s.op === 'box' ? ` ${s.size.join(' x ')}` : ''}`)
      .join('\n');
  }
}

export const validatePlan = PlanValidator.validate;
export const edgeIds = PlanBuilder.edgeIds;
export const buildPlan = PlanBuilder.build;
export const missingNumbers = AutoModeler.missingNumbers;
export const autoModel = AutoModeler.autoModel;
export const describePlan = AutoModeler.describePlan;
