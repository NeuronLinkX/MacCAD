/**
 * @file calc.js
 * @brief Expression calculator used by the CAL command and the QuickCalc dialog.
 *
 * Supports numbers, + - * / ^ %, parentheses, vectors `[x,y,z]`, the constants pi and e, the
 * "cur" point picker, user variables, and CAD-style functions (trigonometry in DEGREES, dist, ang,
 * mee, pld, vec, vec1, mod ...).
 *
 * Contents: Calculator.tokenize, Calculator.evaluate (a recursive-descent Parser), Calculator.format.
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** @returns {number} degrees to radians. */
const rad = (d) => (d * Math.PI) / 180;

/** Functions of one number (vectors are mapped element by element). Angles are in degrees. */
const FN1 = {
  sin: (x) => Math.sin(rad(x)),
  cos: (x) => Math.cos(rad(x)),
  tan: (x) => Math.tan(rad(x)),
  asin: (x) => (Math.asin(x) * 180) / Math.PI,
  acos: (x) => (Math.acos(x) * 180) / Math.PI,
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  sqr: (x) => x * x,
  sqrt: (x) => Math.sqrt(x),
  abs: Math.abs,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  exp10: (x) => 10 ** x,
  round: Math.round,
  trunc: Math.trunc,
  rad: (x) => rad(x),
  deg: (x) => (x * 180) / Math.PI,
  r2d: (x) => (x * 180) / Math.PI,
  d2r: rad,
};

const isVec = Array.isArray;

/**
 * Applies a binary operation to numbers or vectors (a number combines with every element of a vector).
 * @param {number|number[]} a
 * @param {number|number[]} b
 * @param {(x: number, y: number) => number} f
 */
const vop = (a, b, f) =>
  isVec(a) && isVec(b)
    ? a.map((x, i) => f(x, b[i] ?? 0))
    : isVec(a)
      ? a.map((x) => f(x, b))
      : isVec(b)
        ? b.map((y) => f(a, y))
        : f(a, b);

/* ============================================================================================
 * 2. PARSER
 * ========================================================================================== */

/**
 * Recursive-descent parser / evaluator over a token list.
 * Grammar (lowest to highest precedence):
 *   expr  = term (('+'|'-') term)*
 *   term  = unary (('*'|'/'|'%') unary)*        vector * vector is the dot product
 *   unary = '-' unary | '+' unary | power
 *   power = atom ('^' unary)?
 *   atom  = number | '(' expr ')' | '[' expr (',' expr)* ']' | name | name '(' args ')'
 */
class Parser {
  /**
   * @param {Array<{k: string, v?: *}>} toks tokens from `Calculator.tokenize`
   * @param {{cur?: () => (object|Promise<object>), vars?: object}} ctx `cur()` returns the picked point; `vars` holds user variables
   */
  constructor(toks, ctx) {
    this.toks = toks;
    this.ctx = ctx;
    /** Index of the next token. */
    this.p = 0;
  }

  /** @returns {object|undefined} the next token without consuming it. */
  peek() {
    return this.toks[this.p];
  }

  /** @returns {object|null} the next token when its kind is `k` (and consumes it), else null. */
  eat(k) {
    if (this.toks[this.p] && this.toks[this.p].k === k) return this.toks[this.p++];
    return null;
  }

  /** Consumes a token of kind `k` or throws. */
  expect(k) {
    if (!this.eat(k)) throw new Error(`expected "${k}"`);
  }

  /** Parses the whole input. @returns {Promise<number|number[]>} */
  async parse() {
    const v = await this.expr();
    if (this.p < this.toks.length) throw new Error(`unexpected "${this.toks[this.p].k}"`);
    return v;
  }

  /** Addition and subtraction. */
  async expr() {
    let v = await this.term();
    for (;;) {
      if (this.eat('+')) v = vop(v, await this.term(), (a, b) => a + b);
      else if (this.eat('-')) v = vop(v, await this.term(), (a, b) => a - b);
      else return v;
    }
  }

  /** Multiplication, division, modulo. */
  async term() {
    let v = await this.unary();
    for (;;) {
      if (this.eat('*')) {
        const r = await this.unary();
        v =
          isVec(v) && isVec(r)
            ? v.reduce((s, x, i) => s + x * (r[i] ?? 0), 0)
            : vop(v, r, (a, b) => a * b);
      } else if (this.eat('/')) {
        const r = await this.unary();
        if (r === 0) throw new Error('division by zero');
        v = vop(v, r, (a, b) => a / b);
      } else if (this.eat('%')) v = vop(v, await this.unary(), (a, b) => a % b);
      else return v;
    }
  }

  /** Unary minus / plus. */
  async unary() {
    if (this.eat('-')) {
      const v = await this.unary();
      return isVec(v) ? v.map((x) => -x) : -v;
    }
    if (this.eat('+')) return this.unary();
    return this.power();
  }

  /** Exponentiation. */
  async power() {
    const b = await this.atom();
    if (this.eat('^')) {
      const e = await this.unary();
      return b ** e;
    }
    return b;
  }

  /** Numbers, parentheses, vectors, names and function calls. */
  async atom() {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of expression');
    if (t.k === 'n') {
      this.p += 1;
      return t.v;
    }
    if (t.k === '(') {
      this.p += 1;
      const v = await this.expr();
      this.expect(')');
      return v;
    }
    if (t.k === '[') {
      this.p += 1;
      const v = [];
      do {
        v.push(await this.expr());
      } while (this.eat(','));
      this.expect(']');
      return v;
    }
    if (t.k === 'id') {
      this.p += 1;
      return this.name(t.v);
    }
    throw new Error(`unexpected "${t.k}"`);
  }

  /**
   * A name: constant, the picked point (`cur`), a user variable, or a function call.
   * @private
   * @param {string} name lower-case identifier
   */
  async name(name) {
    const ctx = this.ctx;
    if (name === 'pi') return Math.PI;
    if (name === 'e') return Math.E;
    if (name === 'cur') {
      const c = ctx.cur ? await ctx.cur() : null;
      if (!c) throw new Error('no point picked');
      return c;
    }
    if (ctx.vars && name in ctx.vars) return ctx.vars[name];
    if (this.peek() && this.peek().k === '(') {
      this.p += 1;
      const args = [];
      if (!this.eat(')')) {
        do {
          args.push(await this.expr());
        } while (this.eat(','));
        this.expect(')');
      }
      return Parser.callFunction(name, args);
    }
    throw new Error(`unknown name ${name}`);
  }

  /**
   * Calls a built-in function.
   * @private
   * @param {string} name function name
   * @param {Array<number|number[]>} args evaluated arguments
   */
  static callFunction(name, args) {
    if (FN1[name]) return isVec(args[0]) ? args[0].map(FN1[name]) : FN1[name](args[0]);
    if (name === 'dist') return Math.hypot(...args[0].map((x, i) => x - (args[1][i] ?? 0)));
    if (name === 'ang')
      return (Math.atan2(args[1][1] - args[0][1], args[1][0] - args[0][0]) * 180) / Math.PI;
    if (name === 'abs') return Math.abs(args[0]);
    if (name === 'mee') return args[0].map((x, i) => (x + (args[1][i] ?? 0)) / 2);
    if (name === 'pld') return args[0].map((x, i) => x + (args[1][i] - x) * args[2]);
    if (name === 'vec') return args[1].map((x, i) => x - args[0][i]);
    if (name === 'vec1') {
      const v = args[1].map((x, i) => x - args[0][i]);
      const l = Math.hypot(...v) || 1;
      return v.map((x) => x / l);
    }
    if (name === 'mod') return args[0] % args[1];
    throw new Error(`unknown function ${name}`);
  }
}

/* ============================================================================================
 * 3. CALCULATOR
 * ========================================================================================== */

/** Static entry points of the calculator. */
export class Calculator {
  /**
   * Splits an expression into tokens: `{k:'n', v}` numbers, `{k:'id', v}` names (lower-case) and
   * single-character operators `{k:'+'}` ...
   * @param {string} src the expression
   * @returns {Array<{k: string, v?: *}>}
   * @throws {Error} on a character that cannot be part of an expression
   */
  static tokenize(src) {
    const t = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (num) {
        t.push({ k: 'n', v: parseFloat(num[0]) });
        i += num[0].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (id) {
        t.push({ k: 'id', v: id[0].toLowerCase() });
        i += id[0].length;
        continue;
      }
      if ('+-*/^%(),[]<'.includes(c)) {
        t.push({ k: c });
        i += 1;
        continue;
      }
      throw new Error(`unexpected character "${c}"`);
    }
    return t;
  }

  /**
   * Evaluates an expression.
   * @param {string} src the expression
   * @param {{cur?: () => (object|Promise<object>), vars?: object}} [ctx] `cur()` picks a point
   *        (async allowed); `vars` holds user variables by lower-case name
   * @returns {Promise<number|number[]>} a number, or a vector for vector expressions
   * @throws {Error} with a short message when the expression is wrong
   */
  static evaluate(src, ctx = {}) {
    return new Parser(Calculator.tokenize(src), ctx).parse();
  }

  /** @returns {string} a result as text, rounded to 10 decimals; vectors as "[x,y,z]". */
  static format(v) {
    return isVec(v) ? `[${v.map((x) => +x.toFixed(10)).join(',')}]` : String(+v.toFixed(10));
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const tokenize = Calculator.tokenize;
export const evaluate = Calculator.evaluate;
export const fmtResult = Calculator.format;
