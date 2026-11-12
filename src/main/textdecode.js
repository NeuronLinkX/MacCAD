'use strict';
/**
 * @file textdecode.js
 * @brief Decoding of DXF files that are not UTF-8.
 *
 * DXF files from Windows AutoCAD are often NOT UTF-8: R2004 and older store text in the code page
 * named by $DWGCODEPAGE (ANSI_949 for Korean). Reading them as UTF-8 turns every Korean / CJK
 * character into U+FFFD, so the code page is read from the header and used for decoding.
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** $DWGCODEPAGE value -> label understood by `TextDecoder`. */
const CODEPAGES = {
  ANSI_949: 'euc-kr',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_950: 'big5',
  ANSI_874: 'windows-874',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  UTF8: 'utf-8',
  UTF_8: 'utf-8',
  DOS437: 'ibm866',
};

/** How many bytes at the start of the file are searched for the header variables. */
const HEADER_SCAN_BYTES = 20000;

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Static helpers for turning DXF bytes into text. */
class TextDecode {
  /**
   * Decodes with a strict decoder.
   * @private
   * @param {string} label TextDecoder label
   * @param {Uint8Array} buf bytes
   * @returns {string|null} the text, or null when the bytes are not valid in that encoding
   */
  static tryDecode(label, buf) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  }

  /**
   * Decodes a DXF file.
   * Order: UTF-8 when it is certain (R2007+ is always UTF-8, or the text is plain ASCII, or no code
   * page is named), then the declared code page, then UTF-8 as a guess, then EUC-KR, then Latin-1.
   * @param {Buffer} buf the file contents
   * @returns {string}
   */
  static decodeDxf(buf) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3); // UTF-8 BOM
    const head = Buffer.from(buf.subarray(0, Math.min(buf.length, HEADER_SCAN_BYTES))).toString(
      'latin1',
    );
    const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([A-Za-z0-9_\-]+)/.exec(head);
    const ver = (/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/.exec(head) || [])[1] || '';
    const utf8 = TextDecode.tryDecode('utf-8', buf);
    if (
      utf8 !== null &&
      (ver >= 'AC1021' || !/[\u0080-\uffff]/.test(utf8) || !m || /UTF/i.test(m[1]))
    )
      return utf8; // R2007+ is always UTF-8
    const label = m && CODEPAGES[m[1].toUpperCase()];
    if (label) {
      const t = TextDecode.tryDecode(label, buf);
      if (t !== null) return t;
    }
    if (utf8 !== null) return utf8;
    return TextDecode.tryDecode('euc-kr', buf) ?? Buffer.from(buf).toString('latin1');
  }
}

/* ============================================================================================
 * 3. EXPORTS
 * ========================================================================================== */
module.exports = { TextDecode, decodeDxf: TextDecode.decodeDxf };
