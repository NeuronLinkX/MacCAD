/**
 * @file fonts.js
 * @brief Font resolution.
 *
 * AutoCAD SHX names, Windows TrueType names and Korean fonts are mapped onto the bundled fonts so
 * that text renders identically on every machine and never falls back to broken glyphs.
 *
 * Contents: FontResolver (name -> CSS font stack, name -> DXF/DWG file name, font loading) and the
 * choices offered in the Text Style dialog.
 */

/* ============================================================================================
 * 1. CONSTANTS
 * ========================================================================================== */

/** Korean fallbacks, symbol fallbacks and the common tail of every stack. */
const KO = '"Nanum Gothic", "Apple SD Gothic Neo", "Malgun Gothic"';
const SYM = '"DejaVu Sans", "Apple Symbols", "Segoe UI Symbol"';
const TAIL = `${KO}, ${SYM}, sans-serif`;

/** AutoCAD SHX fonts drawn with single strokes (rendered with the ISO lettering font). */
const SHX_STROKE = new Set([
  'txt',
  'simplex',
  'romans',
  'isocp',
  'isocp2',
  'isocp3',
  'isoct',
  'isoct2',
  'isoct3',
  'iso',
  'iso3098',
  'greeks',
  'scripts',
  'gothics',
  'monotxt',
  'symap',
  'symath',
  'symeteo',
  'symusic',
  'syastro',
  'amgdt',
  'pointcam',
  'ltypeshp',
]);

/** AutoCAD SHX fonts with serifs (rendered with the bundled serif font). */
const SHX_SERIF = new Set([
  'romanc',
  'romand',
  'romant',
  'italicc',
  'italict',
  'complex',
  'gothice',
  'gothicg',
  'gothici',
  'greekc',
  'scriptc',
  'italic',
]);

/** Monospaced font names. */
const MONO = new Set([
  'monotxt',
  'consolas',
  'courier',
  'courier new',
  'lucida console',
  'menlo',
  'monaco',
  'cour',
]);

/** Korean sans-serif and serif font names (also the Hangul spellings). */
const KR_SANS =
  /(gulim|dotum|malgun|nanumgothic|nanum gothic|hangul|hz|hzdx|whgtxt|whgdtxt|whtgtxt|whtmtxt|hanq|han_|ahn|apple sd|bold gothic|gothic|굴림|돋움|맑은)/i;
const KR_SERIF = /(batang|gungsuh|myeongjo|myungjo|바탕|궁서|명조|hymyeongjo)/i;

/** Choices offered in the Text Style dialog: [display name, stored name]. */
export const FONT_CHOICES = [
  ['Liberation Sans (Arial)', 'Arial'],
  ['Liberation Serif (Times New Roman)', 'Times New Roman'],
  ['Liberation Mono (Courier New)', 'Courier New'],
  ['Nanum Gothic (한글 고딕)', 'NanumGothic'],
  ['Nanum Myeongjo (한글 명조)', 'NanumMyeongjo'],
  ['osifont (ISO CAD lettering)', 'osifont'],
  ['txt.shx', 'txt.shx'],
  ['simplex.shx', 'simplex.shx'],
  ['romans.shx', 'romans.shx'],
  ['romanc.shx', 'romanc.shx'],
  ['romand.shx', 'romand.shx'],
  ['romant.shx', 'romant.shx'],
  ['italic.shx', 'italic.shx'],
  ['italicc.shx', 'italicc.shx'],
  ['italict.shx', 'italict.shx'],
  ['isocp.shx', 'isocp.shx'],
  ['isocp2.shx', 'isocp2.shx'],
  ['isocp3.shx', 'isocp3.shx'],
  ['isoct.shx', 'isoct.shx'],
  ['monotxt.shx', 'monotxt.shx'],
  ['complex.shx', 'complex.shx'],
  ['gothice.shx', 'gothice.shx'],
  ['greekc.shx', 'greekc.shx'],
  ['scripts.shx', 'scripts.shx'],
  ['Gulim (굴림)', 'Gulim'],
  ['Dotum (돋움)', 'Dotum'],
  ['Batang (바탕)', 'Batang'],
  ['Gungsuh (궁서)', 'Gungsuh'],
  ['Malgun Gothic (맑은 고딕)', 'Malgun Gothic'],
  ['Verdana', 'Verdana'],
  ['Tahoma', 'Tahoma'],
  ['Calibri', 'Calibri'],
  ['Georgia', 'Georgia'],
  ['Consolas', 'Consolas'],
];

/** The file name written to DXF/DWG so that Windows AutoCAD picks the matching font. */
const FILES = {
  arial: 'arial.ttf',
  'times new roman': 'times.ttf',
  'courier new': 'cour.ttf',
  verdana: 'verdana.ttf',
  tahoma: 'tahoma.ttf',
  calibri: 'calibri.ttf',
  georgia: 'georgia.ttf',
  consolas: 'consola.ttf',
  gulim: 'gulim.ttc',
  dotum: 'dotum.ttc',
  batang: 'batang.ttc',
  gungsuh: 'gungsuh.ttc',
  'malgun gothic': 'malgun.ttf',
  nanumgothic: 'NanumGothic.ttf',
  nanummyeongjo: 'NanumMyeongjo.ttf',
  osifont: 'osifont.ttf',
  helvetica: 'arial.ttf',
  'helvetica neue': 'arial.ttf',
  menlo: 'cour.ttf',
};

/** The faces loaded up front by `FontResolver.load`. */
const BUNDLED_FACES = [
  '400 16px "Liberation Sans"',
  '700 16px "Liberation Sans"',
  '400 16px "Liberation Serif"',
  '400 16px "Liberation Mono"',
  '400 16px "Nanum Gothic"',
  '700 16px "Nanum Gothic"',
  '400 16px "Nanum Myeongjo"',
  '400 16px "osifont"',
  '400 16px "DejaVu Sans"',
];

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Static helpers that map font names onto the bundled fonts. */
export class FontResolver {
  /**
   * Normalises a font name for lookups: no file extension, lower case.
   * @param {string} name font name or file name
   * @returns {string}
   */
  static baseKey(name) {
    return String(name || '')
      .trim()
      .replace(/\.(shx|ttf|ttc|otf|fon)$/i, '')
      .toLowerCase();
  }

  /**
   * The CSS font-family stack for a text style's font name.
   * @param {string} name the font name stored in the style (SHX, TrueType or empty)
   * @returns {string}
   */
  static stack(name) {
    const k = FontResolver.baseKey(name);
    if (!k) return `"Liberation Sans", Arial, Helvetica, ${TAIL}`;
    if (KR_SERIF.test(k)) return `"Nanum Myeongjo", "AppleMyungjo", "Batang", ${SYM}, serif`;
    if (KR_SANS.test(k))
      return `"Nanum Gothic", "Apple SD Gothic Neo", "Malgun Gothic", ${SYM}, sans-serif`;
    if (MONO.has(k) || /mono|courier|consolas/.test(k))
      return `"Liberation Mono", "Courier New", Menlo, ${TAIL}`;
    if (SHX_STROKE.has(k) || /^iso/.test(k)) return `"osifont", "Liberation Sans", ${TAIL}`;
    if (SHX_SERIF.has(k) || /^(roman|italic|script|gothic|greek)/.test(k))
      return `"Liberation Serif", "Times New Roman", ${TAIL}`;
    if (/times|georgia|garamond|palatino|cambria|serif|book|century/.test(k))
      return `"Liberation Serif", "Times New Roman", Times, ${TAIL}`;
    if (/arial|helvetica|verdana|tahoma|calibri|segoe|trebuchet|sans|roboto|open|noto/.test(k))
      return `"${name.replace(/\.(ttf|ttc|otf)$/i, '')}", "Liberation Sans", Arial, Helvetica, ${TAIL}`;
    return `"${String(name)
      .replace(/\.(shx|ttf|ttc|otf)$/i, '')
      .replace(/"/g, '')}", "Liberation Sans", Arial, ${TAIL}`;
  }

  /**
   * The font file name written to DXF / DWG for a font name.
   * @param {string} name font name
   * @returns {string} for example "arial.ttf"; "txt.shx" for an empty name
   */
  static fileName(name) {
    const raw = String(name || '').trim();
    if (/\.(shx|ttf|ttc|otf)$/i.test(raw)) return raw;
    return FILES[raw.toLowerCase()] || (raw ? `${raw}.ttf` : 'txt.shx');
  }

  /**
   * Loads the bundled faces up front; resolves when they are ready (callers then clear their
   * text-measure caches and redraw). Does nothing outside a browser window.
   * @returns {Promise<void>}
   */
  static async load() {
    if (typeof document === 'undefined' || !document.fonts) return;
    await Promise.all(
      BUNDLED_FACES.map((face) => document.fonts.load(face, 'AaBb 한글 Ø°±').catch(() => null)),
    );
    await document.fonts.ready;
  }
}

/* ============================================================================================
 * 3. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const baseKey = FontResolver.baseKey;
export const fontStack = FontResolver.stack;
export const fontFileName = FontResolver.fileName;
export const loadFonts = FontResolver.load;
