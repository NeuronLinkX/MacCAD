/**
 * @file dialogs_license.js
 * @brief The LICENSE window: trial state, Computer ID, key entry.
 *
 * Registers `dialogs.licenseDialog`, which the LICENSE command (commands_license.js) calls.
 */

/* ============================================================================================
 * 1. INCLUDES
 * ========================================================================================== */
import { dialogs, dialog } from './dialogs.js';
import { license } from './license.js';
import { showSubscriptionDialog } from './dialogs_subscription.js';

/* ============================================================================================
 * 2. CLASS
 * ========================================================================================== */

/** Builds and runs the licence window. */
export class LicenseDialog {
  /**
   * Tiny element factory: `h('div', {class: 'x', onclick: fn}, child, 'text')`.
   * @private
   * @param {string} tag element name
   * @param {object} [attrs] `class`, `html`, `onxxx` handlers, or plain attributes
   * @param {...(Node|string|Array)} kids children (strings become text nodes)
   * @returns {HTMLElement}
   */
  static h(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat())
      if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }

  /**
   * Shows the licence window and waits until it is closed.
   * Buttons: Activate (checks and stores the pasted key), Get a key (opens the contact form),
   * Remove key (only while a key is in use), Close.
   * @returns {Promise<void>}
   */
  static async show() {
    if ((typeof __MACCAD_MAS__ !== 'undefined' && __MACCAD_MAS__) || window.api?.distribution === 'app-store') return showSubscriptionDialog(LicenseDialog.h);
    const h = LicenseDialog.h;
    await license.refresh();
    const info = h('div', { class: 'lic-info' });
    const msg = h('div', { class: 'lic-msg' });
    const key = h('textarea', {
      name: 'key',
      rows: 4,
      spellcheck: 'false',
      placeholder: 'MCAD1.xxxxx.xxxxx',
      style: 'width:100%;font:12px ui-monospace,Menlo,monospace;box-sizing:border-box',
    });
    let boxEl = null;
    const licensed = () => (license.status || {}).state === 'licensed';

    // "Remove key" shows while a key is in use, also right after Activate
    const syncRemove = () => {
      const rm = boxEl && boxEl.querySelector('.df .b[data-val="rm"]');
      if (rm) rm.style.display = licensed() ? '' : 'none';
    };
    // the status lines at the top of the window
    const show = () => {
      syncRemove();
      info.innerHTML = '';
      license
        .lines()
        .forEach((t, i) => info.append(h('div', { class: i ? 'lic-sub' : 'lic-main' }, t)));
      const s = license.status || {};
      if (s.keyError) info.append(h('div', { class: 'lic-bad' }, s.keyError));
    };
    show();

    const idBox = h('input', {
      type: 'text',
      readonly: 'readonly',
      value: (license.status || {}).machine || '(not available)',
      style: 'width:200px;font:13px ui-monospace,Menlo,monospace',
      onfocus: (e) => e.target.select(),
    });
    const idCopy = h(
      'button',
      {
        class: 'b',
        type: 'button',
        onclick: () => {
          idBox.focus();
          idBox.select();
          try {
            document.execCommand('copy');
            msg.textContent = 'The Computer ID was copied.';
            msg.className = 'lic-msg ok';
          } catch {
            /* select and copy by hand */
          }
        },
      },
      'Copy',
    );
    const body = h(
      'div',
      { style: 'width:460px;line-height:1.55' },
      info,
      h('div', { style: 'margin:12px 0 4px;font-weight:600' }, 'Computer ID'),
      h('div', { style: 'display:flex;gap:8px;align-items:center' }, idBox, idCopy),
      h(
        'div',
        { class: 'lic-sub', style: 'margin-top:4px' },
        'A key works on one computer only: the one with this ID. "Get a key" puts the ID into the contact form for you.',
      ),
      h('div', { style: 'margin:12px 0 4px;font-weight:600' }, 'Licence key'),
      key,
      msg,
      h(
        'div',
        { class: 'lic-sub', style: 'margin-top:8px' },
        'The key is checked on this Mac. Nothing is sent over the network. To get a key, press "Get a key" and send the message on the contact page that opens (the developer replies with the key for your Computer ID).',
      ),
    );

    await dialog({
      title: 'MacCAD 2027 Licence',
      body,
      width: 500,
      buttons: [
        { label: 'Activate', value: 'act', primary: true },
        { label: 'Get a key', value: 'buy' },
        { label: 'Remove key', value: 'rm' },
        { label: 'Close', value: null },
      ],
      onOpen: (box) => {
        boxEl = box;
        syncRemove();
      },
      // every button except Close keeps the window open (return false)
      onButton: async (v) => {
        if (v === 'buy') {
          await license.buy();
          return false;
        }
        if (v === 'rm') {
          await license.remove();
          show();
          msg.textContent = 'The key was removed from this Mac.';
          msg.className = 'lic-msg';
          return false;
        }
        if (v === 'act') {
          const r = await license.activate(key.value);
          if (r.ok) {
            show();
            msg.textContent = 'The key is accepted. Thank you.';
            msg.className = 'lic-msg ok';
            key.value = '';
          } else {
            msg.textContent = r.error || 'The key was not accepted.';
            msg.className = 'lic-msg err';
          }
          return false;
        }
        return true;
      },
    });
  }
}

/* ============================================================================================
 * 3. REGISTRATION
 * ========================================================================================== */
dialogs.licenseDialog = LicenseDialog.show;
