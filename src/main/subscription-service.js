'use strict';
const { accessFromSnapshot } = require('./subscription-policy');

class SubscriptionService {
  constructor({ bridge, config, clock = Date.now, monotonic = () => performance.now(), changed = () => {} }) {
    this.bridge = bridge;
    this.config = config;
    this.clock = clock;
    this.monotonic = monotonic;
    this.changed = changed;
    this.anchor = { time: clock(), mono: monotonic() };
    this.current = { provider: 'app-store', state: 'checking', restricted: true };
    this.catalog = [];
    this.checkedAt = -Infinity;
    this.pending = null;
    this.busy = false;
  }
  now() { return Math.max(this.clock(), this.anchor.time + this.monotonic() - this.anchor.mono); }
  async invoke(operation, extra = {}) {
    const data = await this.bridge({ operation, productIds: Object.values(this.config.products), ...extra });
    if (!data || !Array.isArray(data.entitlements) || !Array.isArray(data.products)) throw new Error('Invalid StoreKit response');
    const now = this.now();
    this.catalog = data.products.filter((p) => Object.values(this.config.products).includes(p.id));
    this.current = accessFromSnapshot(data, this.config.products, now);
    this.checkedAt = this.monotonic();
    this.changed(this.current);
    return { outcome: data.outcome, status: this.current };
  }
  async status(force = false) {
    if (!force && this.monotonic() - this.checkedAt < 30000 &&
        (this.current.restricted || this.current.entitlementUntil > this.now())) return this.current;
    if (!this.pending) {
      this.pending = this.invoke('status').catch(() => {
        // Only a bounded, previously verified in-memory entitlement may survive a network error.
        const valid = !this.current.restricted && this.current.entitlementUntil > this.now() &&
          this.monotonic() - this.checkedAt < 3600000;
        this.current = valid ? { ...this.current, offline: true } :
          { provider: 'app-store', state: 'unavailable', restricted: true, now: this.now() };
        this.changed(this.current);
      }).finally(() => { this.pending = null; });
    }
    await this.pending;
    return this.current;
  }
  async products() {
    await this.status(true);
    return { products: this.catalog, privacyURL: this.config.privacyURL, termsURL: this.config.termsURL };
  }
  async purchase(productId) {
    if (!Object.values(this.config.products).includes(productId)) throw new Error('Unknown subscription product');
    return this.mutate('purchase', { productId });
  }
  async restore() { return this.mutate('restore'); }
  async mutate(operation, args = {}) {
    if (this.busy) return { outcome: 'busy', status: this.current };
    this.busy = true;
    try {
      // Do not allow an earlier status response to overwrite the completed purchase/restore.
      if (this.pending) await this.pending;
      const job = this.invoke(operation, args);
      this.pending = job;
      try { return await job; } finally { this.pending = null; }
    } finally { this.busy = false; }
  }
  async outputBlocked() { return (await this.status()).restricted; }
}
module.exports = { SubscriptionService };
