'use strict';

// Input comes exclusively from the native StoreKit verifier, never from renderer IPC.
function accessFromSnapshot(snapshot, productIds, now = Date.now()) {
  const allowed = new Set(Object.values(productIds));
  const rows = (snapshot.entitlements || []).filter((t) => t.verified === true &&
    allowed.has(t.productId) && !t.revoked && !t.upgraded &&
    !['revoked', 'expired', 'billingRetry'].includes(t.renewalState));
  const usable = rows.map((t) => ({ ...t, until: t.renewalState === 'grace' ? t.graceExpires : t.expires }))
    .filter((t) => Number.isFinite(t.until) && t.until > now).sort((a, b) => b.until - a.until);
  const t = usable[0];
  const base = { provider: 'app-store', restricted: !t, now,
    state: snapshot.unverified ? 'unavailable' : 'unsubscribed' };
  if (!t) return base;
  const product = (snapshot.products || []).find((p) => p.id === t.productId);
  const trial = t.introductory && !!product?.freeTrial;
  return { ...base, state: t.renewalState === 'grace' ? 'grace' : trial ? 'trial' : 'licensed',
    plan: 'pro', productId: t.productId, expires: t.expires, entitlementUntil: t.until,
    trialEnd: trial ? t.expires : undefined, autoRenew: t.willAutoRenew };
}

module.exports = { accessFromSnapshot };
