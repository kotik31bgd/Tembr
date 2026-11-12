// Музыкальная библиотека: сканирование папок, чтение тегов, слежение за изменениями, хранение данных.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.webm', '.aiff', '.aif']);

let mmPromise = null;
const mm = () => (mmPromise ||= import('music-metadata'));

const isAudio = (p) => AUDIO_EXT.has(path.extname(p).toLowerCase());
const normPath = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const trackId = (p) => crypto.createHash('sha1').update(normPath(path.resolve(p))).digest('hex').slice(0, 16);

const DEFAULT_DATA = {
  version: 1,
  folders: [],
  looseFiles: [],
  tracks: {},
  playlists: [],
  stats: {},
  radioFavs: [],
  coverLookup: {},
  lyricsCache: {},
  settings: {
    theme: 'dark',
    accent: '#7c5cff',
    autoCovers: true,
    closeToTray: false,
    volume: 0.8,
    eq: { enabled: false, preamp: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: 'flat' },
    shuffle: false,
    repeat: 'off',
    lastTrack: null,
  },
};

class Library extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    this.coversDir = path.join(dataDir, 'covers');
    fs.mkdirSync(this.coversDir, { recursive: true });
    this.data = this._load();
    this.watcher = null;
    this.saveTimer = null;
    this.changeTimer = null;
    this.scanning = 0;
    this.progress = { done: 0, total: 0 };
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = { ...structuredClone(DEFAULT_DATA), ...raw };
      d.settings = { ...DEFAULT_DATA.settings, ...(raw.settings || {}) };
      d.settings.eq = { ...DEFAULT_DATA.settings.eq, ...((raw.settings || {}).eq || {}) };
      return d;
    } catch {
      return structuredClone(DEFAULT_DATA);
    }
  }

  save(immediate = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      const tmp = this.file + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('save failed', e);
      }
    };
    if (immediate) write();
    else this.saveTimer = setTimeout(write, 800);
  }

  _changed() {
    this.save();
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('tracks'), 400);
  }

  // Разрешён ли доступ к файлу через протокол tmedia (только файлы библиотеки и кэш обложек)
  isAllowed(p) {
    const n = normPath(path.resolve(p));
    if (n.startsWith(normPath(this.coversDir))) return true;
    if (this.data.tracks[trackId(p)]) return true;
    return this.data.folders.some((f) => n.startsWith(normPath(path.resolve(f)) + path.sep));
  }

  tracksList() {
    return Object.values(this.data.tracks);
  }

  // ---------- Папки ----------
  async addFolder(folder) {
    folder = path.resolve(folder);
    if (this.data.folders.some((f) => normPath(f) === normPath(folder))) return false;
    this.data.folders.push(folder);
    this.save();
    this.restartWatcher();
    await this.scanFolder(folder);
    return true;
  }

  removeFolder(folder) {
    const nf = normPath(path.resolve(folder));
    this.data.folders = this.data.folders.filter((f) => normPath(f) !== nf);
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (normPath(t.path).startsWith(nf + path.sep) && !this._isLoose(t.path)) delete this.data.tracks[id];
    }
    this.restartWatcher();
    this._changed();
  }

  _isLoose(p) {
    const n = normPath(p);
    return this.data.looseFiles.some((f) => normPath(f) === n);
  }

  async addPaths(paths) {
    const added = [];
    for (const p of paths) {
      let st;
      try { st = await fs.promises.stat(p); } catch { continue; }
      if (st.isDirectory()) {
        await this.addFolder(p);
      } else if (isAudio(p)) {
        if (!this._isLoose(p)) this.data.looseFiles.push(path.resolve(p));
        const t = await this.addFile(p);
        if (t) added.push(t.id);
      }
    }
    this._changed();
    return added;
  }

  async rescanAll() {
    // Удаляем записи о файлах, которых больше нет
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (!fs.existsSync(t.path)) delete this.data.tracks[id];
    }
    this.data.looseFiles = this.data.looseFiles.filter((f) => fs.existsSync(f));
    for (const f of this.data.folders) await this.scanFolder(f);
    for (const f of this.data.looseFiles) await this.addFile(f);
    this._changed();
  }

  async _walk(dir, out) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await this._walk(p, out);
      else if (e.isFile() && isAudio(p)) out.push(p);
    }
  }

  async scanFolder(folder) {
    if (!fs.existsSync(folder)) return;
    this.scanning++;
    const files = [];
    await this._walk(folder, files);
    this.progress.total += files.length;
    this._emitProgress();
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const f = files[i++];
        await this.addFile(f, true);
        this.progress.done++;
        if (this.progress.done % 25 === 0) { this._emitProgress(); this._changed(); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    this.scanning--;
    if (!this.scanning) this.progress = { done: 0, total: 0 };
    this._emitProgress();
    this._changed();
    this.emit('scanned');
  }

  _emitProgress() {
    this.emit('progress', { scanning: this.scanning > 0, ...this.progress });
  }

  async addFile(p, skipIfUnchanged = true) {
    let st;
    try { st = await fs.promises.stat(p); } catch { return null; }
    const id = trackId(p);
    const existing = this.data.tracks[id];
    if (skipIfUnchanged && existing && existing.mtime === st.mtimeMs) return existing;
    const t = await this._readTags(p, st, existing);
    if (t) {
      this.data.tracks[id] = t;
      if (!existing) this._changed();
    }
    return t;
  }

  async _readTags(p, st, existing) {
    const base = path.basename(p, path.extname(p));
    let title = base, artist = '', album = '', albumArtist = '', year = null, genre = '', trackNo = null, disc = null, duration = 0, cover = null, lyrics = '', bitrate = 0, sampleRate = 0, codec = '';
    try {
      const { parseFile } = await mm();
      const meta = await parseFile(p, { duration: false, skipCovers: false });
      const c = meta.common;
      if (c.title) title = c.title;
      artist = c.artist || (c.artists && c.artists.join(', ')) || '';
      album = c.album || '';
      albumArtist = c.albumartist || '';
      year = c.year || null;
      genre = (c.genre && c.genre[0]) || '';
      trackNo = c.track && c.track.no;
      disc = c.disk && c.disk.no;
      duration = meta.format.duration || 0;
      bitrate = Math.round((meta.format.bitrate || 0) / 1000);
      sampleRate = meta.format.sampleRate || 0;
      codec = meta.format.codec || meta.format.container || '';
      if (c.lyrics && c.lyrics.length) {
        const l = c.lyrics[0];
        lyrics = typeof l === 'string' ? l : (l.text || (l.syncText || []).map((s) => s.text).join('\n'));
      }
      const pic = c.picture && (c.picture.find((x) => /front/i.test(x.type || '')) || c.picture[0]);
      if (pic && pic.data) cover = this._saveCover(Buffer.from(pic.data), pic.format);
    } catch (e) {
      // Теги прочитать не удалось — используем имя файла
    }
    // Если тегов нет, пробуем «Исполнитель - Название» из имени файла
    if (!artist && title === base) {
      const m = base.replace(/^\d{1,3}[\s.\-_]+/, '').split(/\s+[-–—]\s+/);
      if (m.length >= 2) { artist = m[0].trim(); title = m.slice(1).join(' - ').trim(); }
      else title = base.replace(/^\d{1,3}[\s.\-_]+/, '');
    }
    // Если обложка не встроена — ищем cover.jpg / folder.jpg рядом
    if (!cover) cover = this._folderCover(path.dirname(p));
    if (!cover && existing && existing.cover && existing.coverSource === 'online') cover = existing.cover;
    return {
      id: trackId(p),
      path: path.resolve(p),
      title, artist, album, albumArtist, year, genre, trackNo, disc, duration,
      bitrate, sampleRate, codec, lyrics,
      cover,
      coverSource: cover ? (existing && existing.coverSource === 'online' && cover === existing.cover ? 'online' : 'local') : null,
      size: st.size,
      mtime: st.mtimeMs,
      addedAt: existing ? existing.addedAt : Date.now(),
    };
  }

  _folderCover(dir) {
    this._dirCoverCache ||= new Map();
    if (this._dirCoverCache.has(dir)) return this._dirCoverCache.get(dir);
    let found = null;
    try {
      const names = fs.readdirSync(dir);
      const pick = names.find((n) => /^(cover|folder|front|album|albumart)\.(jpe?g|png|webp)$/i.test(n)) ||
        names.find((n) => /^albumart.*\.(jpe?g|png)$/i.test(n));
      if (pick) found = this._saveCover(fs.readFileSync(path.join(dir, pick)), path.extname(pick));
    } catch {}
    this._dirCoverCache.set(dir, found);
    return found;
  }

  _saveCover(buf, format = 'image/jpeg') {
    const ext = /png/i.test(format) ? '.png' : /webp/i.test(format) ? '.webp' : '.jpg';
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
    const file = path.join(this.coversDir, hash + ext);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    return file;
  }

  setOnlineCover(trackIds, buf, format) {
    const file = this._saveCover(buf, format);
    for (const id of trackIds) {
      const t = this.data.tracks[id];
      if (t && !t.cover) { t.cover = file; t.coverSource = 'online'; }
    }
    this._changed();
    return file;
  }

  removeFile(p) {
    const id = trackId(p);
    if (this.data.tracks[id]) {
      delete this.data.tracks[id];
      this._changed();
    }
  }

  removeDir(dir) {
    const nd = normPath(path.resolve(dir)) + path.sep;
    let changed = false;
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (normPath(t.path).startsWith(nd)) { delete this.data.tracks[id]; changed = true; }
    }
    if (changed) this._changed();
  }

  // ---------- Слежение за папками ----------
  restartWatcher() {
    if (this.watcher) { this.watcher.close().catch(() => {}); this.watcher = null; }
    const folders = this.data.folders.filter((f) => fs.existsSync(f));
    if (!folders.length) return;
    this.watcher = chokidar.watch(folders, {
      ignoreInitial: true,
      ignored: (p) => /(^|[\\/])\.|\$RECYCLE\.BIN/.test(p),
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
      ignorePermissionErrors: true,
    });
    this.watcher
      .on('add', (p) => isAudio(p) && this.addFile(p, false).then(() => { this._dirCoverCache?.delete(path.dirname(p)); this._changed(); this.emit('scanned'); }))
      .on('change', (p) => isAudio(p) && this.addFile(p, false).then(() => this._changed()))
      .on('unlink', (p) => isAudio(p) && this.removeFile(p))
      .on('unlinkDir', (p) => this.removeDir(p))
      .on('error', (e) => console.error('watch error', e));
  }

  close() {
    if (this.watcher) this.watcher.close().catch(() => {});
    this.save(true);
  }
}

module.exports = { Library, isAudio, trackId };
