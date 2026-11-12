/**
 * @file lisp.js
 * @brief The AutoLISP-compatible interpreter ("MacLISP").
 *
 * Dialect notes: nil == (); integers are JS numbers, reals are Real boxes; locals declared after
 * "/" in defun are dynamically scoped exactly like AutoLISP. All evaluation is asynchronous so
 * that interactive functions (getpoint, command, ssget ...) can wait for the user.
 *
 * Layout of this file: data types (Sym, Real, Pair, ...), LispReader (text -> forms),
 * LispPrinter (values -> text), small argument helpers, Lisp (the interpreter) and
 * LispBuiltins (the built-in functions, in groups). The cad functions (entities, selection sets,
 * commands) are added by lispcad.js.
 */

/* ============================================================================================
 * 1. DATA TYPES
 * ========================================================================================== */

/** A symbol (names are upper case; the same name is always the same object, see `sym`). */
export class Sym {
  /** @param {string} name the (upper case) name */
  constructor(name) {
    this.name = name;
  }

  /** @returns {string} the name */
  toString() {
    return this.name;
  }
}

/** All symbols by name. */
const symtab = new Map();

/** The symbol with this name (names are case-insensitive: upper-cased, one object per name). */
export const sym = (n) => {
  n = String(n).toUpperCase();
  let s = symtab.get(n);
  if (!s) {
    s = new Sym(n);
    symtab.set(n, s);
  }
  return s;
};

/** A real number (integers are plain JS numbers, so that 1 and 1.0 can be told apart). */
export class Real {
  /** @param {number} v the value */
  constructor(v) {
    this.v = v;
  }
}

/** A dotted pair (car . cdr). */
export class Pair {
  /**
   * @param {*} car
   * @param {*} cdr
   */
  constructor(car, cdr) {
    this.car = car;
    this.cdr = cdr;
  }
}

/**
 * A user function made by defun or lambda: parameters, local variables (after the "/"), body forms.
 */
export class Lambda {
  /**
   * @param {Sym[]} params
   * @param {Sym[]} locals
   * @param {Array} body
   * @param {string} name
   */
  constructor(params, locals, body, name) {
    this.params = params;
    this.locals = locals;
    this.body = body;
    this.name = name;
  }
}

/** A built-in function. */
export class Subr {
  /**
   * @param {string} name
   * @param {Function} fn called with the evaluated arguments; may be async
   */
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
  }
}

/** An entity name (the id of an object in a space). */
export class EName {
  /**
   * @param {number} id
   * @param {string} space 'model' or a layout name
   */
  constructor(id, space) {
    this.id = id;
    this.space = space;
  }
}

/** A selection set: the ids of the selected objects. */
export class PickSet {
  /**
   * @param {number[]} [ids]
   * @param {string} [space]
   */
  constructor(ids = [], space = 'model') {
    this.ids = ids;
    this.space = space;
  }
}

/** An open file of the LISP file functions (open, read-line, write-line, close). */
export class LFile {
  /**
   * @param {string} name
   * @param {string} mode 'r', 'w' or 'a'
   * @param {string} [text] the text of a file opened for reading
   */
  constructor(name, mode, text) {
    this.name = name;
    this.mode = mode;
    this.text = text || '';
    this.pos = 0;
    this.closed = false;
  }
}

/** An AutoLISP error (the text goes to the *error* handler or the command line). */
export class LispError extends Error {
  /**
   * @param {string} msg the message
   * @param {*} [data] extra data for the error handler
   */
  constructor(msg, data) {
    super(msg);
    this.lispMessage = msg;
    this.data = data;
  }
}

/** Thrown by (exit) / (quit) to stop the running program. */
export class LispExit extends Error {}

/** The symbol T (true). */
export const T = sym('T');

/** Makes a real number. */
export const R = (v) => new Real(v);

/** @returns {boolean} true for integers and reals. */
export const isNum = (x) => typeof x === 'number' || x instanceof Real;

/** The number value of a LISP number (NaN for anything else). */
export const nv = (x) => (typeof x === 'number' ? x : x instanceof Real ? x.v : NaN);

/** @returns {boolean} true for nil and lists. */
export const isList = (x) => x === null || Array.isArray(x);

/** @returns T for true, nil for false. */
export const toBool = (b) => (b ? T : null);

/* ============================================================================================
 * 2. READER (SOURCE TEXT -> FORMS)
 * ========================================================================================== */

/** Reads AutoLISP source text. */
export class LispReader {
  /**
   * Reads all forms of a source text.
   * @returns {Array} the forms (nil is null, lists are arrays)
   * @throws {LispError} on unbalanced parentheses or strings
   */
  static parse(src) {
    let i = 0;
    const n = src.length;
    const forms = [];
    const ws = () => {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i += 1;
        if (src[i] === ';') {
          if (src[i + 1] === '|') {
            const e = src.indexOf('|;', i + 2);
            i = e < 0 ? n : e + 2;
          } else {
            while (i < n && src[i] !== '\n') i += 1;
          }
        } else break;
      }
    };
    const readString = () => {
      i += 1;
      let s = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          i += 1;
          const c = src[i];
          if (c === 'n') s += '\n';
          else if (c === 't') s += '\t';
          else if (c === 'r') s += '\r';
          else if (c === 'e') s += '\x1b';
          else if (/[0-7]/.test(c)) {
            let o = c;
            while (o.length < 3 && /[0-7]/.test(src[i + 1] || '')) o += src[++i];
            s += String.fromCharCode(parseInt(o, 8));
          } else if (c === 'U' && src[i + 1] === '+') {
            const hex = src.substr(i + 2, 4);
            s += String.fromCharCode(parseInt(hex, 16));
            i += 5;
          } else s += c;
          i += 1;
        } else s += src[i++];
      }
      if (i >= n) throw new LispError('malformed string on input');
      i += 1;
      return s;
    };
    const readAtom = () => {
      const st = i;
      while (i < n && !/[\s()'";]/.test(src[i])) i += 1;
      const tok = src.slice(st, i);
      if (/^[+-]?\d+$/.test(tok)) return parseInt(tok, 10);
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) return new Real(parseFloat(tok));
      if (/^nil$/i.test(tok)) return null;
      return sym(tok);
    };
    const read = () => {
      ws();
      if (i >= n) return undefined;
      const c = src[i];
      if (c === '(') {
        i += 1;
        const items = [];
        let tail;
        for (;;) {
          ws();
          if (i >= n) throw new LispError('malformed list on input');
          if (src[i] === ')') {
            i += 1;
            break;
          }
          if (src[i] === '.' && /[\s()]/.test(src[i + 1] || ' ')) {
            i += 1;
            tail = read();
            ws();
            if (src[i] === ')') i += 1;
            break;
          }
          items.push(read());
        }
        if (tail !== undefined) {
          if (items.length === 1) return new Pair(items[0], tail);
          throw new LispError('dotted list must have a single head element');
        }
        return items.length ? items : null;
      }
      if (c === ')') {
        i += 1;
        throw new LispError('extra right paren on input');
      }
      if (c === "'") {
        i += 1;
        return [sym('QUOTE'), read()];
      }
      if (c === '#' && src[i + 1] === "'") {
        i += 2;
        return [sym('FUNCTION'), read()];
      }
      if (c === '"') return readString();
      if (c === '!' && /[A-Za-z_*]/.test(src[i + 1] || '')) {
        i += 1;
        const a = readAtom();
        return a;
      }
      return readAtom();
    };
    for (;;) {
      const f = read();
      if (f === undefined) break;
      forms.push(f);
    }
    return forms;
  }

  /**
   * @returns {number} the number of unbalanced parentheses of a source buffer, ignoring strings
   *     and comments (used by the editor and the command line)
   */
  static parenBalance(src) {
    let d = 0;
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ';') {
        if (src[i + 1] === '|') {
          const e = src.indexOf('|;', i + 2);
          i = e < 0 ? src.length : e + 2;
          continue;
        }
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '"') {
        i += 1;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') i += 1;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (c === '(') d += 1;
      else if (c === ')') d -= 1;
      i += 1;
    }
    return d;
  }
}

export const parse = LispReader.parse;
export const parenBalance = LispReader.parenBalance;

/* ============================================================================================
 * 3. PRINTER (VALUES -> TEXT)
 * ========================================================================================== */

/** Turns values into the text AutoLISP prints. */
export class LispPrinter {
  /** @returns {string} a real number as AutoLISP prints it (6 digits, with a decimal point). */
  static fmtReal(v) {
    if (!isFinite(v)) return v > 0 ? '1.#INF' : v < 0 ? '-1.#INF' : '1.#QNAN';
    let s = Number(v.toPrecision(6)).toString();
    if (/e/.test(s)) {
      const [m, e] = s.split('e');
      return `${/\./.test(m) ? m : m + '.0'}e${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(3, '0')}`;
    }
    if (!/\./.test(s)) s += '.0';
    return s;
  }
  /** @returns {string} a value as text; `quote` = strings with quotes and escapes (prin1), else princ. */
  static toStr(x, quote = false) {
    if (x === null) return 'nil';
    if (typeof x === 'number') return String(x);
    if (x instanceof Real) return LispPrinter.fmtReal(x.v);
    if (typeof x === 'string')
      return quote
        ? '"' +
            x
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\t/g, '\\t')
              .replace(/\r/g, '\\r')
              .replace(/\x1b/g, '\\e') +
            '"'
        : x;
    if (x instanceof Sym) return x.name;
    if (Array.isArray(x)) return '(' + x.map((e) => LispPrinter.toStr(e, quote)).join(' ') + ')';
    if (x instanceof Pair)
      return `(${LispPrinter.toStr(x.car, quote)} . ${LispPrinter.toStr(x.cdr, quote)})`;
    if (x instanceof Lambda) return `#<USUBR @${(x.name || 'lambda').toLowerCase()}>`;
    if (x instanceof Subr) return `#<SUBR @${x.name.toLowerCase()} ${x.name.toLowerCase()}>`;
    if (x instanceof EName) return `<Entity name: ${x.id.toString(16)}>`;
    if (x instanceof PickSet) return `<Selection set: ${x.ids.length}>`;
    if (x instanceof LFile) return `#<file "${x.name}">`;
    return String(x);
  }
}

export const fmtReal = LispPrinter.fmtReal;
export const toStr = LispPrinter.toStr;

/**
 * The `equal` function: structural equality; numbers are equal when they differ by at most `fuzz`.
 */
export function equal(a, b, fuzz = 0) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return Math.abs(nv(a) - nv(b)) <= fuzz;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => equal(x, b[i], fuzz));
  if (a instanceof Pair && b instanceof Pair)
    return equal(a.car, b.car, fuzz) && equal(a.cdr, b.cdr, fuzz);
  if (a instanceof EName && b instanceof EName) return a.id === b.id;
  return false;
}
const eqv = (a, b) =>
  a === b ||
  (typeof a === 'number' && typeof b === 'number' && a === b) ||
  (a instanceof Real && b instanceof Real && a.v === b.v) ||
  (a instanceof EName && b instanceof EName && a.id === b.id);

const typeError = (fn, x) => new LispError(`bad argument type: ${fn}: ${toStr(x, true)}`);

/**
 * Checks that an argument is a number and returns it.
 * @throws {LispError} bad argument type: numberp
 */
export function numArg(fn, x) {
  const v = nv(x);
  if (Number.isNaN(v)) throw typeError('numberp', x);
  return v;
}
const strArg = (x) => {
  if (typeof x !== 'string') throw typeError('stringp', x);
  return x;
};
const listArg = (x) => {
  if (x === null) return [];
  if (!Array.isArray(x)) throw typeError('listp', x);
  return x;
};

/**
 * The interpreter: global variables, special forms, evaluation, error handling and output
 * buffering. The built-in functions are installed by LispBuiltins; `host` gives access to the
 * application (echo, commands, files).
 */
export class Lisp {
  /**
   * @param {object} [host] the application: echo(line), registerCommand(name, fn), file access, ...
   */
  constructor(host = {}) {
    this.host = host;
    this.globals = new Map();
    this.special = new Map();
    this.depth = 0;
    this.outBuf = '';
    this.loaded = [];
    this.userCommands = new Map();
    this.install();
  }

  // ---------------------------------------------------------------- output

  /**
   * Writes text to the command line; complete lines are sent to the host at once, the rest is
   * buffered.
   */
  write(text) {
    this.outBuf += text;
    let k;
    while ((k = this.outBuf.indexOf('\n')) >= 0) {
      this.emitLine(this.outBuf.slice(0, k));
      this.outBuf = this.outBuf.slice(k + 1);
    }
  }

  /** @private Sends one line to the host. */
  emitLine(l) {
    if (this.host.echo) this.host.echo(l);
  }

  /** Sends the buffered partial line to the host. */
  flush() {
    if (this.outBuf) {
      this.emitLine(this.outBuf);
      this.outBuf = '';
    }
  }

  /** Defines a built-in function. */
  def(name, fn) {
    const s = sym(name);
    this.globals.set(s.name, new Subr(s.name, fn));
  }

  /** Defines a special form (it gets the interpreter and the unevaluated form). */
  defSpecial(name, fn) {
    this.special.set(sym(name).name, fn);
  }

  /** @returns the value of a global variable (nil when it has none). */
  get(name) {
    const v = this.globals.get(sym(name).name);
    return v === undefined ? null : v;
  }

  /** Sets a global variable. */
  set(name, v) {
    this.globals.set(sym(name).name, v);
  }

  // ---------------------------------------------------------------- evaluation

  /** Evaluates one form. */
  async evalForm(x) {
    if (x === null || typeof x !== 'object') return x === undefined ? null : x;
    if (x instanceof Sym) {
      const v = this.globals.get(x.name);
      return v === undefined ? null : v;
    }
    if (!Array.isArray(x)) return x;
    const head = x[0];
    if (head instanceof Sym) {
      const sp = this.special.get(head.name);
      if (sp) return sp(this, x);
      let f = this.globals.get(head.name);
      if (f === undefined || f === null) {
        f = this.resolveMissing && this.resolveMissing(head.name);
        if (!f) throw new LispError(`no function definition: ${head.name}`);
        this.globals.set(head.name, f);
      }
      return this.callWithForms(f, x.slice(1), head.name);
    }
    if (Array.isArray(head) && head[0] instanceof Sym && head[0].name === 'LAMBDA')
      return this.callWithForms(await this.evalForm(head), x.slice(1), 'lambda');
    throw new LispError(`bad function: ${toStr(head, true)}`);
  }

  /** @private Evaluates the argument forms and calls the function. */
  async callWithForms(f, forms, name) {
    const args = [];
    for (const a of forms) args.push(await this.evalForm(a));
    return this.apply(f, args, name);
  }

  /**
   * Calls a function value (a built-in, a user function, a symbol or a quoted lambda) with
   * evaluated arguments.
   */
  async apply(f, args, name = '') {
    if (f instanceof Sym) {
      let g = this.globals.get(f.name);
      if (!g && this.resolveMissing) {
        g = this.resolveMissing(f.name);
        if (g) this.globals.set(f.name, g);
      }
      if (!g) throw new LispError(`no function definition: ${f.name}`);
      f = g;
    }
    if (f instanceof Subr) {
      const r = f.fn(...args);
      return r instanceof Promise ? await r : r === undefined ? null : r;
    }
    if (f instanceof Lambda) return this.callLambda(f, args);
    // a quoted (lambda (x) ...) list is a function too: (mapcar '(lambda (x) (* x x)) '(1 2 3))
    if (Array.isArray(f) && f[0] instanceof Sym && f[0].name === 'LAMBDA')
      return this.callLambda(await this.evalForm(f), args);
    throw new LispError(`bad function: ${toStr(f, true)}` + (name ? ` (${name})` : ''));
  }

  /**
   * @private Calls a user function: parameters and locals are dynamic variables that are restored
   *     afterwards.
   */
  async callLambda(f, args) {
    if (++this.depth > 3000) {
      this.depth = 0;
      throw new LispError('stack overflow');
    }
    const names = [...f.params, ...f.locals];
    const saved = names.map((s) => this.globals.get(s.name));
    f.params.forEach((s, i) => this.globals.set(s.name, i < args.length ? args[i] : null));
    f.locals.forEach((s) => this.globals.set(s.name, null));
    try {
      let r = null;
      for (const b of f.body) r = await this.evalForm(b);
      return r;
    } finally {
      names.forEach((s, i) => {
        if (saved[i] === undefined) this.globals.delete(s.name);
        else this.globals.set(s.name, saved[i]);
      });
      this.depth -= 1;
    }
  }

  /** Evaluates forms in order and returns the last value. */
  async progn(forms) {
    let r = null;
    for (const f of forms) r = await this.evalForm(f);
    return r;
  }

  /**
   * Evaluates a whole source text; prints the result of each top-level form like the AutoCAD
   * command line does when interactive (`print`). Errors go to the *error* handler.
   * @returns the value of the last form
   */
  async evalString(src, { print = false, source = '' } = {}) {
    let forms;
    try {
      forms = parse(src);
    } catch (e) {
      this.reportError(e);
      return null;
    }
    let last = null;
    for (const f of forms) {
      try {
        last = await this.evalForm(f);
        if (print) this.write(toStr(last, true) + '\n');
      } catch (e) {
        if (e instanceof LispExit) {
          this.flush();
          return null;
        }
        await this.handleError(e, source);
        break;
      }
    }
    this.flush();
    return last;
  }

  /** @private Calls the user's *error* function, or reports the error. */
  async handleError(e, source) {
    const msg = e instanceof LispError ? e.lispMessage : (e && e.message) || String(e);
    if (e instanceof LispError || e instanceof Error) {
      const h = this.globals.get('*ERROR*');
      if (h instanceof Lambda) {
        try {
          await this.callLambda(h, [msg]);
          this.flush();
          return;
        } catch (e2) {
          this.reportError(e2);
          return;
        }
      }
    }
    this.reportError(e, source);
  }

  /** Prints an error to the command line as "; error: ...". */
  reportError(e, source) {
    const msg = e instanceof LispError ? e.lispMessage : (e && e.message) || String(e);
    this.flush();
    if (msg === 'quit / exit abort') return;
    this.emitLine(`; error: ${msg}`);
    if (source) this.emitLine(`; in ${source}`);
  }

  // ---------------------------------------------------------------- built-in library

  /** @private Installs the built-in functions. */
  install() {
    LispBuiltins.install(this);
  }
}

/* ============================================================================================
 * 6. BUILT-IN FUNCTIONS
 * ========================================================================================== */

/** The built-in functions of the interpreter, installed in groups. */
export class LispBuiltins {
  /** Installs all groups (the order is the order of definition: a later definition of a name wins). */
  static install(L) {
    const D = (n, f) => L.def(n, f);
    const S = (n, f) => L.defSpecial(n, f);
    L.set('T', T);
    L.set('PI', R(Math.PI));
    L.set('PAUSE', '\\');
    LispBuiltins.specialForms(L, D, S);
    LispBuiltins.typesAndPredicates(L, D);
    LispBuiltins.comparison(L, D);
    LispBuiltins.arithmetic(L, D);
    LispBuiltins.lists(L, D);
    LispBuiltins.strings(L, D);
    LispBuiltins.output(L, D);
    LispBuiltins.unitsAndFormatting(L, D);
    LispBuiltins.geometry(L, D);
  }

  /** Special forms: quote, function, lambda, defun, setq, if, cond, progn, repeat, while, foreach, ... */
  static specialForms(L, D, S) {
    S('quote', (l, x) => (x[1] === undefined ? null : x[1]));
    S('function', (l, x) => {
      const a = x[1];
      if (Array.isArray(a) && a[0] instanceof Sym && a[0].name === 'LAMBDA') return l.evalForm(a);
      return a;
    });
    S('lambda', (l, x) => {
      const pl = x[1] === undefined ? null : x[1];
      const params = [];
      const locals = [];
      let loc = false;
      for (const p of listArg(pl)) {
        if (p instanceof Sym && p.name === '/') loc = true;
        else (loc ? locals : params).push(p);
      }
      return new Lambda(params, locals, x.slice(2), 'lambda');
    });
    S('defun', async (l, x) => {
      const name = x[1];
      if (!(name instanceof Sym)) throw new LispError('bad argument type: symbolp');
      const fn = await l.evalForm([sym('LAMBDA'), x[2] === undefined ? null : x[2], ...x.slice(3)]);
      fn.name = name.name;
      l.globals.set(name.name, fn);
      if (/^C:/i.test(name.name)) {
        l.userCommands.set(name.name.slice(2), fn);
        if (l.host.registerCommand) l.host.registerCommand(name.name.slice(2), fn);
      }
      return name;
    });
    S('setq', async (l, x) => {
      let v = null;
      for (let i = 1; i < x.length; i += 2) {
        const s = x[i];
        if (!(s instanceof Sym))
          throw new LispError(`bad argument type: symbolp: ${toStr(s, true)}`);
        v = i + 1 < x.length ? await l.evalForm(x[i + 1]) : null;
        l.globals.set(s.name, v);
      }
      return v;
    });
    S('if', async (l, x) => {
      const c = await l.evalForm(x[1]);
      if (c !== null) return l.evalForm(x[2]);
      return x.length > 3 ? l.evalForm(x[3]) : null;
    });
    S('cond', async (l, x) => {
      for (const clause of x.slice(1)) {
        if (!Array.isArray(clause)) continue;
        const t = await l.evalForm(clause[0]);
        if (t !== null) {
          if (clause.length === 1) return t;
          let r = t;
          for (const f of clause.slice(1)) r = await l.evalForm(f);
          return r;
        }
      }
      return null;
    });
    S('progn', (l, x) => l.progn(x.slice(1)));
    S('while', async (l, x) => {
      let guard = 0;
      while ((await l.evalForm(x[1])) !== null) {
        for (const f of x.slice(2)) await l.evalForm(f);
        if (++guard % 20000 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return null;
    });
    S('repeat', async (l, x) => {
      const n = numArg('repeat', await l.evalForm(x[1]));
      let r = null;
      for (let i = 0; i < n; i += 1) {
        for (const f of x.slice(2)) r = await l.evalForm(f);
        if (i % 20000 === 19999) await new Promise((rr) => setTimeout(rr, 0));
      }
      return r;
    });
    S('foreach', async (l, x) => {
      const s = x[1];
      const lst = listArg(await l.evalForm(x[2]));
      const saved = l.globals.get(s.name);
      let r = null;
      try {
        for (const item of lst) {
          l.globals.set(s.name, item);
          for (const f of x.slice(3)) r = await l.evalForm(f);
        }
      } finally {
        if (saved === undefined) l.globals.delete(s.name);
        else l.globals.set(s.name, saved);
      }
      return r;
    });
    S('and', async (l, x) => {
      let r = T;
      for (const f of x.slice(1)) {
        r = await l.evalForm(f);
        if (r === null) return null;
      }
      return r;
    });
    S('or', async (l, x) => {
      for (const f of x.slice(1)) {
        const r = await l.evalForm(f);
        if (r !== null) return r;
      }
      return null;
    });
    S('vl-catch-all-apply', async (l, x) => {
      const f = await l.evalForm(x[1]);
      const args = listArg(await l.evalForm(x[2]));
      try {
        return await l.apply(f, args);
      } catch (e) {
        if (e instanceof LispExit) throw e;
        return makeErrObj(e);
      }
    });
    S('trace', () => null);
    S('untrace', () => null);

    const makeErrObj = (e) => {
      const o = new Pair(
        sym('VL-ERROR-OBJECT'),
        e instanceof LispError ? e.lispMessage : e.message || String(e),
      );
      o.isError = true;
      return o;
    };
    D('vl-catch-all-error-p', (x) => toBool(x instanceof Pair && x.isError));
    D('vl-catch-all-error-message', (x) => (x instanceof Pair && x.isError ? x.cdr : null));
    D('vl-exit-with-error', (m) => {
      throw new LispError(String(m));
    });
    D('vl-exit-with-value', () => {
      throw new LispExit();
    });
    D('exit', () => {
      throw new LispError('quit / exit abort');
    });
    D('quit', () => {
      throw new LispError('quit / exit abort');
    });
    D('*error*-dummy', () => null);
    D('eval', (x) => L.evalForm(x));
    D('apply', async (f, args) => L.apply(f, listArg(args)));
    D('mapcar', async (f, ...lists) => {
      const ls = lists.map(listArg);
      const n = Math.min(...ls.map((a) => a.length));
      const out = [];
      for (let i = 0; i < n; i += 1)
        out.push(
          await L.apply(
            f,
            ls.map((a) => a[i]),
          ),
        );
      return out.length ? out : null;
    });
    D('mapcar*', (f) => f);
    D('vl-every', async (f, ...lists) => {
      const ls = lists.map(listArg);
      const n = Math.min(...ls.map((a) => a.length));
      for (let i = 0; i < n; i += 1)
        if (
          (await L.apply(
            f,
            ls.map((a) => a[i]),
          )) === null
        )
          return null;
      return T;
    });
    D('vl-some', async (f, ...lists) => {
      const ls = lists.map(listArg);
      const n = Math.min(...ls.map((a) => a.length));
      for (let i = 0; i < n; i += 1) {
        const r = await L.apply(
          f,
          ls.map((a) => a[i]),
        );
        if (r !== null) return r;
      }
      return null;
    });
    D('vl-remove-if', async (f, l) => {
      const o = [];
      for (const x of listArg(l)) if ((await L.apply(f, [x])) === null) o.push(x);
      return o.length ? o : null;
    });
    D('vl-remove-if-not', async (f, l) => {
      const o = [];
      for (const x of listArg(l)) if ((await L.apply(f, [x])) !== null) o.push(x);
      return o.length ? o : null;
    });
    D('vl-member-if', async (f, l) => {
      const a = listArg(l);
      for (let i = 0; i < a.length; i += 1)
        if ((await L.apply(f, [a[i]])) !== null) return a.slice(i);
      return null;
    });
    D('vl-member-if-not', async (f, l) => {
      const a = listArg(l);
      for (let i = 0; i < a.length; i += 1)
        if ((await L.apply(f, [a[i]])) === null) return a.slice(i);
      return null;
    });
    D('vl-position', (x, l) => {
      const i = listArg(l).findIndex((e) => equal(e, x));
      return i < 0 ? null : i;
    });
    D('vl-remove', (x, l) => {
      const o = listArg(l).filter((e) => !equal(e, x));
      return o.length ? o : null;
    });
    D('vl-list-length', (l) => (Array.isArray(l) ? l.length : null));
    D('vl-consp', (x) => toBool(Array.isArray(x) && x.length > 0));
    D('vl-list*', (...a) => {
      const last = a[a.length - 1];
      return [...a.slice(0, -1), ...listArg(last)];
    });
    const sortWith = async (l, pred) => {
      const a = [...listArg(l)];
      const cmp =
        pred === null || pred === undefined
          ? (x, y) => (nv(x) < nv(y) ? -1 : nv(x) > nv(y) ? 1 : 0)
          : null;
      if (cmp)
        return a.sort((x, y) => (typeof x === 'string' ? (x < y ? -1 : x > y ? 1 : 0) : cmp(x, y)));
      // merge sort with an async predicate
      const merge = async (xs) => {
        if (xs.length < 2) return xs;
        const mid = xs.length >> 1;
        const A = await merge(xs.slice(0, mid));
        const B = await merge(xs.slice(mid));
        const out = [];
        let i = 0;
        let j = 0;
        while (i < A.length && j < B.length) {
          if ((await L.apply(pred, [B[j], A[i]])) !== null) out.push(B[j++]);
          else out.push(A[i++]);
        }
        return out.concat(A.slice(i), B.slice(j));
      };
      return merge(a);
    };
    D('vl-sort', async (l, pred) => {
      const r = await sortWith(l, pred);
      return r.length ? r : null;
    });
    D('vl-sort-i', async (l, pred) => {
      const a = listArg(l).map((v, i) => ({ v, i }));
      const idx = await sortWith(
        a.map((o) => o.v),
        pred,
      );
      const used = new Set();
      return idx.map((v) => {
        const k = a.findIndex((o, j) => !used.has(j) && equal(o.v, v));
        used.add(k);
        return k;
      });
    });
    D('acad_strlsort', (l) => [...listArg(l)].sort());
  }

  /** Types and predicates: type, numberp, listp, null, ... */
  static typesAndPredicates(L, D) {
    D('type', (x) =>
      x === null
        ? null
        : typeof x === 'number'
          ? sym('INT')
          : x instanceof Real
            ? sym('REAL')
            : typeof x === 'string'
              ? sym('STR')
              : x instanceof Sym
                ? sym('SYM')
                : Array.isArray(x) || x instanceof Pair
                  ? sym('LIST')
                  : x instanceof Subr
                    ? sym('SUBR')
                    : x instanceof Lambda
                      ? sym('USUBR')
                      : x instanceof EName
                        ? sym('ENAME')
                        : x instanceof PickSet
                          ? sym('PICKSET')
                          : x instanceof LFile
                            ? sym('FILE')
                            : sym('VLA-OBJECT'),
    );
    D('null', (x) => toBool(x === null));
    D('not', (x) => toBool(x === null));
    D('atom', (x) => toBool(!Array.isArray(x)));
    D('listp', (x) => toBool(isList(x) || x instanceof Pair));
    D('numberp', (x) => toBool(isNum(x)));
    D('boundp', (s) =>
      toBool(s instanceof Sym && L.globals.has(s.name) && L.globals.get(s.name) !== null),
    );
    D('minusp', (x) => toBool(numArg('minusp', x) < 0));
    D('zerop', (x) => toBool(numArg('zerop', x) === 0));
    D('plusp', (x) => toBool(numArg('plusp', x) > 0));
    D('vl-symbol-name', (s) => s.name);
    D('vl-symbol-value', (s) => L.get(s.name));
    D('vl-bb-ref', (s) => L.get('bb:' + s.name));
    D('vl-bb-set', (s, v) => {
      L.set('bb:' + s.name, v);
      return v;
    });
    D('vl-load-com', () => T);
    D('vl-load-all', () => T);
    D('vl-doc-ref', (s) => L.get(s.name));
    D('vl-doc-set', (s, v) => {
      L.set(s.name, v);
      return v;
    });
    D('gc', () => null);
    D('mem', () => null);
    D('ver', () => 'MacCAD 2027 AutoLISP-compatible (MacLISP 1.0)');
    D('atoms-family', (f, names) => {
      const out = [];
      const want = names ? listArg(names).map((x) => String(x).toUpperCase()) : null;
      if (f === 0) {
        for (const k of L.globals.keys()) if (!want || want.includes(k)) out.push(k.toLowerCase());
      }
      return out.length ? out : null;
    });
  }

  /** Equality and comparison: = /= < > <= >= eq equal */
  static comparison(L, D) {
    D('eq', (a, b) => toBool(eqv(a, b)));
    D('equal', (a, b, f) =>
      toBool(equal(a, b, f === undefined || f === null ? 0 : numArg('equal', f))),
    );
    const cmpOp = (name, test) =>
      D(name, (...a) => {
        for (let i = 0; i + 1 < a.length; i += 1) {
          const x = a[i];
          const y = a[i + 1];
          let c;
          if (isNum(x) && isNum(y)) c = nv(x) < nv(y) ? -1 : nv(x) > nv(y) ? 1 : 0;
          else if (typeof x === 'string' && typeof y === 'string') c = x < y ? -1 : x > y ? 1 : 0;
          else if (name === '=' || name === '/=') c = equal(x, y) ? 0 : 2;
          else throw typeError(name, isNum(x) || typeof x === 'string' ? y : x);
          if (!test(c)) return null;
        }
        return T;
      });
    cmpOp('=', (c) => c === 0);
    cmpOp('/=', (c) => c !== 0);
    cmpOp('<', (c) => c === -1);
    cmpOp('>', (c) => c === 1);
    cmpOp('<=', (c) => c <= 0 && c !== 2);
    cmpOp('>=', (c) => c >= 0 && c !== 2);
  }

  /** Arithmetic: + - * / 1+ 1- abs sqrt sin cos atan exp log expt min max fix float rem gcd lcm ... */
  static arithmetic(L, D) {
    const arith = (name, op, unit) =>
      D(name, (...a) => {
        if (!a.length) return unit;
        let real = false;
        const vs = a.map((x) => {
          if (x instanceof Real) real = true;
          return numArg(name, x);
        });
        let acc = vs[0];
        if (vs.length === 1 && (name === '-' || name === '/')) acc = op(unit === 0 ? 0 : 1, acc);
        else
          for (let i = 1; i < vs.length; i += 1) {
            if (name === '/' && vs[i] === 0) throw new LispError('divide by zero');
            acc = op(acc, vs[i], real);
          }
        return real ? R(acc) : Math.trunc(acc);
      });
    arith('+', (a, b) => a + b, 0);
    arith('-', (a, b) => a - b, 0);
    arith('*', (a, b) => a * b, 1);
    D('/', (...a) => {
      if (!a.length) return 0;
      let real = false;
      const vs = a.map((x) => {
        if (x instanceof Real) real = true;
        return numArg('/', x);
      });
      let acc = vs[0];
      for (let i = 1; i < vs.length; i += 1) {
        if (vs[i] === 0) throw new LispError('divide by zero');
        acc = real ? acc / vs[i] : Math.trunc(acc / vs[i]);
      }
      return real ? R(acc) : acc;
    });
    D('1+', (x) => (x instanceof Real ? R(x.v + 1) : numArg('1+', x) + 1));
    D('1-', (x) => (x instanceof Real ? R(x.v - 1) : numArg('1-', x) - 1));
    D('abs', (x) => (x instanceof Real ? R(Math.abs(x.v)) : Math.abs(numArg('abs', x))));
    D('max', (...a) => {
      const v = a.map((x) => numArg('max', x));
      const r = Math.max(...v);
      return a.some((x) => x instanceof Real) ? R(r) : r;
    });
    D('min', (...a) => {
      const v = a.map((x) => numArg('min', x));
      const r = Math.min(...v);
      return a.some((x) => x instanceof Real) ? R(r) : r;
    });
    D('rem', (a, b, ...c) => {
      let r = numArg('rem', a) % numArg('rem', b);
      for (const x of c) r %= numArg('rem', x);
      return [a, b, ...c].some((x) => x instanceof Real) ? R(r) : r;
    });
    D('gcd', (a, b) => {
      a = Math.abs(numArg('gcd', a));
      b = Math.abs(numArg('gcd', b));
      while (b) [a, b] = [b, a % b];
      return a;
    });
    D('lcm', (a, b) => {
      const g = (x, y) => (y ? g(y, x % y) : x);
      a = numArg('lcm', a);
      b = numArg('lcm', b);
      return Math.abs(a * b) / g(Math.abs(a), Math.abs(b));
    });
    D('sqrt', (x) => {
      const v = numArg('sqrt', x);
      if (v < 0) throw new LispError('function undefined for value');
      return R(Math.sqrt(v));
    });
    D('expt', (a, b) => {
      const r = Math.pow(numArg('expt', a), numArg('expt', b));
      return a instanceof Real || b instanceof Real || !Number.isInteger(r) ? R(r) : r;
    });
    D('exp', (x) => R(Math.exp(numArg('exp', x))));
    D('log', (x) => {
      const v = numArg('log', x);
      if (v <= 0) throw new LispError('function undefined for value');
      return R(Math.log(v));
    });
    D('sin', (x) => R(Math.sin(numArg('sin', x))));
    D('cos', (x) => R(Math.cos(numArg('cos', x))));
    D('atan', (y, x) =>
      R(
        x === undefined
          ? Math.atan(numArg('atan', y))
          : Math.atan2(numArg('atan', y), numArg('atan', x)),
      ),
    );
    D('float', (x) => R(numArg('float', x)));
    D('fix', (x) => Math.trunc(numArg('fix', x)));
    D('~', (x) => ~numArg('~', x));
    D('logand', (...a) => a.reduce((p, x) => p & numArg('logand', x), -1));
    D('logior', (...a) => a.reduce((p, x) => p | numArg('logior', x), 0));
    D('lsh', (a, n) => (n >= 0 ? numArg('lsh', a) << n : numArg('lsh', a) >>> -n));
    D('boole', (f, ...a) => a.reduce((p, x) => (f & 1 ? p & x : f & 6 ? p | x : p ^ x)));
    D('cvunit', (v, a, b) => {
      const F = {
        mm: 1,
        millimeters: 1,
        cm: 10,
        m: 1000,
        meter: 1000,
        meters: 1000,
        in: 25.4,
        inch: 25.4,
        inches: 25.4,
        ft: 304.8,
        foot: 304.8,
        feet: 304.8,
        yd: 914.4,
        mile: 1609344,
        km: 1e6,
      };
      const x = F[String(a).toLowerCase()];
      const y = F[String(b).toLowerCase()];
      if (!x || !y) return null;
      return R((numArg('cvunit', v) * x) / y);
    });
    let seed = 12345;
    D('rand', () => R((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff));
  }

  /** Lists: car cdr cons list append reverse nth member assoc mapcar apply foreach ... */
  static lists(L, D) {
    D('list', (...a) => (a.length ? a : null));
    D('cons', (a, b) => (b === null ? [a] : Array.isArray(b) ? [a, ...b] : new Pair(a, b)));
    D('car', (x) => {
      if (x === null) return null;
      if (x instanceof Pair) return x.car;
      if (!Array.isArray(x)) throw typeError('listp', x);
      return x[0];
    });
    D('cdr', (x) => {
      if (x === null) return null;
      if (x instanceof Pair) return x.cdr;
      if (!Array.isArray(x)) throw typeError('listp', x);
      return x.length > 1 ? x.slice(1) : null;
    });
    for (const path of [
      'aa',
      'ad',
      'da',
      'dd',
      'aaa',
      'aad',
      'ada',
      'add',
      'daa',
      'dad',
      'dda',
      'ddd',
      'addd',
      'dddd',
      'adda',
      'adad',
      'aada',
    ]) {
      D(`c${path}r`, (x) => {
        let v = x;
        for (let i = path.length - 1; i >= 0; i -= 1) {
          if (v === null) return null;
          if (v instanceof Pair) v = path[i] === 'a' ? v.car : v.cdr;
          else if (Array.isArray(v)) v = path[i] === 'a' ? v[0] : v.length > 1 ? v.slice(1) : null;
          else throw typeError('listp', v);
        }
        return v;
      });
    }
    D('append', (...ls) => {
      const o = [];
      for (const l of ls) o.push(...listArg(l));
      return o.length ? o : null;
    });
    D('reverse', (l) => {
      const a = listArg(l);
      return a.length ? [...a].reverse() : null;
    });
    D('length', (l) => {
      if (l === null) return 0;
      if (!Array.isArray(l)) throw typeError('listp', l);
      return l.length;
    });
    D('nth', (n, l) => {
      const a = listArg(l);
      const i = numArg('nth', n);
      return i >= 0 && i < a.length ? a[i] : null;
    });
    D('last', (l) => {
      const a = listArg(l);
      return a.length ? a[a.length - 1] : null;
    });
    D('member', (x, l) => {
      const a = listArg(l);
      const i = a.findIndex((e) => equal(e, x));
      return i < 0 ? null : a.slice(i);
    });
    D('assoc', (k, l) => {
      for (const e of listArg(l)) {
        if (e instanceof Pair ? equal(e.car, k) : Array.isArray(e) && equal(e[0], k)) return e;
      }
      return null;
    });
    D('subst', (nw, old, l) => {
      const walk = (x) => (equal(x, old) ? nw : Array.isArray(x) ? x.map(walk) : x);
      const r = walk(l);
      return r;
    });
    D('vl-assoc*', () => null);
  }

  /** Strings: strcat substr strlen strcase itoa atoi atof rtos angtos read ... */
  static strings(L, D) {
    D('strcat', (...a) => a.map((x) => strArg(x)).join(''));
    D('strlen', (...a) => a.reduce((n, x) => n + [...strArg(x)].length, 0));
    D('substr', (s, st, len) => {
      strArg(s);
      const a = [...s];
      const i = numArg('substr', st) - 1;
      if (i < 0) throw new LispError('invalid argument');
      return len === undefined || len === null
        ? a.slice(i).join('')
        : a.slice(i, i + numArg('substr', len)).join('');
    });
    D('strcase', (s, w) =>
      w === undefined || w === null ? strArg(s).toUpperCase() : strArg(s).toLowerCase(),
    );
    D('itoa', (n) => String(Math.trunc(numArg('itoa', n))));
    D('atoi', (s) => {
      const m = /^\s*[+-]?\d+/.exec(strArg(s));
      return m ? parseInt(m[0], 10) : 0;
    });
    D('atof', (s) => {
      const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(strArg(s));
      return R(m ? parseFloat(m[0]) : 0);
    });
    D('chr', (n) => String.fromCodePoint(numArg('chr', n)));
    D('ascii', (s) => (strArg(s).length ? s.codePointAt(0) : null));
    D('read', (s) => {
      const f = parse(strArg(s));
      return f.length ? f[0] : null;
    });
    D('vl-string->list', (s) => {
      const a = [...strArg(s)].map((c) => c.codePointAt(0));
      return a.length ? a : null;
    });
    D('vl-list->string', (l) =>
      listArg(l)
        .map((c) => String.fromCodePoint(c))
        .join(''),
    );
    D('vl-princ-to-string', (x) => toStr(x, false));
    D('vl-prin1-to-string', (x) => toStr(x, true));
    D('vl-string-search', (p, s, st) => {
      const i = strArg(s).indexOf(strArg(p), st || 0);
      return i < 0 ? null : i;
    });
    D('vl-string-subst', (nw, pat, s, st) => {
      const i = strArg(s).indexOf(pat, st || 0);
      return i < 0 ? s : s.slice(0, i) + nw + s.slice(i + pat.length);
    });
    D('vl-string-position', (c, s, st, fromEnd) => {
      const i =
        fromEnd !== undefined && fromEnd !== null
          ? strArg(s).lastIndexOf(
              String.fromCharCode(c),
              st === null || st === undefined ? undefined : st,
            )
          : strArg(s).indexOf(String.fromCharCode(c), st || 0);
      return i < 0 ? null : i;
    });
    const trimWith = (name, l, r) =>
      D(name, (chars, s, ...rest) => {
        if (rest.length) {
          s = rest[0];
        }
        const set = new Set([
          ...(chars === undefined || chars === null || typeof s !== 'string'
            ? ' \t\r\n'
            : strArg(chars)),
        ]);
        const a = [...strArg(typeof s === 'string' ? s : chars)];
        if (l) while (a.length && set.has(a[0])) a.shift();
        if (r) while (a.length && set.has(a[a.length - 1])) a.pop();
        return a.join('');
      });
    D('vl-string-trim', (chars, s) => {
      const set = new Set([...strArg(chars)]);
      const a = [...strArg(s)];
      while (a.length && set.has(a[0])) a.shift();
      while (a.length && set.has(a[a.length - 1])) a.pop();
      return a.join('');
    });
    D('vl-string-left-trim', (chars, s) => {
      const set = new Set([...strArg(chars)]);
      const a = [...strArg(s)];
      while (a.length && set.has(a[0])) a.shift();
      return a.join('');
    });
    D('vl-string-right-trim', (chars, s) => {
      const set = new Set([...strArg(chars)]);
      const a = [...strArg(s)];
      while (a.length && set.has(a[a.length - 1])) a.pop();
      return a.join('');
    });
    void trimWith;
    D('vl-string-translate', (src, dst, s) => {
      let out = '';
      for (const ch of strArg(s)) {
        const i = src.indexOf(ch);
        out += i >= 0 ? (dst[i] ?? '') : ch;
      }
      return out;
    });
    D('vl-string-elt', (s, i) => strArg(s).charCodeAt(i));
    D('vl-filename-base', (s) =>
      strArg(s)
        .split(/[\\/]/)
        .pop()
        .replace(/\.[^.]*$/, ''),
    );
    D('vl-filename-directory', (s) => {
      const m = /^(.*)[\\/][^\\/]*$/.exec(strArg(s));
      return m ? m[1] : '';
    });
    D('vl-filename-extension', (s) => {
      const m = /(\.[^.\\/]*)$/.exec(strArg(s));
      return m ? m[1] : null;
    });
    D('wcmatch', (s, pat) => {
      strArg(s);
      for (let p of strArg(pat).split(/,(?![^\[]*\])/)) {
        let neg = false;
        if (p[0] === '~') {
          neg = true;
          p = p.slice(1);
        }
        let re = '^';
        for (let i = 0; i < p.length; i += 1) {
          const c = p[i];
          if (c === '#') re += '\\d';
          else if (c === '@') re += '[A-Za-z]';
          else if (c === '.') re += '[^A-Za-z0-9]';
          else if (c === '*') re += '.*';
          else if (c === '?') re += '.';
          else if (c === '`') {
            i += 1;
            re += (p[i] || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          } else if (c === '[') {
            const e = p.indexOf(']', i);
            re += p.slice(i, e < 0 ? p.length : e + 1).replace('[~', '[^');
            i = e < 0 ? p.length : e;
          } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        re += '$';
        const hit = new RegExp(re, 'i').test(s);
        if (neg ? !hit : hit) return T;
      }
      return null;
    });
  }

  /** Output: princ prin1 print prompt terpri textscr ... */
  static output(L, D) {
    D('princ', (x) => {
      if (x === undefined) return null;
      L.write(toStr(x, false));
      return x;
    });
    D('prin1', (x) => {
      if (x === undefined) return null;
      L.write(toStr(x, true));
      return x;
    });
    D('print', (x) => {
      L.write('\n' + toStr(x, true) + ' ');
      return x;
    });
    D('terpri', () => {
      L.write('\n');
      return null;
    });
    D('write-line', (s) => {
      L.write(toStr(s, false) + '\n');
      return s;
    });
    D('write-char', (c) => {
      L.write(String.fromCharCode(c));
      return c;
    });
    D('prompt', (s) => {
      L.write(String(s) + '\n');
      return null;
    });
    D('textscr', () => {
      L.host.textscr && L.host.textscr(true);
      return null;
    });
    D('graphscr', () => {
      L.host.textscr && L.host.textscr(false);
      return null;
    });
    D('alert', async (s) => {
      if (L.host.alert) await L.host.alert(String(toStr(s, false)));
      else L.write(`[alert] ${toStr(s)}\n`);
      return null;
    });
    D('getenv', (n) => (L.host.getenv ? L.host.getenv(strArg(n)) : null));
    D('setenv', (n, v) => {
      if (L.host.setenv) L.host.setenv(n, v);
      return v;
    });
    D('load', async (f, onfail) => {
      if (!L.host.loadFile) throw new LispError('load is not available');
      try {
        return await L.host.loadFile(strArg(f));
      } catch (e) {
        if (onfail !== undefined) return onfail;
        throw e;
      }
    });
    D('autoload', () => null);
    D('setfunhelp', () => null);
    D('startapp', () => null);
  }

  /** Number formatting and parsing that depends on the drawing units: rtos distof angtos angtof */
  static unitsAndFormatting(L, D) {
    const unitsOf = () =>
      L.host.units ? L.host.units() : { type: 'decimal', prec: 4, angType: 'deg', aprec: 0 };
    D('rtos', (n, mode, prec) => {
      const u = unitsOf();
      const v = numArg('rtos', n);
      const types = {
        1: 'scientific',
        2: 'decimal',
        3: 'engineering',
        4: 'architectural',
        5: 'fractional',
      };
      const t = mode === undefined || mode === null ? u.type : types[mode] || 'decimal';
      const p = prec === undefined || prec === null ? u.prec : numArg('rtos', prec);
      return L.host.fmtLen ? L.host.fmtLen(v, { type: t, prec: p }) : v.toFixed(p);
    });
    D('angtos', (a, mode, prec) => {
      const u = unitsOf();
      const m =
        mode === undefined || mode === null
          ? ({ deg: 0, dms: 1, grad: 2, rad: 3 }[u.angType] ?? 0)
          : mode;
      const p = prec === undefined || prec === null ? u.aprec : prec;
      const v = numArg('angtos', a);
      const d = ((((v * 180) / Math.PI) % 360) + 360) % 360;
      if (m === 0) return d.toFixed(p);
      if (m === 2) return ((d * 400) / 360).toFixed(p) + 'g';
      if (m === 3) return v.toFixed(p) + 'r';
      if (m === 1) {
        const dd = Math.floor(d + 1e-9);
        const mm = (d - dd) * 60;
        const mi = Math.floor(mm + 1e-9);
        const ss = (mm - mi) * 60;
        return `${dd}d${mi}'${ss.toFixed(Math.max(0, p - 2))}"`;
      }
      return d.toFixed(p);
    });
    D('distof', (s, mode) => {
      const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.exec(strArg(s));
      if (m) return R(parseFloat(s));
      if (L.host.parseDist) {
        const v = L.host.parseDist(s);
        return Number.isNaN(v) ? null : R(v);
      }
      return null;
    });
    D('angtof', (s) => {
      if (L.host.parseAng) {
        const v = L.host.parseAng(strArg(s));
        return Number.isNaN(v) ? null : R(v);
      }
      const v = parseFloat(s);
      return Number.isNaN(v) ? null : R((v * Math.PI) / 180);
    });
  }

  /** Points and geometry helpers (pure): distance angle polar inters ... */
  static geometry(L, D) {
    const pt = (p) => {
      const a = listArg(p);
      return { x: nv(a[0]), y: nv(a[1]), z: a.length > 2 ? nv(a[2]) : 0 };
    };
    const mkpt = (x, y, z = 0, three = true) => (three ? [R(x), R(y), R(z)] : [R(x), R(y)]);
    D('distance', (a, b) => {
      const p = pt(a);
      const q = pt(b);
      return R(Math.hypot(p.x - q.x, p.y - q.y, a.length > 2 && b.length > 2 ? p.z - q.z : 0));
    });
    D('angle', (a, b) => {
      const p = pt(a);
      const q = pt(b);
      let r = Math.atan2(q.y - p.y, q.x - p.x);
      if (r < 0) r += Math.PI * 2;
      return R(r);
    });
    D('polar', (p, a, d) => {
      const q = pt(p);
      return mkpt(
        q.x + Math.cos(numArg('polar', a)) * numArg('polar', d),
        q.y + Math.sin(numArg('polar', a)) * numArg('polar', d),
        q.z,
        listArg(p).length > 2,
      );
    });
    D('inters', (a1, a2, b1, b2, onseg) => {
      const p = pt(a1);
      const q = pt(a2);
      const r = pt(b1);
      const s = pt(b2);
      const rx = q.x - p.x;
      const ry = q.y - p.y;
      const sx = s.x - r.x;
      const sy = s.y - r.y;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-14) return null;
      const t = ((r.x - p.x) * sy - (r.y - p.y) * sx) / den;
      const u = ((r.x - p.x) * ry - (r.y - p.y) * rx) / den;
      const seg =
        onseg === undefined ||
        onseg === null ||
        onseg === T ||
        (typeof onseg === 'number' && onseg !== 0);
      if (seg && (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12)) return null;
      return mkpt(p.x + rx * t, p.y + ry * t, 0, true);
    });
    D('trans', (p) => p);
    D('vector-dummy', () => null);
  }
}

// convenience for tests / embedding
export async function run(src, host) {
  const l = new Lisp(host);
  const r = await l.evalString(src);
  return { lisp: l, result: r };
}
