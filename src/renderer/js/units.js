/**
 * @file units.js
 * @brief Length / angle formatting and parsing.
 *
 * Supported length formats: decimal, engineering (feet-inches), architectural (feet-inches with
 * fractions), fractional and scientific. Angles: degrees, DMS, gradians and radians.
 * The unit settings live in a plain object created by `Units.defaults()`.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { deg, rad } from './geom.js';

/* ============================================================================================
 * 2. DATA TYPES
 * ========================================================================================== */

/**
 * @typedef {object} UnitSettings
 * @property {'decimal'|'engineering'|'architectural'|'fractional'|'scientific'} type length format
 * @property {number} prec decimal places (denominator = 2^prec for the fraction formats, at most 2^8)
 * @property {'deg'|'dms'|'grad'|'rad'} angType angle format
 * @property {number} aprec angle precision (decimal places)
 * @property {boolean} angCW true when positive angles run clockwise
 * @property {number} angBase direction of angle 0, in degrees
 */

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Static helpers for turning numbers into text and text into numbers. */
export class Units {
  /** @returns {UnitSettings} the default settings: decimal, 4 places, degrees. */
  static defaults() {
    return { type: 'decimal', prec: 4, angType: 'deg', aprec: 0, angCW: false, angBase: 0 };
  }

  /**
   * Splits a non-negative value into a whole number and a reduced fraction.
   * @private
   * @param {number} v value >= 0
   * @param {number} den denominator to round to
   * @returns {{whole: number, n: number, d: number}}
   */
  static frac(v, den) {
    let whole = Math.floor(v + 1e-12);
    let n = Math.round((v - whole) * den);
    let d = den;
    if (n >= d) {
      whole += 1;
      n = 0;
    }
    while (n > 0 && n % 2 === 0 && d % 2 === 0) {
      n /= 2;
      d /= 2;
    }
    return { whole, n, d };
  }

  /**
   * Formats a length.
   * @param {number} v the length in drawing units (inches for the feet-inches formats)
   * @param {UnitSettings} [u] unit settings, default decimal
   * @returns {string}
   */
  static formatLength(v, u = Units.defaults()) {
    if (!isFinite(v)) return String(v);
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    const prec = u.prec;
    switch (u.type) {
      case 'scientific':
        return v.toExponential(prec);
      case 'engineering': {
        let ft = Math.floor(a / 12 + 1e-12);
        let inch = a - ft * 12;
        inch = Number(inch.toFixed(prec));
        if (inch >= 12) {
          ft += 1;
          inch = 0;
        }
        return `${sign}${ft}'-${inch.toFixed(prec)}"`;
      }
      case 'architectural': {
        const den = 2 ** Math.min(prec, 8);
        let ft = Math.floor(a / 12 + 1e-12);
        const inch = a - ft * 12;
        let f = Units.frac(inch, den);
        if (f.whole >= 12) {
          ft += 1;
          f = { whole: 0, n: 0, d: 1 };
        }
        return `${sign}${ft}'-${f.whole}${f.n ? ` ${f.n}/${f.d}` : ''}"`;
      }
      case 'fractional': {
        const f = Units.frac(a, 2 ** Math.min(prec, 8));
        if (!f.n) return `${sign}${f.whole}`;
        return `${sign}${f.whole ? f.whole + ' ' : ''}${f.n}/${f.d}`;
      }
      default:
        return v.toFixed(prec);
    }
  }

  /**
   * Formats an angle.
   * @param {number} r the angle in radians
   * @param {UnitSettings} [u] unit settings
   * @param {boolean} [sym=false] append the degree sign in decimal-degree mode
   * @returns {string}
   */
  static formatAngle(r, u = Units.defaults(), sym = false) {
    let d = deg(r);
    d = ((d % 360) + 360) % 360;
    const p = u.aprec;
    switch (u.angType) {
      case 'dms': {
        const dd = Math.floor(d + 1e-9);
        const m = (d - dd) * 60;
        const mm = Math.floor(m + 1e-9);
        const s = (m - mm) * 60;
        return `${dd}d${mm}'${s.toFixed(Math.max(0, p - 2))}"`;
      }
      case 'grad':
        return `${((d * 400) / 360).toFixed(p)}g`;
      case 'rad':
        return `${r.toFixed(p || 4)}r`;
      default:
        return d.toFixed(p) + (sym ? '°' : '');
    }
  }

  /**
   * Parses a distance typed by the user: "12.5", "5'", "5'6\"", "5'-6 1/2\"", "1/2", "3e2".
   * @param {string} str
   * @returns {number} the length, or NaN when the text is not a distance
   */
  static parseDistance(str) {
    const s = String(str).trim();
    if (!s) return NaN;
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return parseFloat(s);
    const m = s.match(
      /^([-+])?\s*(?:(\d+(?:\.\d+)?)\s*')?\s*-?\s*(?:(\d+(?:\.\d+)?)?(?:\s+)?(?:(\d+)\/(\d+))?)?\s*"?$/,
    );
    if (m && (m[2] !== undefined || m[3] !== undefined || m[4] !== undefined)) {
      const sign = m[1] === '-' ? -1 : 1;
      const ft = m[2] ? parseFloat(m[2]) : 0;
      let inch = m[3] ? parseFloat(m[3]) : 0;
      if (m[4]) inch += parseInt(m[4], 10) / parseInt(m[5], 10);
      if (!m[2] && !/["]/.test(s) && !m[4] && m[3]) return sign * parseFloat(m[3]);
      return sign * (ft * 12 + inch);
    }
    const f = s.match(/^([-+]?\d+)\/(\d+)$/);
    if (f) return parseInt(f[1], 10) / parseInt(f[2], 10);
    return NaN;
  }

  /**
   * Parses an angle typed by the user: degrees, "12d30'15\"", or with an r (radians) / g (gradians) suffix.
   * @param {string} str
   * @returns {number} the angle in radians, or NaN when the text is not an angle
   */
  static parseAngle(str) {
    const s = String(str).trim();
    const m = s.match(
      /^([-+]?\d+(?:\.\d+)?)\s*(?:d|°)?\s*(?:(\d+(?:\.\d+)?)\s*')?\s*(?:(\d+(?:\.\d+)?)\s*")?\s*(r|g)?$/i,
    );
    if (!m) return NaN;
    let v = parseFloat(m[1]);
    if (m[2]) v += ((v < 0 ? -1 : 1) * parseFloat(m[2])) / 60;
    if (m[3]) v += ((v < 0 ? -1 : 1) * parseFloat(m[3])) / 3600;
    if (m[4] && m[4].toLowerCase() === 'r') return v;
    if (m[4] && m[4].toLowerCase() === 'g') return rad((v * 360) / 400);
    return rad(v);
  }

  /** @returns {string} a point as "x, y" with both coordinates formatted as lengths. */
  static formatPoint(p, u) {
    return `${Units.formatLength(p.x, u)}, ${Units.formatLength(p.y, u)}`;
  }
}

/* ============================================================================================
 * 4. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const defaultUnits = Units.defaults;
export const fmtLen = Units.formatLength;
export const fmtAng = Units.formatAngle;
export const parseDist = Units.parseDistance;
export const parseAng = Units.parseAngle;
export const fmtPt = Units.formatPoint;
