/**
 * @file ai.js
 * @brief The AI assistant on a LOCAL language model (Ollama / OpenAI-compatible server on this Mac).
 *
 * Nothing leaves the computer unless the user allows a non-local server in the settings. The model
 * never changes the drawing by itself: its answers are reviewed (AutoLISP code), checked (JSON
 * plans are validated and built by plan3d.js) or applied by deterministic code (text correction,
 * layers, clean-up).
 *
 * Layout: AiText (reading the model's answers), AiDrawing (describing and cleaning up the drawing),
 * AiModel (talking to the model), AiCommands (AI, AIPICK, AILISP, AITEXT, AILAYERS, AIDESCRIBE,
 * AISETTINGS, CLEANUP) and AiDialog (the window with six tabs).
 */

/* ============================================================================================
 * 1. INCLUDES AND HELPERS
 * ========================================================================================== */
import * as E from './entities.js';
import * as G from './geom.js';
import { def } from './registry.js';
import { fmtLen } from './units.js';
import * as K from './kernel3d.js';
import { autoModel, validatePlan, buildPlan, PLAN_SCHEMA } from './plan3d.js';
import { buildReference } from './reference3d.js';
import { Doc } from './doc.js';
import { importDXF } from './dxf.js';
import { dwgToDoc } from './dwg.js';
export const AI_DEFAULTS = {
  endpoint: 'http://127.0.0.1:11434',
  api: 'auto',
  model: '',
  allowRemote: false,
  apiKey: '',
  lang: 'Korean',
};
export const hooks = { transport: null }; // tests / previews can replace the transport: async (cfg, messages, opts) => ({ ok, text, error })
const cfgOf = (app) => ({ ...AI_DEFAULTS, ...(app.settings.ai || {}) });
const api = () => (typeof window !== 'undefined' ? window.api : null);
// which installed model to use for 3D planning: the saved choice, else the best known one (measured with scripts/ai3d-eval.mjs), else the first
export const MODEL_PREFERENCE = [
  'qwen3:8b',
  'qwen3:14b',
  'qwen2.5:7b',
  'qwen2.5-coder:7b',
  'llama3.1:8b',
]; // measured with scripts/ai3d-eval.mjs: qwen3:8b and 14b 9/10 (8b is 2.5x faster), qwen2.5:7b 8/10
const SYS_LISP = (
  app,
  ents,
) => `You are an AutoLISP expert for MacCAD 2027, an AutoCAD-compatible CAD program on macOS.
Write AutoLISP code for the user's request.
Rules:
- Reply with ONE code block in \`\`\`lisp fences, followed by at most two short sentences.
- For something the user will run repeatedly define a command: (defun c:NAME () ... (princ)). Otherwise write plain top-level forms.
- Use standard AutoLISP only: (command "LINE" p1 p2 ""), entmake / entget / entmod / entdel, ssget / ssname / sslength, getpoint / getreal / getint / getstring, polar, distance, angle, mapcar, foreach, repeat, while, strcat, rtos, itoa, atof, etc.
- Angles are radians. Points are lists like (x y) or (x y z). No ActiveX (vla-*) unless there is no other way. No file or network access.
- 3D SOLIDS: use these MacCAD functions (each returns an entity name; the points are lists like '(x y z)):
    (box3d '(x y z) width depth height)   (cylinder3d '(x y z) radius height)   (sphere3d '(x y z) radius)   (cone3d '(x y z) radius1 radius2 height)   (torus3d '(x y z) radius tube-radius)
    (extrude3d ename height [taper-degrees])   ; a closed 2D object (circle, closed polyline) becomes a solid
    (round3d ename radius)   ; ROUND (fillet) ALL edges, returns the NEW entity name -> always (setq e (round3d e r))
    (chamfer3d ename distance)   ; chamfer ALL edges, returns the new entity name
    (union3d e1 e2 ...)  (subtract3d e1 e2 ...)  (intersect3d e1 e2 ...)   ; boolean operations, return the new entity name
    (move3d ename dx dy dz)   (draft3d ename degrees)   (volume3d ename)
  Radius and distance values must be smaller than half of the thinnest side of the solid.
  Example, "20 x 20 x 20 cube with every edge rounded by 2":  (setq e (box3d '(0 0 0) 20 20 20)) (setq e (round3d e 2))
  Example, "block with a hole":  (setq b (box3d '(0 0 0) 40 40 10)) (setq h (cylinder3d '(20 20 -1) 6 12)) (setq b (subtract3d b h))
- Prefer a single clear solution that works the first time.
Reply language for explanations: ${cfgOf(app).lang}.
Drawing context:
${AiDrawing.summarize(app.doc, app.curEnts())}`;
// ------------------------------------------------------------------ small DOM helpers
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
const busy = async (btn, out, fn) => {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working...';
  const t0 = Date.now();
  const timer = setInterval(() => {
    btn.textContent = `Working... ${Math.round((Date.now() - t0) / 1000)} s`;
  }, 1000);
  try {
    await fn();
  } catch (err) {
    out.textContent = `⚠ ${err.message}`;
    out.classList.add('aiErr');
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    btn.textContent = label;
  }
};
export async function aiDialog(c, startTab = 0) {
  return new AiDialog(c).open(startTab);
}
// ------------------------------------------------------------------ commands
// the dialog is opened after the command has finished so that its own edits (each one undoable) are not wrapped in a second undo step
const open = (tab) => async (c) => {
  setTimeout(() => aiDialog(c, tab), 0);
};

/* ============================================================================================
 * 2. AITEXT
 * ========================================================================================== */

/** Reading the model's answers: code blocks and JSON. */
export class AiText {
  // ------------------------------------------------------------------ helpers (pure, tested)
  /** The code of the first ``` block of an answer (or the whole answer when it has none). */
  static extractCode(text, lang = 'lisp') {
    const m = new RegExp(
      '```(?:' + lang + '|lisp|autolisp|scheme|clojure)?[ \\t]*\\r?\\n([\\s\\S]*?)```',
      'i',
    ).exec(text);
    if (m) return m[1].trim();
    const i = text.indexOf('(');
    return i >= 0 ? text.slice(i).trim() : text.trim();
  }

  /** The first JSON object in an answer, even when it is wrapped in a code block or other words; null when there is none. */
  static extractJson(text) {
    const t = String(text).trim();
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
    for (const [o, c] of [
      ['{', '}'],
      ['[', ']'],
    ]) {
      const a = t.indexOf(o);
      const b = t.lastIndexOf(c);
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(t.slice(a, b + 1));
        } catch {
          /* try next */
        }
      }
    }
    throw new Error('The model did not return valid JSON.');
  }

  /** A text object's string without formatting codes. */
  static plainText(e) {
    return e.str || '';
  }

  /** @returns {boolean} true for text, multiline text and dimension text objects that the text tools can change. */
  static isTextEnt(e) {
    return e.type === 'text' || e.type === 'mtext';
  }
}

/* ============================================================================================
 * 3. AIDRAWING
 * ========================================================================================== */

/** Describing the drawing for the prompts, and deterministic clean-up of the objects. */
export class AiDrawing {
  // short description of the drawing for the prompts (counts, layers, extents, a few strings)
  /** A short description of the drawing for the prompts (counts, layers, extents, a few strings). */
  static summarize(doc, ents) {
    const types = {};
    const layers = {};
    const texts = [];
    let bb = null;
    for (const e of ents) {
      types[e.type] = (types[e.type] || 0) + 1;
      (layers[e.layer] ||= {})[e.type] = ((layers[e.layer] || {})[e.type] || 0) + 1;
      if (AiText.isTextEnt(e) && texts.length < 25 && AiText.plainText(e).trim())
        texts.push(AiText.plainText(e).slice(0, 60));
      const b = E.bbox(e, doc);
      if (b) bb = E.bboxMerge(bb, b);
    }
    const u = doc.units || {};
    const f = (v) => fmtLen(v, { ...u, prec: 2 });
    const lines = [
      `Units: ${u.type || 'decimal'}`,
      `Objects: ${ents.length} (${
        Object.entries(types)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ') || 'none'
      })`,
    ];
    if (bb)
      lines.push(
        `Extents: ${f(bb.x1 - bb.x0)} x ${f(bb.y1 - bb.y0)} from (${f(bb.x0)}, ${f(bb.y0)})`,
      );
    lines.push(
      'Layers: ' +
        Object.entries(layers)
          .map(
            ([n, t]) =>
              `${n} [${Object.entries(t)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}]`,
          )
          .join('; '),
    );
    if (texts.length) lines.push('Text samples: ' + texts.map((t) => JSON.stringify(t)).join(', '));
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ deterministic clean-up
  // opts: { zero, dup, orthoDeg, gap }. Returns the counts; mutates the entities (call it inside app.edit so it is one undo step).
  /** Deterministic clean-up of objects: removes empty and duplicate objects and straightens almost horizontal / vertical lines. @returns the changes and a report */
  static cleanup(doc, ents, opts = {}) {
    const o = { zero: true, dup: true, orthoDeg: 0.5, gap: 0, ...opts };
    const stats = { zero: 0, dup: 0, ortho: 0, gaps: 0 };
    const kill = new Set();
    const key = (e) => {
      const r = (v) => Math.round(v * 1e6) / 1e6;
      if (e.type === 'line') {
        const a = `${r(e.p1.x)},${r(e.p1.y)}`;
        const b = `${r(e.p2.x)},${r(e.p2.y)}`;
        return `L|${e.layer}|${a < b ? a + '|' + b : b + '|' + a}`;
      }
      if (e.type === 'circle') return `C|${e.layer}|${r(e.c.x)},${r(e.c.y)}|${r(e.r)}`;
      if (e.type === 'arc')
        return `A|${e.layer}|${r(e.c.x)},${r(e.c.y)}|${r(e.r)}|${r(e.a0)}|${r(e.a1)}`;
      if (e.type === 'point') return `P|${e.layer}|${r(e.p.x)},${r(e.p.y)}`;
      return null;
    };
    const seen = new Set();
    for (const e of ents) {
      if (o.zero && e.type === 'line' && G.dist(e.p1, e.p2) < 1e-9) {
        kill.add(e.id);
        stats.zero += 1;
        continue;
      }
      if (o.dup) {
        const k = key(e);
        if (k) {
          if (seen.has(k)) {
            kill.add(e.id);
            stats.dup += 1;
          } else seen.add(k);
        }
      }
    }
    const live = ents.filter((e) => !kill.has(e.id));
    if (o.orthoDeg > 0) {
      // lines that are almost horizontal / vertical become exactly so (the start point stays)
      const tol = (o.orthoDeg * Math.PI) / 180;
      for (const e of live) {
        if (e.type !== 'line') continue;
        const dx = e.p2.x - e.p1.x;
        const dy = e.p2.y - e.p1.y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-9) continue;
        const a = Math.atan2(dy, dx);
        const r = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(a - r) > 1e-9 && Math.abs(a - r) <= tol) {
          e.p2 = { x: e.p1.x + L * Math.cos(r), y: e.p1.y + L * Math.sin(r) };
          stats.ortho += 1;
        }
      }
    }
    if (o.gap > 0) {
      // end points that are almost the same point become the same point
      const pts = [];
      for (const e of live) if (e.type === 'line') pts.push({ e, k: 'p1' }, { e, k: 'p2' });
      const cell = o.gap;
      const grid = new Map();
      const cl = [];
      const cellKey = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      for (const p of pts) {
        const q = p.e[p.k];
        let found = null;
        for (let dx = -1; dx <= 1 && !found; dx += 1)
          for (let dy = -1; dy <= 1 && !found; dy += 1)
            for (const c of grid.get(
              `${Math.floor(q.x / cell) + dx},${Math.floor(q.y / cell) + dy}`,
            ) || [])
              if (Math.hypot(c.x - q.x, c.y - q.y) <= o.gap) {
                found = c;
                break;
              }
        if (found) {
          found.members.push(p);
          found.sx += q.x;
          found.sy += q.y;
          found.x = found.sx / found.members.length;
          found.y = found.sy / found.members.length;
        } else {
          const c = { x: q.x, y: q.y, sx: q.x, sy: q.y, members: [p] };
          cl.push(c);
          const ck = cellKey(q.x, q.y);
          (grid.get(ck) || grid.set(ck, []).get(ck)).push(c);
        }
      }
      for (const c of cl) {
        if (c.members.length < 2) continue;
        if (c.members.some((m) => Math.hypot(m.e[m.k].x - c.x, m.e[m.k].y - c.y) > 1e-9)) {
          stats.gaps += c.members.length;
          for (const m of c.members) m.e[m.k] = { x: c.x, y: c.y };
        }
      }
    }
    return { ...stats, kill };
  }
}

/* ============================================================================================
 * 4. AIMODEL
 * ========================================================================================== */

/** Talking to the model. */
export class AiModel {
  // ------------------------------------------------------------------ talking to the model
  /** Sends messages to the model and returns the answer. @returns {Promise<{ok: boolean, text?: string, error?: string}>} */
  static async ask(
    app,
    messages,
    { json = false, temperature = 0.2, schema = null, think, numCtx, model } = {},
  ) {
    const cfg = cfgOf(app);
    const useModel = model || cfg.model;
    const req = {
      endpoint: cfg.endpoint,
      api: cfg.api,
      model: useModel,
      messages,
      json,
      schema,
      think,
      numCtx,
      temperature,
      allowRemote: cfg.allowRemote,
      apiKey: cfg.apiKey,
    };
    const r = hooks.transport
      ? await hooks.transport({ ...cfg, model: useModel }, messages, {
          json,
          temperature,
          schema,
          think,
          numCtx,
        })
      : api() && api().aiChat
        ? await api().aiChat(req)
        : {
            ok: false,
            error:
              'The AI assistant needs the desktop app (it talks to a model running on this Mac).',
          };
    if (!r || !r.ok) throw new Error((r && r.error) || 'The AI request failed.');
    return r.text;
  }

  /** Which installed model to use for 3D planning: the saved choice, else the best known one (MODEL_PREFERENCE). */
  static pick3DModel(installed, saved) {
    return saved && installed.includes(saved)
      ? saved
      : MODEL_PREFERENCE.find((m) => installed.includes(m)) ||
          installed.find((m) => /qwen|llama|mistral|gemma|phi/i.test(m)) ||
          installed[0] ||
          '';
  }
}

/* ============================================================================================
 * 5. AICOMMANDS
 * ========================================================================================== */

/** The AI commands. Every command is a static method `(c) => Promise`; `register()` adds them all. */
export class AiCommands {
  // AIPICK: choose the 2D objects (window selection) the AI 3D modeller should follow, then come back to the AI window
  /** AIPICK: chooses the 2D objects (window selection) that the AI 3D modeller should follow, then comes back to the dialog. */
  static async pickReference(c) {
    const ents = await c.select(
      'Select the 2D objects the 3D model should follow (outline, holes, notes)',
      { pre: false },
    );
    if (ents.length) {
      const ref = buildReference(c.doc, ents);
      if (ref.empty)
        c.echo(
          'No closed outline or circle in the selection (lines and arcs must form a closed shape).',
        );
      else {
        ref.source = 'selection';
        c.app.aiRef = ref;
        c.echo(`Reference: ${ref.label}.`);
      }
    }
    setTimeout(() => aiDialog(c, 0), 0);
  }

  // CLEANUP / BEAUTIFY: remove empty and duplicate objects, straighten almost-horizontal / vertical lines, close tiny gaps between line end points
  /** CLEANUP / BEAUTIFY: removes empty and duplicate objects, straightens almost horizontal / vertical lines. */
  static async cleanup(c) {
    const ents = c.app.curEnts().filter((e) => c.app.selectable(e));
    if (!ents.length) return c.echo('There is nothing to clean up.');
    let bb = null;
    for (const e of ents) bb = E.bboxMerge(bb, E.bbox(e, c.doc));
    const size = bb ? Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) : 100;
    const gap0 = Math.max(1e-6, +(size * 1e-4).toPrecision(2));
    const body = h(
      'div',
      { style: 'width:420px' },
      h(
        'label',
        { class: 'chk' },
        h('input', { type: 'checkbox', name: 'zero', checked: true }),
        ' Remove zero-length lines',
      ),
      h(
        'label',
        { class: 'chk' },
        h('input', { type: 'checkbox', name: 'dup', checked: true }),
        ' Remove duplicate objects',
      ),
      h(
        'div',
        { class: 'frow' },
        h('label', {}, 'Straighten lines within (degrees):'),
        h('input', { type: 'number', name: 'ortho', value: 0.5, step: 'any', min: 0 }),
      ),
      h(
        'div',
        { class: 'frow' },
        h('label', {}, 'Close end-point gaps up to:'),
        h('input', { type: 'number', name: 'gap', value: gap0, step: 'any', min: 0 }),
      ),
      h(
        'div',
        { class: 'osTip' },
        `Drawing size is about ${+size.toPrecision(3)}. Everything is one undo step. Optional: let the local AI model suggest the two tolerances.`,
      ),
      h('button', { class: 'b', name: 'suggest' }, 'Suggest values with AI'),
      h('div', { class: 'aiOut', name: 'msg', style: 'margin-top:6px;min-height:18px' }),
    );
    const q = (n) => body.querySelector(`[name=${n}]`);
    q('suggest').onclick = async () => {
      const msg = q('msg');
      msg.textContent = 'Asking the model...';
      try {
        const lens = ents
          .filter((e) => e.type === 'line')
          .map((e) => G.dist(e.p1, e.p2))
          .sort((a, b) => a - b);
        const med = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
        const skew = ents
          .filter((e) => e.type === 'line')
          .filter((e) => {
            const a = Math.atan2(e.p2.y - e.p1.y, e.p2.x - e.p1.x);
            const r = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
            const d = Math.abs(a - r) * 57.2958;
            return d > 1e-6 && d < 3;
          }).length;
        const text = await AiModel.ask(
          c.app,
          [
            {
              role: 'system',
              content:
                'You choose tolerances for cleaning up a CAD drawing. Return ONLY JSON {"orthoDeg":<number 0..2>,"gap":<number>,"why":"<short>"}. gap must be far smaller than the typical line length (about 0.1 % of it or less) so that real details are never merged; orthoDeg is how far from horizontal / vertical a line may be and still be straightened.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                drawingSize: size,
                lines: lens.length,
                medianLineLength: med,
                shortestLine: lens[0] ?? 0,
                linesWithin3DegOfAxis: skew,
              }),
            },
          ],
          { json: true, temperature: 0 },
        );
        const r = AiText.extractJson(text);
        const od = Math.min(2, Math.max(0, +r.orthoDeg || 0));
        const gp = Math.min(med ? med * 0.01 : size * 1e-3, Math.max(0, +r.gap || 0));
        q('ortho').value = od;
        q('gap').value = +gp.toPrecision(3);
        msg.textContent = `Suggested: ${od}°, gap ${+gp.toPrecision(3)}${r.why ? ` (${String(r.why).slice(0, 120)})` : ''}`;
      } catch (err) {
        msg.textContent = `⚠ ${err.message}`;
      }
    };
    const r = await c.ui.dialog({
      title: 'Clean up drawing',
      body,
      collect: () => ({
        zero: q('zero').checked,
        dup: q('dup').checked,
        orthoDeg: +q('ortho').value || 0,
        gap: +q('gap').value || 0,
      }),
    });
    if (!r) return;
    const stats = AiDrawing.cleanup(c.doc, ents, r);
    if (stats.kill.size) c.erase(ents.filter((e) => stats.kill.has(e.id)));
    else c.bump();
    c.echo(
      `CLEANUP: ${stats.zero} zero-length and ${stats.dup} duplicate object(s) removed, ${stats.ortho} line(s) straightened, ${stats.gaps} end point(s) joined.`,
    );
  }

  /** Registers the commands of this file in their original order (a later definition of a name wins). */
  static register() {
    def('AI AI3D', open(0));
    def('AIPICK', AiCommands.pickReference);
    def('AILISP', open(1));
    def('AITEXT', open(2));
    def('AILAYERS', open(3));
    def('AIDESCRIBE', open(4));
    def('AISETTINGS', open(5));
    def('CLEANUP BEAUTIFY', AiCommands.cleanup);
  }
}

AiCommands.register();

/* ============================================================================================
 * 6. AIDIALOG
 * ========================================================================================== */

/**
 * The AI assistant window (local language model): a status line, six tabs and a Close button.
 * Use `new AiDialog(c).open(startTab)` or the function `aiDialog`.
 */
export class AiDialog {
  /** @param {object} c command context */
  constructor(c) {
    this.c = c;
    this.app = c.app;
    this.doc = c.doc;
    this.tabsEl = h('div', { class: 'tabs' });
    this.pane = h('div', { class: 'tabpane aiPane' });
    this.names = [
      '3D model',
      'Assistant (LISP)',
      'Text correction',
      'Layers',
      'Describe',
      'Settings',
    ];
    /** The content of each tab, in the order of `names`. */
    this.panes = [];
    /** The connection status line at the top. */
    this.status = null;
  }

  /** @private A small hint text. */
  note(t) {
    return h('div', { class: 'osTip' }, t);
  }

  /** @private An empty output box. */
  outBox() {
    return h('pre', { class: 'aiOut' });
  }

  /** @private The "3D model" tab: a request in words -> a JSON plan from the model -> the solid is built, checked and inserted. */
  build3dTab() {
    const { app, note, panes } = this;

    const ta = h('textarea', {
      class: 'aiPrompt',
      rows: 3,
      placeholder:
        'e.g. 지름 80, 두께 12 플랜지. 가운데 지름 40 구멍, 지름 60 원 위에 지름 8 볼트 구멍 6개',
    });
    const modelSel = h('select', { name: 'm3d', style: 'max-width:230px' });
    const refreshModels = async () => {
      const cfg = cfgOf(app);
      let list = [];
      try {
        if (api() && api().aiModels && !hooks.transport) {
          const r = await api().aiModels({
            endpoint: cfg.endpoint,
            api: cfg.api,
            allowRemote: cfg.allowRemote,
            apiKey: cfg.apiKey,
          });
          if (r.ok) list = r.models;
        }
      } catch {
        /* the status line explains */
      }
      if (hooks.transport || !list.length) list = [cfg.model || 'model'];
      modelSel.innerHTML = '';
      for (const m of list) modelSel.append(h('option', { value: m }, m));
      modelSel.value = AiModel.pick3DModel(list, cfg.model3d);
    };
    refreshModels();
    modelSel.addEventListener('change', () => {
      app.settings.ai = { ...cfgOf(app), model3d: modelSel.value };
      app.saveSettings();
    });
    const out = h('pre', { class: 'aiOut' });
    const steps = h('pre', { class: 'aiOut', style: 'max-height:130px;overflow:auto' });
    const info = h('div', { class: 'aiExplain' });
    const cv = h('canvas', {
      width: 420,
      height: 230,
      style:
        'width:420px;height:230px;border:1px solid var(--ctl-edge);border-radius:6px;background:#10141c;display:block;margin:6px 0',
    });
    const planBox = h('textarea', {
      class: 'aiCode',
      rows: 8,
      spellcheck: 'false',
      style: 'display:none',
    });
    const mod = h('input', {
      type: 'text',
      placeholder: 'Change it: e.g. 구멍을 지름 10으로, 모서리를 R3로 둥글게',
      style: 'flex:1;min-width:0',
    });
    let last = null; // {ent, plan}
    // reference drawing: the 2D objects the model should follow (outlines, holes, notes). From the selection, by picking in the drawing, or by dropping a drawing file here.
    const refLabel = h('span', { class: 'osTip', style: 'flex:1 1 240px;min-width:0' }, '');
    const showRef = () => {
      refLabel.textContent =
        app.aiRef && !app.aiRef.empty
          ? `${app.aiRef.source || 'reference'}: ${app.aiRef.label}`
          : 'none (optional): the AI can follow a 2D drawing, e.g. a plate outline with its holes';
    };
    const setRef = (ref, source) => {
      if (ref.empty) {
        out.classList.add('aiErr');
        out.textContent =
          'No closed outline or circle was found in those objects (lines and arcs must form a closed shape).';
        return;
      }
      out.classList.remove('aiErr');
      out.textContent = '';
      ref.source = source;
      app.aiRef = ref;
      showRef();
    };
    const useSel = h(
      'button',
      {
        type: 'button',
        class: 'b',
        title: 'Use the objects that are selected in the drawing as the reference',
      },
      'Use selection',
    );
    useSel.onclick = () => {
      const ents = app.selectedEnts();
      if (!ents.length) {
        out.classList.add('aiErr');
        out.textContent =
          'Select 2D objects in the drawing first (drag a window around them), or press "Pick in drawing".';
        return;
      }
      setRef(buildReference(app.doc, ents), 'selection');
    };
    const pickBtn = h(
      'button',
      {
        type: 'button',
        class: 'b',
        title:
          'Close this window, drag a window around the objects in the drawing, then it comes back',
      },
      'Pick in drawing...',
    );
    pickBtn.onclick = () => {
      const close = [...document.querySelectorAll('.modal-bg .df button')].find(
        (b) => b.textContent.trim() === 'Close',
      );
      setTimeout(() => app.exec('AIPICK'), 60);
      if (close) close.click();
    };
    const clearRef = h('button', { type: 'button', class: 'b' }, 'Clear');
    clearRef.onclick = () => {
      app.aiRef = null;
      showRef();
    };
    showRef();
    if (!app.aiRef && app.sel && app.sel.size) {
      try {
        const r0 = buildReference(app.doc, app.selectedEnts());
        if (!r0.empty) setRef(r0, 'selection');
      } catch {
        /* optional */
      }
    }
    const go = h('button', { class: 'b primary' }, 'Create 3D model');
    const again = h('button', { class: 'b' }, 'Change');
    const showPlan = h('button', { class: 'b' }, 'Show plan');
    const rebuild = h('button', { class: 'b' }, 'Rebuild from plan');
    const iso = (p) => ({ x: (p[0] - p[1]) * 0.866, y: -(p[2] + (p[0] + p[1]) * 0.5) }); // simple isometric projection
    const preview = (ent) => {
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      let m;
      try {
        m = K.solidMesh(ent);
      } catch {
        return;
      }
      const L = m.lines;
      const pts = [];
      for (let i = 0; i + 2 < L.length; i += 3) pts.push(iso([L[i], L[i + 1], L[i + 2]]));
      if (!pts.length) return;
      let x0 = 1e9;
      let x1 = -1e9;
      let y0 = 1e9;
      let y1 = -1e9;
      for (const q of pts) {
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
      }
      const s = Math.min(
        (cv.width - 30) / Math.max(1e-9, x1 - x0),
        (cv.height - 30) / Math.max(1e-9, y1 - y0),
      );
      const ox = (cv.width - (x1 - x0) * s) / 2 - x0 * s;
      const oy = (cv.height - (y1 - y0) * s) / 2 - y0 * s;
      g.strokeStyle = '#7fd4ff';
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i + 1 < pts.length; i += 2) {
        g.moveTo(pts[i].x * s + ox, pts[i].y * s + oy);
        g.lineTo(pts[i + 1].x * s + ox, pts[i + 1].y * s + oy);
      }
      g.stroke();
    };
    const insert = (built, plan, label) => {
      // one undo step; a previous result of this dialog is replaced
      const b = built.shape.boundingBox.bounds;
      let ent;
      app.edit(label, () => {
        if (last && last.ent) app.doc.remove([last.ent.id], app.targetSpace());
        ent = app.doc.stamp(
          E.mk('solid3d', {
            ...K.solidProps(built.shape),
            bb: { x0: b[0][0], y0: b[0][1], z0: b[0][2], x1: b[1][0], y1: b[1][1], z1: b[1][2] },
          }),
        );
        app.doc.add(ent, app.targetSpace());
      });
      last = { ent, plan };
      return ent;
    };
    const show = (built, plan, ent, secs) => {
      const vol = K.volume(built.shape);
      const b = built.shape.boundingBox.bounds;
      const f = (v) => +v.toFixed(2);
      steps.textContent = built.lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
      planBox.value = JSON.stringify(
        { name: plan.name, steps: plan.steps, result: plan.result },
        null,
        1,
      );
      info.textContent = `${plan.name}: ${f(b[1][0] - b[0][0])} x ${f(b[1][1] - b[0][1])} x ${f(b[1][2] - b[0][2])} mm, volume ${f(vol)} mm3.  ${built.attempts ? `${built.attempts} attempt(s), ` : ''}${secs.toFixed(1)} s.`;
      out.classList.remove('aiErr');
      out.textContent = built.warnings.length
        ? `Notes:\n- ${built.warnings.join('\n- ')}`
        : 'Done. The solid is in your drawing (Cmd+Z removes it).';
      preview(ent);
      if (!app.v3) {
        app.enter3D('swiso');
      }
      app.zoomExtents(false);
      app.redraw();
    };
    const work = async (btn, fn) =>
      busy(btn, out, async () => {
        if (!K.kernelReady()) {
          out.textContent = 'Loading the 3D kernel...';
          await K.initKernel();
        }
        out.classList.remove('aiErr');
        out.textContent = '';
        await fn();
      });
    const run = (refine) =>
      work(refine ? again : go, async () => {
        const req = (refine ? mod.value : ta.value).trim();
        if (!req) {
          out.textContent = 'Describe what to build first.';
          return;
        }
        const t0 = Date.now();
        const askM = (msgs, o) => AiModel.ask(app, msgs, { ...o, model: modelSel.value });
        const built = await autoModel(askM, req, {
          previous: refine && last ? last.plan : null,
          reference: app.aiRef || null,
          onStatus: (t) => {
            out.textContent = t;
          },
        });
        const ent = insert(built, built.plan, refine ? 'AI 3D CHANGE' : 'AI 3D MODEL');
        show(built, built.plan, ent, (Date.now() - t0) / 1000);
        if (refine) mod.value = '';
      });
    go.onclick = () => run(false);
    again.onclick = () => {
      if (!last) {
        out.textContent = 'Create a model first.';
        return;
      }
      run(true);
    };
    showPlan.onclick = () => {
      planBox.style.display = planBox.style.display === 'none' ? 'block' : 'none';
    };
    rebuild.onclick = () =>
      work(rebuild, async () => {
        const v = validatePlan(AiText.extractJson(planBox.value), { ref: app.aiRef || null });
        if (!v.plan) throw new Error(v.errors.join(' '));
        const t0 = Date.now();
        const built = buildPlan(v.plan, { ref: app.aiRef || null });
        built.attempts = 0;
        built.warnings = [...v.warnings, ...built.warnings];
        show(built, v.plan, insert(built, v.plan, 'AI 3D REBUILD'), (Date.now() - t0) / 1000);
      });
    const examples = [
      '20 x 20 x 20 정육면체를 만들고 모든 모서리를 R2로 둥글게',
      '지름 80 두께 12 플랜지. 가운데 지름 40 구멍, 지름 60 원 위에 지름 8 볼트 구멍 6개',
      'M10 육각 너트: 대변 17, 두께 8, 가운데 지름 8.4 구멍',
      'L자 브래킷: 가로 60, 높이 40, 두께 5, 길이 20',
      '바깥 80 x 50 x 30 상자, 벽 두께 3, 윗면이 열린 속이 빈 상자',
      '기어 잇수 24 모듈 2.5 두께 10, 가운데 지름 16 구멍',
      '베어링 하우징: 120 x 80 x 20 베이스 플레이트, 세로 모서리 R10, 네 모서리에서 15 안쪽에 지름 9 구멍 4개, 가운데 지름 60 높이 35 원통 보스, 보스 가운데 지름 35 관통 구멍, 보스 윗면 지름 48 원 위에 지름 4 구멍 6개, 보스 윗면 모따기 2',
    ];
    const chips = h(
      'div',
      { style: 'margin:4px 0' },
      ...examples.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: 'b',
            style: 'padding:1px 7px;margin:0 4px 4px 0;min-width:0;font-size:11px',
            title: t,
            onclick: () => {
              ta.value = t;
              ta.focus();
            },
          },
          t.length > 22 ? `${t.slice(0, 20)}...` : t,
        ),
      ),
    );
    const root3d = h(
      'div',
      {},
      note(
        'Describe a part in your own words (Korean or English). The local model plans it as a list of modelling steps; MacCAD builds, checks and inserts the solid. Nothing is typed in LISP.',
      ),
      h('div', { class: 'frow' }, h('label', {}, 'Model:'), modelSel),
      ta,
      chips,
      h(
        'div',
        { class: 'frow', style: 'flex-wrap:wrap' },
        h('label', {}, 'Reference:'),
        useSel,
        pickBtn,
        clearRef,
        refLabel,
      ),
      h('div', { class: 'aiBtns' }, go, showPlan, rebuild),
      cv,
      info,
      steps,
      h('div', { class: 'frow', style: 'margin-top:6px' }, mod, again),
      planBox,
      out,
    );
    root3d.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) ev.preventDefault();
    });
    root3d.addEventListener('drop', async (ev) => {
      // a drawing file dropped here is a reference, it is NOT opened
      const f = ev.dataTransfer && ev.dataTransfer.files[0];
      if (!f) return;
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const nm = f.name.replace(/\.[^.]+$/, '');
        let d;
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
          throw new Error(
            'A picture cannot be read by the local text model. Drop a DXF, DWG or MCAD drawing instead.',
          );
        if (window.api && window.api.pathForFile) {
          const r = await window.api.readFile(window.api.pathForFile(f));
          if (!r || r.error) throw new Error((r && r.error) || 'The file could not be read.');
          d = r.dwg
            ? dwgToDoc(r.dwg, nm).doc
            : /\.dxf$/i.test(f.name)
              ? importDXF(r.data, nm).doc
              : Doc.fromJSON(JSON.parse(r.data));
        } else {
          const text = await f.text();
          d = /\.dxf$/i.test(f.name) ? importDXF(text, nm).doc : Doc.fromJSON(JSON.parse(text));
        }
        setRef(buildReference(d, d.model), f.name);
      } catch (err) {
        out.classList.add('aiErr');
        out.textContent = `⚠ ${err.message}`;
      }
    });
    panes.push(root3d);
  }

  /** @private The "Assistant (LISP)" tab: a request in words -> AutoLISP code that can be reviewed and run. */
  buildLispTab() {
    const { outBox, app, panes, note } = this;

    const ta = h('textarea', {
      class: 'aiPrompt',
      rows: 3,
      placeholder:
        'e.g. Draw a 100 x 60 rectangle with R10 rounded corners and put its area as text in the middle.',
    });
    const code = h('textarea', {
      class: 'aiCode',
      rows: 12,
      spellcheck: 'false',
      placeholder: 'The generated AutoLISP code appears here. You can edit it before running it.',
    });
    const out = outBox();
    const explain = h('div', { class: 'aiExplain' });
    let lastErr = '';
    const gen = h('button', { class: 'b' }, 'Generate');
    const run = h('button', { class: 'b primary' }, 'Run');
    const fix = h('button', { class: 'b' }, 'Fix with AI');
    const save = h('button', { class: 'b' }, 'Save .lsp');
    gen.onclick = () =>
      busy(gen, out, async () => {
        out.classList.remove('aiErr');
        out.textContent = '';
        explain.textContent = '';
        const text = await AiModel.ask(app, [
          { role: 'system', content: SYS_LISP(app, app.curEnts()) },
          { role: 'user', content: ta.value.trim() },
        ]);
        code.value = AiText.extractCode(text);
        explain.textContent = text.replace(/```[\s\S]*?```/g, '').trim();
      });
    run.onclick = async () => {
      out.classList.remove('aiErr');
      out.textContent = '';
      const before = app.log.length;
      const solids0 = app.doc.model.filter((e) => e.type === 'solid3d').length;
      try {
        await app.runLisp(code.value);
      } catch (err) {
        out.textContent = `⚠ ${err.message}`;
        out.classList.add('aiErr');
        lastErr = err.message;
        return;
      }
      await new Promise((r) => setTimeout(r, 120));
      if (app.doc.model.filter((e) => e.type === 'solid3d').length > solids0 && !app.v3) {
        app.enter3D('swiso');
        app.zoomExtents(false);
      } // show a new 3D result right away
      const added = app.log.slice(before).filter((l) => !/^Command: /.test(l));
      out.textContent = added.join('\n') || 'Done.';
      lastErr = added.find((l) => /error|bad|unknown|not defined|too few|too many/i.test(l)) || '';
      if (lastErr) out.classList.add('aiErr');
    };
    fix.onclick = () =>
      busy(fix, out, async () => {
        const text = await AiModel.ask(app, [
          { role: 'system', content: SYS_LISP(app, app.curEnts()) },
          { role: 'user', content: ta.value.trim() },
          { role: 'assistant', content: '```lisp\n' + code.value + '\n```' },
          {
            role: 'user',
            content: `Running this code gave: ${lastErr || out.textContent || '(no output, but the result is wrong)'}\nFix it and reply with the complete corrected code.`,
          },
        ]);
        code.value = AiText.extractCode(text);
        explain.textContent = text.replace(/```[\s\S]*?```/g, '').trim();
        out.textContent = 'Corrected code received. Press Run to try it.';
        out.classList.remove('aiErr');
      });
    save.onclick = async () => {
      const blob = new Blob([code.value], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ai-generated.lsp';
      document.body.append(a);
      a.click();
      a.remove();
    };
    panes.push(
      h(
        'div',
        {},
        note(
          'Describe what you want in your own words. The local model writes AutoLISP; nothing is executed until you press Run.',
        ),
        ta,
        h('div', { class: 'aiBtns' }, gen, run, fix, save),
        code,
        explain,
        out,
      ),
    );
  }

  /** @private The "Text correction" tab: corrects or translates the texts of the drawing. */
  buildTextTab() {
    const { outBox, app, c, panes, note } = this;

    const mode = h(
      'select',
      { name: 'mode' },
      ...[
        ['fix', 'Fix typos, spacing and punctuation'],
        ['translate', 'Translate'],
        ['tidy', 'Tidy notation (units, abbreviations, capitalisation)'],
      ].map(([v, l]) => h('option', { value: v }, l)),
    );
    const lang = h(
      'select',
      { name: 'lang' },
      ...['English', 'Korean', 'Japanese', 'Chinese'].map((l) => h('option', { value: l }, l)),
    );
    const scope = h(
      'select',
      { name: 'scope' },
      h('option', { value: 'sel' }, 'Selected text (or all text if nothing is selected)'),
      h('option', { value: 'all' }, 'All text in the drawing'),
    );
    const list = h('div', { class: 'aiList' });
    const out = outBox();
    const go = h('button', { class: 'b primary' }, 'Check text');
    const apply = h('button', { class: 'b' }, 'Apply ticked changes');
    let proposals = [];
    const render = () => {
      list.innerHTML = '';
      for (const p of proposals)
        list.append(
          h(
            'label',
            { class: 'aiRow' },
            h('input', {
              type: 'checkbox',
              checked: p.on,
              onchange: (ev) => {
                p.on = ev.target.checked;
              },
            }),
            h('span', { class: 'aiOld' }, p.old),
            h('span', { class: 'aiArrow' }, '→'),
            h('span', { class: 'aiNew' }, p.text),
          ),
        );
      apply.disabled = !proposals.length;
    };
    go.onclick = () =>
      busy(go, out, async () => {
        out.classList.remove('aiErr');
        out.textContent = '';
        proposals = [];
        render();
        let ents = app.curEnts().filter((e) => AiText.isTextEnt(e) && c.doc.visible(e));
        const sel = ents.filter((e) => app.sel.has(e.id));
        if (scope.value === 'sel' && sel.length) ents = sel;
        ents = ents.filter((e) => AiText.plainText(e).trim()).slice(0, 300);
        if (!ents.length) {
          out.textContent = 'There is no text to check.';
          return;
        }
        const task =
          mode.value === 'translate'
            ? `Translate every text into ${lang.value}. Keep numbers, units, part numbers and symbols unchanged.`
            : mode.value === 'tidy'
              ? 'Tidy the notation: consistent units and abbreviations, sensible capitalisation, no double spaces. Do not change numeric values.'
              : 'Fix typos, wrong spacing and punctuation only. Keep the language, the meaning, the numbers and the units. Do not rephrase.';
        const sys = `You edit text labels of CAD drawings. ${task}\nReturn ONLY JSON: {"items":[{"id":<number>,"text":"<text>"}]} with exactly the ids you were given. Keep control codes unchanged (\\P, {\\f...;}, %%c, %%d, %%p, \\U+XXXX). If a text needs no change return it unchanged.`;
        let done = 0;
        for (let i = 0; i < ents.length; i += 30) {
          const batch = ents.slice(i, i + 30);
          const body = JSON.stringify({
            items: batch.map((e) => ({ id: e.id, text: AiText.plainText(e) })),
          });
          const res = AiText.extractJson(
            await AiModel.ask(
              app,
              [
                { role: 'system', content: sys },
                { role: 'user', content: body },
              ],
              { json: true, temperature: 0 },
            ),
          );
          const byId = new Map(batch.map((e) => [e.id, e]));
          for (const it of res.items || []) {
            const e = byId.get(it.id);
            if (!e || typeof it.text !== 'string') continue;
            if (
              it.text !== AiText.plainText(e) &&
              it.text.length <= AiText.plainText(e).length * 4 + 20
            )
              proposals.push({ id: e.id, old: AiText.plainText(e), text: it.text, on: true });
          }
          done += batch.length;
          out.textContent = `Checked ${done} of ${ents.length}...`;
        }
        out.textContent = proposals.length
          ? `${proposals.length} change(s) proposed. Untick the ones you do not want, then apply.`
          : 'No changes were proposed.';
        render();
      });
    apply.onclick = () => {
      const on = proposals.filter((p) => p.on);
      if (!on.length) return;
      app.edit('AI TEXT CORRECTION', () => {
        for (const p of on) {
          const e = app.curEnts().find((x) => x.id === p.id);
          if (e) e.str = p.text;
        }
      });
      out.textContent = `${on.length} text(s) changed. Undo restores them (Cmd+Z).`;
      proposals = [];
      render();
    };
    render();
    panes.push(
      h(
        'div',
        {},
        note(
          'The model reads the text and proposes corrections. Nothing changes until you press "Apply".',
        ),
        h('div', { class: 'frow' }, h('label', {}, 'Scope:'), scope),
        h('div', { class: 'frow' }, h('label', {}, 'Task:'), mode, lang),
        h('div', { class: 'aiBtns' }, go, apply),
        list,
        out,
      ),
    );
  }

  /** @private The "Layers" tab: sorts the objects onto layers by what they are. */
  buildLayersTab() {
    const { outBox, app, c, doc, panes, note } = this;

    const out = outBox();
    const list = h('div', { class: 'aiList' });
    const go = h('button', { class: 'b primary' }, 'Suggest layers');
    const apply = h('button', { class: 'b' }, 'Apply ticked suggestions');
    let props = [];
    const render = () => {
      list.innerHTML = '';
      for (const p of props)
        list.append(
          h(
            'label',
            { class: 'aiRow' },
            h('input', {
              type: 'checkbox',
              checked: p.on,
              onchange: (ev) => {
                p.on = ev.target.checked;
              },
            }),
            h('span', { class: 'aiOld' }, `${p.desc}  (${p.ids.length})`),
            h('span', { class: 'aiArrow' }, '→'),
            h('b', {}, p.layer),
            h('span', { class: 'aiWhy' }, p.reason || ''),
          ),
        );
      apply.disabled = !props.length;
    };
    go.onclick = () =>
      busy(go, out, async () => {
        out.classList.remove('aiErr');
        out.textContent = '';
        props = [];
        render();
        const groups = new Map();
        for (const e of app.curEnts()) {
          if (!c.doc.visible(e)) continue;
          const k = `${e.type}|${e.layer}|${e.color ?? ''}`;
          if (!groups.has(k))
            groups.set(k, {
              type: e.type,
              layer: e.layer,
              color: e.color ?? 'bylayer',
              ids: [],
              sample: null,
            });
          const g = groups.get(k);
          g.ids.push(e.id);
          if (!g.sample && AiText.isTextEnt(e)) g.sample = AiText.plainText(e).slice(0, 40);
        }
        const arr = [...groups.values()].slice(0, 80).map((g, i) => ({
          id: i,
          type: g.type,
          now: g.layer,
          color: g.color,
          count: g.ids.length,
          sample: g.sample || undefined,
        }));
        if (!arr.length) {
          out.textContent = 'The drawing is empty.';
          return;
        }
        const sys =
          'You organise CAD drawings into layers. For every group of objects choose a clear, conventional layer name (UPPERCASE ASCII, e.g. WALL, DOOR, WINDOW, FURNITURE, DIM, TEXT, HATCH, CENTER, HIDDEN, TITLE, FRAME, 0). Keep an existing sensible layer name. Return ONLY JSON: {"groups":[{"id":<number>,"layer":"<NAME>","reason":"<very short reason>"}]}.';
        const res = AiText.extractJson(
          await AiModel.ask(
            app,
            [
              { role: 'system', content: sys },
              {
                role: 'user',
                content: JSON.stringify({
                  existingLayers: doc.layers.map((l) => l.name),
                  groups: arr,
                }),
              },
            ],
            { json: true, temperature: 0.1 },
          ),
        );
        const list2 = [...groups.values()];
        for (const r of res.groups || []) {
          const g = list2[r.id];
          const name = String(r.layer || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_$\-]/g, '')
            .slice(0, 31);
          if (g && name && name !== g.layer)
            props.push({
              desc: `${g.type} on ${g.layer}`,
              ids: g.ids,
              layer: name,
              reason: r.reason,
              on: true,
            });
        }
        out.textContent = props.length
          ? `${props.length} suggestion(s). Untick the ones you do not want, then apply.`
          : 'The layers already look right.';
        render();
      });
    apply.onclick = () => {
      const on = props.filter((p) => p.on);
      if (!on.length) return;
      app.edit('AI LAYER CLASSIFICATION', () => {
        for (const p of on) {
          if (!doc.hasLayer(p.layer)) doc.addLayer(p.layer);
          const ids = new Set(p.ids);
          for (const e of app.curEnts()) if (ids.has(e.id)) e.layer = p.layer;
        }
      });
      out.textContent = `${on.length} group(s) moved. Undo restores them (Cmd+Z).`;
      props = [];
      render();
    };
    render();
    panes.push(
      h(
        'div',
        {},
        note(
          'Groups the objects (by type, layer and colour) and proposes layer names. You decide which proposals to apply.',
        ),
        h('div', { class: 'aiBtns' }, go, apply),
        list,
        out,
      ),
    );
  }

  /** @private The "Describe" tab: a description of the drawing in words. */
  buildDescribeTab() {
    const { app, c, doc, panes, note } = this;

    const out = h('pre', { class: 'aiOut aiBig' });
    const go = h('button', { class: 'b primary' }, 'Describe this drawing');
    go.onclick = () =>
      busy(go, out, async () => {
        out.classList.remove('aiErr');
        out.textContent = '';
        const ents = app.curEnts().filter((e) => c.doc.visible(e));
        out.textContent = await AiModel.ask(
          app,
          [
            {
              role: 'system',
              content: `You describe CAD drawings for a colleague who cannot see them. Write 5 to 8 plain lines in ${cfgOf(app).lang}: what the drawing most likely shows, its size, how it is organised (layers), notable text, and anything odd (empty layers, duplicate objects, mixed units). Do not invent details that the summary does not support.`,
            },
            { role: 'user', content: AiDrawing.summarize(doc, ents) },
          ],
          { temperature: 0.3 },
        );
      });
    panes.push(
      h(
        'div',
        {},
        note(
          'Sends a short summary of the drawing (counts, layers, extents and a few texts, not the geometry) to the local model.',
        ),
        h('div', { class: 'aiBtns' }, go),
        out,
      ),
    );
  }

  /** @private The "Settings" tab: server address, server type, model, language, API key. */
  buildSettingsTab() {
    const { app, outBox, panes, note } = this;

    const cfg = cfgOf(app);
    const out = outBox();
    const ep = h('input', {
      type: 'text',
      name: 'endpoint',
      value: cfg.endpoint,
      style: 'width:100%',
    });
    const apiSel = h(
      'select',
      { name: 'api' },
      ...[
        ['auto', 'Detect (port 11434 = Ollama)'],
        ['ollama', 'Ollama'],
        ['openai', 'OpenAI-compatible (LM Studio, llama.cpp, vLLM...)'],
      ].map(([v, l]) => h('option', { value: v, ...(cfg.api === v ? { selected: true } : {}) }, l)),
    );
    const model = h('input', {
      type: 'text',
      name: 'model',
      value: cfg.model,
      list: 'aiModels',
      placeholder: 'e.g. qwen2.5:7b',
      style: 'width:100%',
    });
    const dl = h('datalist', { id: 'aiModels' });
    const lang = h(
      'select',
      { name: 'lang' },
      ...['Korean', 'English', 'Japanese', 'Chinese'].map((l) =>
        h('option', { value: l, ...(cfg.lang === l ? { selected: true } : {}) }, l),
      ),
    );
    const remote = h('input', {
      type: 'checkbox',
      name: 'allowRemote',
      ...(cfg.allowRemote ? { checked: true } : {}),
    });
    const key = h('input', {
      type: 'password',
      name: 'apiKey',
      value: cfg.apiKey,
      placeholder: 'empty = use the environment variable OPENAI_API_KEY',
      style: 'width:100%',
    });
    const keyNote = h('div', { class: 'osTip' }, 'Checking OPENAI_API_KEY...');
    (async () => {
      try {
        const k = api() && api().aiKeyInfo ? await api().aiKeyInfo() : null;
        keyNote.textContent =
          k && k.ok
            ? k.set
              ? 'The environment variable OPENAI_API_KEY is set: it is sent as the API key to the server above (the key itself is never shown or saved). Typing a key here overrides it.'
              : 'The environment variable OPENAI_API_KEY is not set. Local servers such as Ollama and LM Studio do not need it. To use it: export OPENAI_API_KEY=... in ~/.zshrc and restart MacCAD.'
            : '';
      } catch {
        keyNote.textContent = '';
      }
    })();
    const read = () => ({
      endpoint: ep.value.trim(),
      api: apiSel.value,
      model: model.value.trim(),
      lang: lang.value,
      allowRemote: remote.checked,
      apiKey: key.value,
    });
    const persist = () => {
      app.settings.ai = read();
      app.saveSettings();
    };
    const refresh = h('button', { class: 'b' }, 'Refresh models');
    const test = h('button', { class: 'b primary' }, 'Test connection');
    refresh.onclick = () =>
      busy(refresh, out, async () => {
        out.classList.remove('aiErr');
        if (!api() || !api().aiModels) throw new Error('Needs the desktop app.');
        const c0 = read();
        const r = await api().aiModels({
          endpoint: c0.endpoint,
          api: c0.api,
          allowRemote: c0.allowRemote,
          apiKey: c0.apiKey,
        });
        if (!r.ok) throw new Error(r.error);
        dl.innerHTML = '';
        r.models.forEach((m) => dl.append(h('option', { value: m })));
        if (!model.value && r.models[0]) model.value = r.models[0];
        out.textContent = r.models.length
          ? `${r.models.length} model(s) found: ${r.models.join(', ')}`
          : 'The server is reachable but has no models. With Ollama run:  ollama pull qwen2.5:7b';
        persist();
      });
    test.onclick = () =>
      busy(test, out, async () => {
        out.classList.remove('aiErr');
        persist();
        const t0 = Date.now();
        const text = await AiModel.ask(
          app,
          [{ role: 'user', content: 'Reply with the single word: ready' }],
          {
            temperature: 0,
          },
        );
        out.textContent = `Connected (${((Date.now() - t0) / 1000).toFixed(1)} s). The model answered: ${text.trim().slice(0, 80)}`;
      });
    for (const el of [ep, apiSel, model, lang, remote, key]) el.addEventListener('change', persist);
    panes.push(
      h(
        'div',
        {},
        note(
          'The assistant talks to a language model that runs on THIS Mac (for example Ollama). Drawing data never leaves the computer unless you allow a non-local server below.',
        ),
        h('div', { class: 'frow' }, h('label', {}, 'Server address:'), ep),
        h('div', { class: 'frow' }, h('label', {}, 'Server type:'), apiSel),
        h('div', { class: 'frow' }, h('label', {}, 'Model:'), model, dl),
        h('div', { class: 'frow' }, h('label', {}, 'Answer language:'), lang),
        h('div', { class: 'frow' }, h('label', {}, 'API key:'), key),
        keyNote,
        h(
          'label',
          { class: 'chk' },
          remote,
          ' Allow a non-local server (the drawing summary and texts are then sent over the network)',
        ),
        h('div', { class: 'aiBtns' }, refresh, test),
        out,
        note(
          'Getting started with Ollama:  1) install Ollama   2) run  ollama pull qwen2.5:7b   3) press "Test connection".',
        ),
      ),
    );
  }

  /** Shows tab i. */
  show(i) {
    const { tabsEl, pane, panes } = this;

    [...tabsEl.children].forEach((t, j) => t.classList.toggle('on', j === i));
    pane.innerHTML = '';
    pane.append(panes[i]);
  }

  /**
   * Shows an error in the status line with a link to the settings.
   * @private
   * @param {string} msg
   * @param {boolean} [canStart] the server is not answering at a local address, so Ollama (installed on this Mac) can be started from here
   */
  bad(msg, canStart = false) {
    const { app } = this;

    this.status.className = 'aiStatus bad';
    this.status.textContent = '';
    this.status.append(
      msg + ' ',
      h('a', { onclick: () => this.show(5) }, 'Open Settings'),
      '  |  Setup: install Ollama (ollama.com), run  ollama pull qwen2.5:7b  in the Terminal, then reopen this window.',
    );
    if (!canStart || !api() || !api().aiStart) return;
    const why = h('span', { style: 'margin-left:8px' });
    const go = h(
      'button',
      {
        type: 'button',
        class: 'b',
        style: 'margin-left:10px;min-width:0;padding:0 12px',
        title:
          'Starts the Ollama server on this Mac, the same as typing "ollama serve" in the Terminal. It keeps running after MacCAD quits.',
      },
      'Start Ollama',
    );
    go.onclick = async () => {
      go.disabled = true;
      go.textContent = 'Starting...';
      why.textContent = '';
      const r = await api().aiStart({ endpoint: cfgOf(app).endpoint });
      if (r && r.ok) {
        this.status.className = 'aiStatus';
        this.status.textContent = 'Checking the local AI server...';
        this.check().catch((err) => this.bad(`○ ${err.message}`));
        return;
      }
      go.disabled = false;
      go.textContent = 'Start Ollama';
      why.textContent = (r && r.error) || 'Ollama could not be started.';
    };
    this.status.append(go, why);
  }

  /** Connection check: is a local model server running and is a model chosen? (no training or data set is needed: the model is downloaded once with Ollama) */
  async check() {
    const { app } = this;

    const cfg = cfgOf(app);
    if (hooks.transport) {
      this.status.textContent = '● Test connection';
      return;
    }
    if (!api() || !api().aiModels) {
      this.bad('○ The AI assistant needs the desktop app.');
      return;
    }
    const r = await api().aiModels({
      endpoint: cfg.endpoint,
      api: cfg.api,
      allowRemote: cfg.allowRemote,
      apiKey: cfg.apiKey,
    });
    if (!r.ok) {
      this.bad(
        `○ Not connected: ${r.error}`,
        /ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND/i.test(String(r.error)) &&
          /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(String(cfg.endpoint || '')),
      );
      return;
    }
    if (!r.models.length) {
      this.bad('○ The server is running but has no model yet.');
      return;
    }
    let model = cfg.model;
    if (!model || !r.models.includes(model)) {
      model = AiModel.pick3DModel(r.models, '');
      app.settings.ai = { ...cfg, model };
      app.saveSettings();
      const inp = document.querySelector('.aiDlg [name=model]');
      if (inp) inp.value = model;
    }
    this.status.className = 'aiStatus ok';
    this.status.textContent = `● Connected  |  model: ${model}  (${r.models.length} installed; change it in Settings)`;
  }

  /**
   * Builds the tabs and shows the window.
   * @param {number} [startTab] the tab to start on
   * @returns {Promise<unknown>} resolves when the window is closed
   */
  async open(startTab = 0) {
    const { c, tabsEl, pane, names } = this;
    this.build3dTab();
    this.buildLispTab();
    this.buildTextTab();
    this.buildLayersTab();
    this.buildDescribeTab();
    this.buildSettingsTab();
    names.forEach((n, i) => tabsEl.append(h('span', { onclick: () => this.show(i) }, n)));
    this.show(startTab);
    this.status = h('div', { class: 'aiStatus' }, 'Checking the local AI server...');
    this.check().catch((err) => this.bad(`○ ${err.message}`));
    await c.ui.dialog({
      title: 'AI Assistant (local model)',
      body: h('div', { class: 'aiDlg' }, this.status, tabsEl, pane),
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
  }
}

export const extractCode = AiText.extractCode;
export const extractJson = AiText.extractJson;
export const isTextEnt = AiText.isTextEnt;
export const summarizeDrawing = AiDrawing.summarize;
export const cleanupEntities = AiDrawing.cleanup;
export const pick3DModel = AiModel.pick3DModel;
