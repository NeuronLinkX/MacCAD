/**
 * @file textcodes.js
 * @brief Decoding of AutoCAD text escape sequences.
 *
 * Handles the TEXT codes (%%c %%d %%p %%nnn %%u %%o) and the MTEXT format codes (\P, \U+XXXX,
 * stacked fractions, font and height switches ...), turning them into plain text.
 */

/* ============================================================================================
 * 1. CLASS
 * ========================================================================================== */

/** Static helpers that turn AutoCAD text codes into plain strings. */
export class TextCodes {
  /**
   * Decodes TEXT codes: %%c -> diameter sign, %%d -> degree, %%p -> plus/minus, %%% -> %, %%nnn -> char code.
   * @param {string} str raw text
   * @returns {{text: string, u: boolean, o: boolean}} the decoded text and whether %%u (underline) / %%o (overline) appeared
   */
  static decode(str) {
    let u = false;
    let o = false;
    const s = String(str ?? '').replace(/%%([cCdDpP%uUoO]|\d{3})/g, (m, c) => {
      const k = c.toLowerCase();
      if (k === 'c') return 'Ø';
      if (k === 'd') return '°';
      if (k === 'p') return '±';
      if (c === '%') return '%';
      if (k === 'u') {
        u = !u;
        return '';
      }
      if (k === 'o') {
        o = !o;
        return '';
      }
      return String.fromCharCode(parseInt(c, 10));
    });
    return { text: s, u: /%%[uU]/.test(str ?? ''), o: /%%[oO]/.test(str ?? '') };
  }

  /**
   * Converts MTEXT to plain text with "\n" line breaks.
   * Font, height, width, tracking and colour switches are dropped; stacked fractions become "a/b".
   * @param {string} raw MTEXT contents
   * @returns {{text: string, u: boolean, o: boolean}} plain text and whether underline / overline codes appeared
   */
  static parseMText(raw) {
    let s = String(raw ?? '');
    let under = false;
    let over = false;
    s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/\\M\+([0-9A-Fa-f]{5})/g, '?');
    s = s
      .replace(/\\[Ff][^;]*;/g, '')
      .replace(/\\[HhWwQqTtAaCc][0-9.+\-xX]*;/g, '')
      .replace(/\\[Kk]/g, '');
    s = s.replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, (m, a, b) =>
      /\^/.test(m) ? `${a} ${b}` : `${a}/${b}`,
    );
    s = s
      .replace(/\\L/g, () => {
        under = true;
        return '';
      })
      .replace(/\\l/g, '')
      .replace(/\\O/g, () => {
        over = true;
        return '';
      })
      .replace(/\\o/g, '');
    s = s
      .replace(/\\P/gi, '\n')
      .replace(/\\N/g, '\n')
      .replace(/\\~/g, ' ')
      .replace(/\\\\/g, '\u0001')
      .replace(/\\([{}])/g, '$1')
      .replace(/[{}]/g, '')
      .replace(/\u0001/g, '\\');
    const d = TextCodes.decode(s);
    return { text: d.text, u: under || d.u, o: over || d.o };
  }
}

/* ============================================================================================
 * 2. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const decodeText = TextCodes.decode;
export const parseMText = TextCodes.parseMText;
