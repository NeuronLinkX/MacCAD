import { dialog } from './dialogs.js';
import { license } from './license.js';

export async function showSubscriptionDialog(h) {
  const api = window.api;
  const info = h('div', { 'aria-live': 'polite' });
  const plans = h('div', {}, 'Loading subscription plans…');
  const message = h('div', { class: 'lic-msg', 'aria-live': 'polite' });
  const links = h('div', { style: 'display:flex;gap:16px;margin-top:12px' });
  const body = h('div', { style: 'line-height:1.6' },
    h('p', {}, 'MacCAD Pro includes drawing editing, saving and export. You can continue viewing your drawings without a subscription.'),
    info, plans, message,
    h('p', { class: 'lic-sub' }, 'Subscriptions renew automatically unless cancelled. Any eligible free trial starts when you confirm the subscription with Apple; the displayed subscription price applies after the trial. Manage or cancel in your App Store account.'), links);
  let busy = false;
  let box;
  let closed = false;
  const renderStatus = () => { info.replaceChildren(...license.lines().map((line) => h('div', {}, line))); };
  const unsubscribe = license.on(renderStatus);
  renderStatus();
  function setBusy(value) {
    busy = value;
    for (const button of body.querySelectorAll('button')) button.disabled = value;
    for (const button of box?.querySelectorAll('.df button') || []) {
      if (button.dataset.val !== 'null') button.disabled = value;
    }
  }
  async function run(action) {
    if (busy) return;
    setBusy(true);
    message.textContent = 'Connecting to the App Store…';
    try {
      const result = await action();
      if (result?.status) license._set(result.status);
      const texts = { cancelled: 'Purchase cancelled. No new subscription was activated.',
        pending: 'Your purchase is awaiting approval. Access will update after Apple confirms it.',
        busy: 'Another App Store request is in progress.', purchased: 'Purchase received. Your verified access is shown above.' };
      message.textContent = texts[result?.outcome] || 'Purchase information refreshed.';
      renderStatus();
    } catch { message.textContent = 'The App Store could not complete the request. Check your connection and try again.'; }
    finally { setBusy(false); }
  }
  async function load() {
    try {
      const data = await api.subscriptionProducts();
      if (closed) return;
      plans.replaceChildren();
      for (const product of data.products) {
        const period = `${product.periodValue} ${product.periodUnit}${product.periodValue === 1 ? '' : 's'}`;
        const trial = product.eligibleForIntro && product.freeTrial;
        const trialText = trial ? `${trial.value} ${trial.unit}${trial.value === 1 ? '' : 's'} free, then ` : '';
        const button = h('button', { class: 'b primary', type: 'button',
          onclick: () => run(() => api.subscriptionPurchase(product.id)) },
          `${trial ? 'Start free trial' : 'Subscribe'} — ${product.displayPrice} / ${period}`);
        plans.append(h('div', { style: 'border:1px solid #bbb;border-radius:6px;padding:12px;margin:12px 0' },
          h('strong', {}, product.name), h('div', {}, `${trialText}${product.displayPrice} every ${period}.`), button));
      }
      if (!data.products.length) plans.textContent = 'Subscription plans are unavailable. Try again later or restore an existing purchase.';
      for (const [label, url] of [['Privacy Policy', data.privacyURL], ['Terms of Use', data.termsURL]]) {
        if (url && new URL(url).protocol === 'https:') links.append(h('a', { href: url, target: '_blank', rel: 'noopener' }, label));
      }
    } catch { plans.textContent = 'Unable to load subscription plans. Please check your App Store connection.'; }
  }
  try {
    await dialog({ title: 'MacCAD Pro Subscription', body, width: 520,
      buttons: [{ label: 'Restore Purchases', value: 'restore' }, { label: 'Manage Subscription', value: 'manage' }, { label: 'Close', value: null }],
      onOpen: (element) => { box = element; void load(); },
      onButton: async (action) => {
        if (action === 'restore') { await run(() => api.subscriptionRestore()); return false; }
        if (action === 'manage') {
          try { await api.subscriptionManage(); } catch { message.textContent = 'Open your App Store account to manage subscriptions.'; }
          return false;
        }
        return true;
      },
    });
  } finally { closed = true; unsubscribe(); }
}
