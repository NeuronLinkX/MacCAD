/** Startup windows, local recent documents, and installed sample drawings. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const MAX_RECENT = 24;
const THUMB_LIMIT = 400 * 1024;
const SAMPLE_EXT = /\.(mcad|dwg|dxf|step|stp|stl)$/i;
const idFor = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 16);

class StartSupport {
  static recentFile() { return path.join(app.getPath('userData'), 'recent.json'); }
  static thumbDir() { return path.join(app.getPath('userData'), 'thumbs'); }
  static readRecent() {
    try {
      if (fs.statSync(this.recentFile()).size > 1024 * 1024) return [];
      const list = JSON.parse(fs.readFileSync(this.recentFile(), 'utf8'));
      if (!Array.isArray(list)) return [];
      return list.filter((e) => e && typeof e.path === 'string' && path.isAbsolute(e.path)
        && e.id === idFor(e.path) && Number.isFinite(e.opened)).slice(0, MAX_RECENT)
        .map((e) => ({ ...e, name: path.basename(e.path) }));
    } catch { return []; }
  }
  static writeRecent(list) {
    fs.mkdirSync(path.dirname(this.recentFile()), { recursive: true });
    const tmp = this.recentFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(tmp, this.recentFile());
  }
  static recentList() {
    return this.readRecent().flatMap((e) => {
      try {
        if (!fs.statSync(e.path).isFile()) return [];
        let thumb = '';
        try {
          const f = path.join(this.thumbDir(), `${e.id}.png`);
          if (fs.statSync(f).size <= THUMB_LIMIT) thumb = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
        } catch { /* previews are optional */ }
        return [{ path: e.path, name: e.name, opened: e.opened, size: e.size, thumb }];
      } catch { return []; }
    });
  }
  static recentAdd(entry) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return false;
    try {
      const stat = fs.statSync(entry.path);
      if (!stat.isFile() || !SAMPLE_EXT.test(entry.path)) return false;
      const id = idFor(entry.path);
      const list = this.readRecent().filter((e) => e.id !== id);
      list.unshift({ id, path: entry.path, name: path.basename(entry.path), opened: Date.now(), size: stat.size });
      const kept = list.slice(0, MAX_RECENT);
      this.writeRecent(kept);
      for (const e of list.slice(MAX_RECENT)) fs.rmSync(path.join(this.thumbDir(), `${e.id}.png`), { force: true });
      if (entry.thumb) this.recentThumbnail(entry);
      app.addRecentDocument(entry.path);
      return true;
    } catch { return false; }
  }
  // Updating a preview must not change the document's last-opened order.
  static recentThumbnail(entry) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.thumb !== 'string'
      || entry.thumb.length > THUMB_LIMIT * 1.4 || !this.readRecent().some((e) => e.path === entry.path)) return false;
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(entry.thumb);
    if (!m) return false;
    const data = Buffer.from(m[1], 'base64');
    if (data.length > THUMB_LIMIT || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    try {
      fs.mkdirSync(this.thumbDir(), { recursive: true });
      fs.writeFileSync(path.join(this.thumbDir(), `${idFor(entry.path)}.png`), data, { mode: 0o600 });
      return true;
    } catch { return false; }
  }
  static recentRemove(p) {
    if (typeof p !== 'string') return false;
    try {
      this.writeRecent(this.readRecent().filter((e) => e.path !== p));
      fs.rmSync(path.join(this.thumbDir(), `${idFor(p)}.png`), { force: true });
      return true;
    } catch { return false; }
  }
  static samplesDir() {
    return app.isPackaged ? path.join(process.resourcesPath, 'samples') : path.join(__dirname, '..', '..', 'sample');
  }
  static isSample(p) {
    const relative = path.relative(this.samplesDir(), path.resolve(p));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }
  static samplesList() {
    try {
      const dir = this.samplesDir();
      return fs.readdirSync(dir).filter((n) => SAMPLE_EXT.test(n)).flatMap((name) => {
        const file = path.join(dir, name), stat = fs.statSync(file);
        return stat.isFile() ? [{ path: file, name, size: stat.size }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }
  static showSplash() {
    const splash = new BrowserWindow({
      width: 760, height: 475, frame: false, resizable: false, movable: true,
      center: true, show: false, skipTaskbar: true, backgroundColor: '#0c1220',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
    });
    splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash', 'splash.html'));
    splash.once('ready-to-show', () => { if (!splash.isDestroyed()) splash.show(); });
    return splash;
  }
}
module.exports = StartSupport;
