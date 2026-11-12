/**
 * @file markdown.js
 * @brief Tiny Markdown renderer for the built-in manuals.
 *
 * Supports headings, bullet / numbered lists, tables, fenced code, block quotes, rules and the
 * inline styles `code`, **bold**, *italic* and [links] (links render as underlined text only, the
 * manuals have nothing to navigate to). Output is an HTML string with inline styles, so it needs no
 * stylesheet of its own; colours come from the CSS variables of the host window.
 */

/* ============================================================================================
 * 1. CLASS
 * ========================================================================================== */

/** Converts Markdown text to an HTML string. */
export class MarkdownRenderer {
  /** @private @returns {string} s with &, < and > escaped. */
  static escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** @private @returns {string} one line of text with the inline styles applied. */
  static inline(s) {
    return MarkdownRenderer.escape(s)
      .replace(
        /`([^`]+)`/g,
        '<code style="background:var(--hover);padding:0 3px;border-radius:2px;font-family:Menlo,monospace;font-size:12px">$1</code>',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
  }

  /**
   * Renders a Markdown document.
   * @param {string} md Markdown source
   * @returns {string} HTML
   */
  static render(md) {
    const esc = MarkdownRenderer.escape;
    const inline = MarkdownRenderer.inline;
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    /** Writes the collected paragraph lines as one <p> and empties the buffer. */
    const flushPara = (buf) => {
      if (buf.length) out.push(`<p style="margin:6px 0">${inline(buf.join(' '))}</p>`);
      buf.length = 0;
    };
    const para = [];
    while (i < lines.length) {
      const ln = lines[i];

      // fenced code block
      const fence = /^(```|~~~)/.exec(ln);
      if (fence) {
        flushPara(para);
        const code = [];
        i += 1;
        while (i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i++]);
        i += 1;
        out.push(
          `<pre style="background:var(--hover);border:1px solid var(--sep);padding:6px 8px;overflow:auto;font:12px/1.45 Menlo,'Courier New',monospace;margin:6px 0;white-space:pre">${esc(code.join('\n'))}</pre>`,
        );
        continue;
      }

      // heading
      const hd = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (hd) {
        flushPara(para);
        const n = hd[1].length;
        const sz = [0, 22, 17, 14, 13][n];
        out.push(
          `<h${n} id="${esc(hd[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'))}" style="font-size:${sz}px;margin:${n === 1 ? 6 : 16}px 0 6px;color:#12408c;${n <= 2 ? 'border-bottom:1px solid #d6d2c0;' : ''}">${inline(hd[2])}</h${n}>`,
        );
        i += 1;
        continue;
      }

      // horizontal rule
      if (/^\s*---+\s*$/.test(ln)) {
        flushPara(para);
        out.push('<hr>');
        i += 1;
        continue;
      }

      // table (a header row followed by a |---|---| separator row)
      if (/^\|.*\|\s*$/.test(ln) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
        flushPara(para);
        const cells = (r) =>
          r
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim());
        const head = cells(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(
          `<table style="border-collapse:collapse;margin:6px 0;font-size:12px"><tr>${head.map((c) => `<th style="border:1px solid var(--sep);background:var(--face);padding:2px 7px;text-align:left">${inline(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td style="border:1px solid var(--sep);padding:2px 7px;vertical-align:top">${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`,
        );
        continue;
      }

      // bullet or numbered list
      const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(ln);
      if (li) {
        flushPara(para);
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
          i += 1;
        }
        out.push(
          `<${ordered ? 'ol' : 'ul'} style="margin:4px 0 4px 20px;padding:0">${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`,
        );
        continue;
      }

      // block quote
      if (/^>\s?/.test(ln)) {
        flushPara(para);
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
        out.push(
          `<blockquote style="margin:6px 0;padding:2px 10px;border-left:3px solid #9bb4e0;background:#f4f7fd">${inline(q.join(' '))}</blockquote>`,
        );
        continue;
      }

      // blank line ends a paragraph; anything else is paragraph text
      if (!ln.trim()) {
        flushPara(para);
        i += 1;
        continue;
      }
      para.push(ln.trim());
      i += 1;
    }
    flushPara(para);
    return out.join('\n');
  }
}

/* ============================================================================================
 * 2. COMPATIBILITY EXPORTS
 * ========================================================================================== */
export const renderMarkdown = MarkdownRenderer.render;
