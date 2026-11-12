'use strict';
/**
 * @file bigmcad.js
 * @brief Reading very large .mcad drawings.
 *
 * A drawing with big solids (an imported STEP assembly) is a .mcad of hundreds of MB. JavaScript
 * cannot hold such a text in one string, so the file is read as bytes: the BREP text of every big
 * solid is cut out of the JSON and returned on its own, and the small rest (the "head") stays a
 * normal JSON text with placeholders where the solids were.
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** The bytes that start a solid's BREP string inside the JSON. */
const BREP_KEY = Buffer.from('"brep":"');
/** Characters; as BIG_BREP in doc.js: shorter solid data stays inline in the head. */
const BIG_BREP_CHARS = 20000;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Splits a big .mcad buffer into a small JSON head and the separate BREP strings. */
class BigMcad {
  /**
   * @param {Buffer} buf the whole file
   * @returns {{data: string, breps: string[]}} `data` = the JSON text with each big BREP replaced
   *          by the placeholder "\u0001<index>\u0001"; `breps[index]` = that BREP text
   * @throws {Error} when the file is damaged (a solid string is cut off)
   */
  static split(buf) {
    const pieces = [];
    const breps = [];
    let last = 0;
    let pos = 0;
    for (;;) {
      const i = buf.indexOf(BREP_KEY, pos);
      if (i < 0) break;
      const start = i + BREP_KEY.length; // first byte of the string content
      const end = BigMcad.closingQuote(buf, start);
      pos = end + 1;
      if (end - start < BIG_BREP_CHARS) continue; // short: stays in the head
      pieces.push(buf.toString('utf8', last, start - 1)); // up to (not including) the opening quote
      pieces.push(`"\\u0001${breps.length}\\u0001"`);
      breps.push(JSON.parse(buf.toString('utf8', start - 1, end + 1)));
      last = end + 1;
    }
    pieces.push(buf.toString('utf8', last));
    return { data: pieces.join(''), breps };
  }

  /**
   * Finds the closing quote of a JSON string: the first quote that is not escaped (an even number
   * of backslashes before it).
   * @private
   * @param {Buffer} buf the file
   * @param {number} start index of the first byte of the string content
   * @returns {number} index of the closing quote
   * @throws {Error} when no closing quote exists
   */
  static closingQuote(buf, start) {
    let j = start;
    for (;;) {
      j = buf.indexOf(QUOTE, j);
      if (j < 0) throw new Error('The drawing file is damaged (a solid is cut off).');
      let n = 0;
      let k = j - 1;
      while (k >= start && buf[k] === BACKSLASH) {
        n += 1;
        k -= 1;
      }
      if (n % 2 === 0) return j;
      j += 1;
    }
  }
}

/* ============================================================================================
 * 3. EXPORTS
 * ========================================================================================== */
module.exports = { BigMcad, splitBigMcad: BigMcad.split };
