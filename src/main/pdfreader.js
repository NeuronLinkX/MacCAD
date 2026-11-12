/**
 * @file pdfreader.js
 * @brief PDF vector reader (main process, pdf.js).
 *
 * Extracts stroked / filled paths and text from one page and returns plain geometry in millimetres
 * (origin lower-left, y up) for the PDFIMPORT command.
 *
 * Matrices here are PDF style 6-element arrays [a, b, c, d, e, f] (x' = a*x + c*y + e,
 * y' = b*x + d*y + f), not the {a..f} objects of geom.js, because pdf.js hands them out that way.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
const fs = require('fs');

/* ============================================================================================
 * 2. CONSTANTS
 * ========================================================================================== */

/** Millimetres per PDF point (1/72 inch). */
const MM_PER_PT = 25.4 / 72;
/** Straight segments a cubic curve is flattened into. */
const CUBIC_STEPS = 10;
/** Straight segments a quadratic curve is flattened into. */
const QUADRATIC_STEPS = 8;

/** pdf.js path command codes inside a `constructPath` argument. */
const PATH_MOVE = 0;
const PATH_LINE = 1;
const PATH_CUBIC = 2;
const PATH_QUADRATIC = 3;
const PATH_CLOSE = 4;

/* ============================================================================================
 * 3. CLASS
 * ========================================================================================== */

/** Reads one page of a PDF into plain geometry. */
class PdfReader {
  /**
   * Loads pdf.js once (it is an ES module, so it needs a dynamic import).
   * @private
   * @returns {Promise<object>} the pdf.js module
   */
  static getPdfjs() {
    return (PdfReader.pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));
  }

  /** @private @returns {number[]} matrix product m * n (n is applied first). */
  static mmul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  /** @private @returns {number[]} point (x, y) transformed by matrix m, as [x', y']. */
  static apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** @private @returns {string} "#rrggbb" from three 0..255 components. */
  static hex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }

  /**
   * Turns one pdf.js path (command + coordinate array) into polylines in CAD space and appends the
   * stroked / filled ones to `out.paths`. Curves are flattened into short segments.
   * @private
   * @param {object} st reader state: `{OPS, toCad, ctm, lw, stroke, fill, out}`
   * @param {number[]} cmds pdf.js path commands with their coordinates
   * @param {number} paintOp the pdf.js operator that paints the path (stroke, fill, both ...)
   */
  static emit(st, cmds, paintOp) {
    const { OPS, out } = st;
    const m = st.toCad(st.ctm);
    const subs = [];
    let cur = null;
    for (let i = 0; i < cmds.length; ) {
      const c = cmds[i++];
      if (c === PATH_MOVE) {
        cur = { pts: [PdfReader.apply(m, cmds[i], cmds[i + 1])], closed: false };
        i += 2;
        subs.push(cur);
      } else if (c === PATH_LINE) {
        if (!cur) {
          cur = { pts: [], closed: false };
          subs.push(cur);
        }
        cur.pts.push(PdfReader.apply(m, cmds[i], cmds[i + 1]));
        i += 2;
      } else if (c === PATH_CUBIC) {
        const p0 = cur ? cur.pts[cur.pts.length - 1] : null;
        const a = PdfReader.apply(m, cmds[i], cmds[i + 1]);
        const b = PdfReader.apply(m, cmds[i + 2], cmds[i + 3]);
        const d = PdfReader.apply(m, cmds[i + 4], cmds[i + 5]);
        i += 6;
        if (p0)
          for (let k = 1; k <= CUBIC_STEPS; k += 1) {
            const t = k / CUBIC_STEPS;
            const u = 1 - t;
            cur.pts.push([
              u ** 3 * p0[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t ** 3 * d[0],
              u ** 3 * p0[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t ** 3 * d[1],
            ]);
          }
      } else if (c === PATH_QUADRATIC) {
        const p0 = cur ? cur.pts[cur.pts.length - 1] : null;
        const a = PdfReader.apply(m, cmds[i], cmds[i + 1]);
        const d = PdfReader.apply(m, cmds[i + 2], cmds[i + 3]);
        i += 4;
        if (p0)
          for (let k = 1; k <= QUADRATIC_STEPS; k += 1) {
            const t = k / QUADRATIC_STEPS;
            const u = 1 - t;
            cur.pts.push([
              u * u * p0[0] + 2 * u * t * a[0] + t * t * d[0],
              u * u * p0[1] + 2 * u * t * a[1] + t * t * d[1],
            ]);
          }
      } else if (c === PATH_CLOSE) {
        if (cur) cur.closed = true;
      } else break;
    }
    const stroked = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ].includes(paintOp);
    const filled = [
      OPS.fill,
      OPS.eoFill,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke,
    ].includes(paintOp);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    for (const s of subs) {
      if (s.pts.length < 2) continue;
      if (stroked)
        out.paths.push({
          pts: s.pts,
          closed: s.closed || paintOp === OPS.closeStroke,
          color: st.stroke,
          lw: (st.lw * scale) / 1,
        });
      if (filled && s.pts.length >= 3) out.paths.push({ pts: s.pts, closed: true, fill: st.fill });
    }
  }

  /**
   * Reads one page of a PDF file.
   * @param {string} file path of the PDF
   * @param {number} [pageNo=1] page number (clamped to the real page count)
   * @returns {Promise<{width: number, height: number, pages: number, paths: object[], texts: object[], stats: object}>}
   *          page size and the geometry in millimetres:
   *          `paths` = `{pts, closed, color, lw}` or `{pts, closed, fill}`;
   *          `texts` = `{str, x, y, h, rot}`
   */
  static async read(file, pageNo = 1) {
    const pdfjs = await PdfReader.getPdfjs();
    const OPS = pdfjs.OPS;
    const data = new Uint8Array(fs.readFileSync(file));
    const doc = await pdfjs.getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
    const vp = page.getViewport({ scale: 1 }); // handles /Rotate and the crop box; device space is y-down
    const W = vp.width;
    const H = vp.height;
    const base = [
      vp.transform[0],
      vp.transform[1],
      vp.transform[2],
      vp.transform[3],
      vp.transform[4],
      vp.transform[5],
    ];
    // PDF user space -> device (y-down, pt) -> CAD (y-up, mm)
    const toCad = (m) =>
      PdfReader.mmul([MM_PER_PT, 0, 0, -MM_PER_PT, 0, H * MM_PER_PT], PdfReader.mmul(base, m));
    const ol = await page.getOperatorList();
    const out = {
      width: W * MM_PER_PT,
      height: H * MM_PER_PT,
      pages: doc.numPages,
      paths: [],
      texts: [],
      stats: {},
    };

    // graphics state while walking the operator list
    const st = {
      OPS,
      toCad,
      out,
      ctm: [1, 0, 0, 1, 0, 0],
      lw: 1,
      stroke: '#000000',
      fill: '#000000',
    };
    const stack = [];
    for (let k = 0; k < ol.fnArray.length; k += 1) {
      const fn = ol.fnArray[k];
      const args = ol.argsArray[k];
      switch (fn) {
        case OPS.save:
          stack.push({ ctm: st.ctm.slice(), lw: st.lw, stroke: st.stroke, fill: st.fill });
          break;
        case OPS.restore: {
          const s = stack.pop();
          if (s) Object.assign(st, s);
          break;
        }
        case OPS.transform:
          st.ctm = PdfReader.mmul(st.ctm, args);
          break;
        case OPS.setLineWidth:
          st.lw = args[0];
          break;
        case OPS.setStrokeRGBColor:
          st.stroke =
            typeof args[0] === 'string' ? args[0] : PdfReader.hex(args[0], args[1], args[2]);
          break;
        case OPS.setFillRGBColor:
          st.fill =
            typeof args[0] === 'string' ? args[0] : PdfReader.hex(args[0], args[1], args[2]);
          break;
        case OPS.constructPath: {
          const [op, arr] = args;
          PdfReader.emit(st, Array.from(arr[0] ?? arr), op);
          break;
        }
        default:
          break;
      }
    }

    // text is optional: a page without usable text content still imports its lines
    try {
      const tc = await page.getTextContent();
      for (const t of tc.items) {
        if (!t.str || !t.str.trim()) continue;
        const m = toCad(t.transform);
        const h = Math.hypot(m[2], m[3]) || Math.hypot(t.transform[2], t.transform[3]) * MM_PER_PT;
        out.texts.push({ str: t.str, x: m[4], y: m[5], h, rot: Math.atan2(m[1], m[0]) });
      }
    } catch {
      /* text is optional */
    }
    out.stats = { paths: out.paths.length, texts: out.texts.length, ops: ol.fnArray.length };
    return out;
  }
}

/** @private Promise of the loaded pdf.js module. */
PdfReader.pdfjsPromise = null;

/* ============================================================================================
 * 4. EXPORTS
 * ========================================================================================== */
module.exports = { PdfReader, readPdf: PdfReader.read };
