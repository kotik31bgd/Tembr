'use strict';
/* global icon, hydrateIcons */

// =====================================================================
//  Утилиты
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (p) => 'tmedia://file/' + encodeURIComponent(p).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const bg = (p) => (p ? (/^https?:/.test(p) ? `background-image:url('${String(p).replace(/'/g, '%27')}')` : `background-image:url('${fileUrl(p)}')`) : '');
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a || '', b || '');
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtTotal(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  const w = n10 === 1 && n100 !== 11 ? one : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20) ? few : many;
  return `${n.toLocaleString('ru')} ${w}`;
}
const tracksWord = (n) => plural(n, 'трек', 'трека', 'треков');
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const UNKNOWN_ARTIST = 'Неизвестный исполнитель';
const artistOf = (t) => t.artist || UNKNOWN_ARTIST;
const primaryArtist = (t) => (t.artist ? t.artist.split(/\s+(?:feat\.?|ft\.?|featuring|при уч\.)\s+|\s*[,;&]\s*|\s+x\s+/i)[0].trim() || t.artist : UNKNOWN_ARTIST);
const albumArtistOf = (t) => t.albumArtist || primaryArtist(t);
// Несколько исполнителей в одной строке: «VILLIAN, madk1d», «A & B», «A feat. B», «A x B»
const ARTIST_SEP = /(\s*(?:,|;|&|\s(?:feat\.?|ft\.?|featuring|при уч\.)\s|\sx\s)\s*)/i;
function splitArtists(str) {
  if (!str) return [];
  const parts = String(str).split(ARTIST_SEP).filter((x, i) => i % 2 === 0).map((x) => x.trim()).filter(Boolean);
  const seen = new Set();
  return parts.filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}
// Строка исполнителей, где каждый — отдельная ссылка (разделители сохраняются как в тегах)
function artistLinks(str) {
  if (!str) return esc(UNKNOWN_ARTIST);
  return String(str).split(ARTIST_SEP).map((part, i) => {
    if (i % 2 === 1) return esc(part);
    const name = part.trim();
    return name ? `<span class="link" data-artist="${esc(name.toLowerCase())}">${esc(name)}</span>` : '';
  }).join('');
}
const trackArtistNames = (t) => { const n = splitArtists(t.artist); return n.length ? n : [UNKNOWN_ARTIST]; };
const albumKey = (t) => (t.album ? `${albumArtistOf(t).toLowerCase()}|${t.album.toLowerCase()}` : null);

// =====================================================================
//  Состояние
// =====================================================================
const S = {
  tracks: new Map(),
  folders: [],
  playlists: [],
  stats: {},
  radioFavs: [],
  online: new Map(), // треки из Internet Archive: id 'ia:<запись>/<файл>'
  archive: { cat: 'free', sort: 'downloads', query: '', page: 1, items: null, total: 0, loading: false },
  iaItems: new Map(),
  artistImages: {},
  settings: {},
  dataDir: '',
  version: '',
  view: { name: 'home' },
  history: [],
  search: '',
  sort: null,
  selected: new Set(),
  lastSel: -1,
  progress: { scanning: false },
  update: { state: 'idle' },
  radio: { tag: '', country: '', query: '', results: null, loading: false },
  stations: new Map(),
  panel: null, // 'lyrics' | 'queue' | null
  idx: null, // кэш альбомов/исполнителей
};

function index() {
  if (S.idx) return S.idx;
  const albums = new Map();
  const artists = new Map();
  for (const t of S.tracks.values()) {
    const k = albumKey(t);
    if (k) {
      if (!albums.has(k)) albums.set(k, { key: k, name: t.album, artist: albumArtistOf(t), year: t.year, cover: null, ids: [] });
      const a = albums.get(k);
      a.ids.push(t.id);
      if (!a.cover && t.cover) a.cover = t.cover;
      if (!a.year && t.year) a.year = t.year;
    }
    const names = new Map();
    for (const n of [...trackArtistNames(t), ...splitArtists(t.albumArtist)]) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n);
    for (const [nk, name] of names) {
      if (!artists.has(nk)) artists.set(nk, { key: nk, name, cover: null, ids: [] });
      const ar = artists.get(nk);
      ar.ids.push(t.id);
      if (!ar.cover && t.cover) ar.cover = t.cover;
    }
  }
  for (const ar of artists.values()) {
    const img = S.artistImages[ar.key];
    ar.photo = img ? img.file : null;
    if (ar.photo) ar.cover = ar.photo;
  }
  S.idx = { albums, artists };
  return S.idx;
}

const stat = (id) => (S.stats[id] ||= { plays: 0, last: 0, liked: false });
const isLiked = (id) => !!(S.stats[id] && S.stats[id].liked);
const saveStats = debounce(() => window.api.store('stats', S.stats), 1000);
const savePlaylists = () => window.api.store('playlists', S.playlists);
const saveRadioFavs = () => window.api.store('radioFavs', S.radioFavs);
function setSetting(patch) {
  Object.assign(S.settings, patch);
  window.api.setSettings(patch);
}

function toggleLike(id, force) {
  const s = stat(id);
  s.liked = force ?? !s.liked;
  s.likedAt = s.liked ? Date.now() : 0;
  saveStats();
  updateNowPlaying();
  if (S.view.name === 'liked') render(true);
  else currentList?.refresh();
  renderNav();
}

// =====================================================================
//  Плеер
// =====================================================================
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: { name: 'Без изменений', bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { name: 'Больше баса', bands: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  bassTreble: { name: 'Бас + верха', bands: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  rock: { name: 'Рок', bands: [5, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  pop: { name: 'Поп', bands: [-1, 1, 3, 4, 3, 1, 0, -1, -1, -1] },
  dance: { name: 'Танцевальная', bands: [6, 5, 2, 0, 0, -2, -1, 0, 3, 4] },
  hiphop: { name: 'Хип-хоп', bands: [5, 5, 2, 3, -1, -1, 1, -1, 2, 3] },
  jazz: { name: 'Джаз', bands: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { name: 'Классика', bands: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  vocal: { name: 'Вокал', bands: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1] },
  acoustic: { name: 'Акустика', bands: [4, 3, 2, 1, 1, 1, 2, 3, 2, 2] },
  soft: { name: 'Мягкий звук', bands: [1, 1, 0, 0, 0, 0, -1, -2, -3, -4] },
  loud: { name: 'Громкость+', bands: [4, 3, 0, 0, 0, 0, 0, 0, 3, 4] },
  headphones: { name: 'Наушники', bands: [3, 4, 2, -1, -1, 0, 1, 3, 5, 5] },
};

const audio = new Audio();
audio.crossOrigin = 'anonymous';
audio.preload = 'auto';

const Player = {
  ctx: null,
  analyser: null,
  filters: [],
  preamp: null,
  base: [], // очередь в исходном порядке: [{uid, id}]
  queue: [], // фактический порядок воспроизведения
  index: -1,
  counted: false,
  current: null, // { kind: 'track'|'radio', id, track?, station? }
  lastStateSent: 0,

  initGraph() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      const src = this.ctx.createMediaElementSource(audio);
      this.preamp = this.ctx.createGain();
      let node = src.connect(this.preamp);
      this.filters = EQ_FREQS.map((f, i) => {
        const b = this.ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        node = node.connect(b);
        return b;
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      node.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.applyEq();
    } catch (e) {
      console.error('Web Audio init failed', e);
    }
  },

  applyEq() {
    if (!this.ctx) return;
    const eq = S.settings.eq;
    const on = eq.enabled;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? eq.bands[i] || 0 : 0, this.ctx.currentTime, 0.02));
    this.preamp.gain.setTargetAtTime(on ? Math.pow(10, (eq.preamp || 0) / 20) : 1, this.ctx.currentTime, 0.02);
  },

  entry(id) { return { uid: uid(), id }; },

  playList(ids, start = 0, opts = {}) {
    ids = ids.filter((id) => S.tracks.has(id) || id.startsWith('r:') || S.online.has(id));
    if (!ids.length) return;
    if (opts.shuffle !== undefined && opts.shuffle !== S.settings.shuffle) setSetting({ shuffle: opts.shuffle });
    this.base = ids.map((id) => this.entry(id));
    if (opts.shuffle && opts.randomStart) start = Math.floor(Math.random() * ids.length);
    start = clamp(start, 0, ids.length - 1);
    if (S.settings.shuffle) {
      const first = this.base[start];
      this.queue = [first, ...shuffleArr(this.base.filter((e) => e !== first))];
      this.index = 0;
    } else {
      this.queue = this.base.slice();
      this.index = start;
    }
    this.load(true);
    renderQueuePanel();
  },

  playStation(st) {
    const id = 'r:' + st.id;
    S.stations.set(id, st);
    this.base = [this.entry(id)];
    this.queue = this.base.slice();
    this.index = 0;
    this.load(true);
    window.api.radioClick(st.id);
  },

  playNext(ids) {
    const entries = ids.map((id) => this.entry(id));
    if (this.index < 0) return this.playList(ids, 0);
    this.queue.splice(this.index + 1, 0, ...entries);
    const cur = this.queue[this.index];
    const bi = this.base.indexOf(cur);
    this.base.splice(bi + 1, 0, ...entries);
    renderQueuePanel();
    this.persist();
    toast(ids.length > 1 ? `${tracksWord(ids.length)} будут следующими` : 'Будет следующим');
  },

  addToQueue(ids) {
    const entries = ids.map((id) => this.entry(id));
    if (this.index < 0) return this.playList(ids, 0);
    this.queue.push(...entries);
    this.base.push(...entries);
    renderQueuePanel();
    this.persist();
    toast(`Добавлено в очередь: ${tracksWord(ids.length)}`);
  },

  removeAt(qi) {
    if (qi === this.index) return;
    const [e] = this.queue.splice(qi, 1);
    this.base = this.base.filter((x) => x !== e);
    if (qi < this.index) this.index--;
    renderQueuePanel();
    this.persist();
  },

  moveInQueue(from, to) {
    if (from === to) return;
    const cur = this.queue[this.index];
    const [e] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, e);
    this.index = this.queue.indexOf(cur);
    if (!S.settings.shuffle) this.base = this.queue.slice();
    renderQueuePanel();
    this.persist();
  },

  clearUpcoming() {
    const cur = this.queue[this.index];
    this.queue = cur ? [cur] : [];
    this.base = this.queue.slice();
    this.index = cur ? 0 : -1;
    renderQueuePanel();
    this.persist();
  },

  jump(qi) {
    this.index = qi;
    this.load(true);
  },

  load(autoplay, startTime = 0) {
    const e = this.queue[this.index];
    if (!e) return;
    this.counted = false;
    if (e.id.startsWith('r:')) {
      const st = S.stations.get(e.id);
      if (!st) return;
      this.current = { kind: 'radio', id: e.id, station: st };
      audio.src = st.url;
    } else if (e.id.startsWith('ia:')) {
      const o = S.online.get(e.id);
      if (!o) return;
      this.current = { kind: 'online', id: e.id, track: o };
      audio.src = o.url;
    } else {
      const t = S.tracks.get(e.id);
      if (!t) { // файл исчез из библиотеки — пропускаем
        this.queue.splice(this.index, 1);
        this.base = this.base.filter((x) => x !== e);
        if (this.index >= this.queue.length) { this.stop(); return; }
        return this.load(autoplay);
      }
      this.current = { kind: 'track', id: t.id, track: t };
      audio.src = fileUrl(t.path);
      if (startTime) {
        const seekOnce = () => { audio.currentTime = startTime; };
        audio.addEventListener('loadedmetadata', seekOnce, { once: true });
      }
    }
    if (autoplay) this.play();
    updateNowPlaying();
    currentList?.refresh();
    renderQueuePanel();
    renderSimilar();
    Lyrics.onTrack();
    this.persist();
    this.sendState(true);
  },

  async play() {
    if (!this.current) {
      if (this.queue.length) { this.index = Math.max(0, this.index); this.load(true); }
      else {
        const ids = sortedTracks(Array.from(S.tracks.keys()), 'default');
        if (ids.length) this.playList(ids, 0);
      }
      return;
    }
    this.initGraph();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    try { await audio.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
  },

  pause() { audio.pause(); },
  toggle() { audio.paused ? this.play() : this.pause(); },

  stop() {
    audio.pause();
    audio.currentTime = 0;
    this.sendState(true);
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && S.settings.repeat === 'one' && this.current?.kind === 'track') {
      audio.currentTime = 0;
      this.counted = false;
      return this.play();
    }
    if (this.index + 1 < this.queue.length) {
      this.index++;
    } else if (S.settings.repeat === 'all' || !auto) {
      if (S.settings.repeat !== 'all' && !auto) { // в конце очереди без повтора — ничего не делаем
        if (this.queue.length === 1) { audio.currentTime = 0; return; }
      }
      if (S.settings.shuffle) this.queue = shuffleArr(this.base.slice());
      this.index = 0;
    } else {
      audio.pause();
      audio.currentTime = 0;
      return;
    }
    this.load(true);
  },

  prev() {
    if (audio.currentTime > 3 || this.current?.kind === 'radio') { audio.currentTime = 0; return; }
    if (this.index > 0) this.index--;
    else if (S.settings.repeat === 'all') this.index = this.queue.length - 1;
    else { audio.currentTime = 0; return; }
    this.load(true);
  },

  seek(t) { if (isFinite(audio.duration)) audio.currentTime = clamp(t, 0, audio.duration); },

  setShuffle(on) {
    setSetting({ shuffle: on });
    const cur = this.queue[this.index];
    if (on) {
      this.queue = cur ? [cur, ...shuffleArr(this.base.filter((e) => e !== cur))] : shuffleArr(this.base.slice());
      this.index = cur ? 0 : -1;
    } else {
      this.queue = this.base.slice();
      this.index = cur ? this.queue.indexOf(cur) : -1;
    }
    updateControls();
    renderQueuePanel();
    this.persist();
  },

  cycleRepeat() {
    const order = ['off', 'all', 'one'];
    const r = order[(order.indexOf(S.settings.repeat) + 1) % 3];
    setSetting({ repeat: r });
    updateControls();
    toast(r === 'off' ? 'Повтор выключен' : r === 'all' ? 'Повтор очереди' : 'Повтор трека');
  },

  setVolume(v) {
    v = clamp(v, 0, 1);
    audio.volume = v;
    audio.muted = false;
    setSettingDebounced({ volume: v });
    updateVolume();
  },

  persist: debounce(function () {
    const q = Player.queue.filter((e) => !e.id.startsWith('r:') && !e.id.startsWith('ia:'));
    const cur = Player.queue[Player.index];
    if (!cur || cur.id.startsWith('r:') || cur.id.startsWith('ia:')) return;
    const start = Math.max(0, q.indexOf(cur) - 200);
    const slice = q.slice(start, start + 1000);
    setSetting({
      lastTrack: {
        ids: slice.map((e) => e.id),
        index: slice.indexOf(cur),
        base: S.settings.shuffle ? Player.base.filter((e) => !e.id.startsWith('r:') && !e.id.startsWith('ia:')).slice(0, 1000).map((e) => e.id) : null,
        time: Math.floor(audio.currentTime || 0),
      },
    });
  }, 1500),

  restore() {
    const lt = S.settings.lastTrack;
    if (!lt || !lt.ids || !lt.ids.length) return;
    const ids = lt.ids.filter((id) => S.tracks.has(id));
    const curId = lt.ids[lt.index];
    if (!ids.length || !S.tracks.has(curId)) return;
    this.queue = ids.map((id) => this.entry(id));
    this.index = ids.indexOf(curId);
    if (lt.base) {
      const byId = new Map(this.queue.map((e) => [e.id, e]));
      this.base = lt.base.filter((id) => S.tracks.has(id)).map((id) => byId.get(id) || this.entry(id));
    } else this.base = this.queue.slice();
    this.load(false, lt.time || 0);
  },

  sendState(force) {
    const now = Date.now();
    if (!force && now - this.lastStateSent < 900) return;
    this.lastStateSent = now;
    const c = this.current;
    window.api.sendState({
      playing: !audio.paused,
      position: audio.currentTime || 0,
      duration: isFinite(audio.duration) ? audio.duration : 0,
      live: c?.kind === 'radio',
      liked: c?.kind === 'track' ? isLiked(c.id) : false,
      shuffle: S.settings.shuffle,
      repeat: S.settings.repeat,
      track: c ? (c.kind === 'track'
        ? { id: c.id, title: c.track.title, artist: artistOf(c.track), cover: c.track.cover ? fileUrl(c.track.cover) : null }
        : c.kind === 'online' ? { id: c.id, title: c.track.title, artist: c.track.artist, cover: c.track.cover }
        : { id: c.id, title: c.station.name, artist: 'Интернет-радио', cover: c.station.favicon || null }) : null,
    });
  },
};
const setSettingDebounced = debounce((p) => setSetting(p), 400);

audio.addEventListener('play', () => { updateControls(); Player.sendState(true); });
audio.addEventListener('pause', () => { updateControls(); Player.sendState(true); Player.persist(); });
audio.addEventListener('ended', () => Player.next(true));
audio.addEventListener('timeupdate', () => {
  updateProgress();
  Lyrics.tick();
  Player.sendState(false);
  const c = Player.current;
  if (c && c.kind === 'track' && !Player.counted && audio.currentTime > Math.min(30, (audio.duration || 60) * 0.5)) {
    Player.counted = true;
    const s = stat(c.id);
    s.plays = (s.plays || 0) + 1;
    s.last = Date.now();
    saveStats();
  }
  if (Math.floor(audio.currentTime) % 10 === 0) Player.persist();
});
audio.addEventListener('durationchange', updateProgress);
audio.addEventListener('waiting', () => $('#btn-play').classList.add('loading'));
audio.addEventListener('playing', () => $('#btn-play').classList.remove('loading'));
let errorSkips = 0;
audio.addEventListener('error', () => {
  const c = Player.current;
  if (!c || !audio.src) return;
  if (c.kind === 'radio') {
    toast('Станция не отвечает. Попробуйте другую.');
    return;
  }
  toast(`Не удалось воспроизвести «${c.track.title}»`);
  if (++errorSkips < 5) setTimeout(() => Player.next(true), 800);
});
audio.addEventListener('playing', () => { errorSkips = 0; });

// Системные медиаклавиши и панель Windows (SMTC)
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const c = Player.current;
  if (!c) return;
  const meta = c.kind === 'track' || c.kind === 'online'
    ? { title: c.track.title, artist: artistOf(c.track), album: c.track.album || '' }
    : { title: c.station.name, artist: 'Интернет-радио', album: '' };
  try { navigator.mediaSession.metadata = new MediaMetadata(meta); } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => Player.play());
  ms.setActionHandler('pause', () => Player.pause());
  ms.setActionHandler('previoustrack', () => Player.prev());
  ms.setActionHandler('nexttrack', () => Player.next());
  try { ms.setActionHandler('seekto', (d) => Player.seek(d.seekTime)); } catch {}
}

// =====================================================================
//  Панель плеера
// =====================================================================
function setCoverEl(el, url, fallbackIcon, contain) {
  el.style.backgroundImage = url ? `url('${url}')` : '';
  el.style.backgroundSize = url && contain ? 'contain' : '';
  el.style.backgroundRepeat = 'no-repeat';
  el.innerHTML = url ? '' : icon(fallbackIcon);
}

function updateNowPlaying() {
  const c = Player.current;
  const like = $('#btn-like');
  const npLike = $('#np-like');
  let title = 'Ничего не играет', artistHtml = 'Выберите трек', coverUrl = null, contain = false, fb = 'music';
  if (c && c.kind === 'track') {
    const t = c.track;
    title = t.title;
    artistHtml = `${artistLinks(t.artist)}${t.album ? ` · <span class="link" data-album="${esc(albumKey(t))}">${esc(t.album)}</span>` : ''}`;
    coverUrl = t.cover ? fileUrl(t.cover) : null;
  } else if (c && c.kind === 'online') {
    const t = c.track;
    title = t.title;
    artistHtml = `${esc(t.artist)} · <span class="link" data-ia="${esc(t.iaId)}">${esc(t.album)}</span>`;
    coverUrl = t.cover;
  } else if (c) {
    const st = c.station;
    title = st.name;
    artistHtml = `<span class="live">LIVE</span> ${esc([st.country, st.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · '))}`;
    coverUrl = st.favicon ? st.favicon.replace(/'/g, '%27') : null;
    contain = true;
    fb = 'radio';
  }
  for (const id of ['#now-title', '#np-title']) { $(id).textContent = title; $(id).title = title; }
  $('#now-artist').innerHTML = artistHtml;
  $('#np-artist').innerHTML = artistHtml;
  setCoverEl($('#now-cover'), coverUrl, fb, contain);
  setCoverEl($('#np-cover'), coverUrl, fb, contain);
  const isTrack = c?.kind === 'track';
  const liked = isTrack && isLiked(c.id);
  for (const b of [like, npLike]) {
    b.classList.toggle('hidden', !isTrack);
    b.classList.toggle('on', !!liked);
    b.innerHTML = icon(liked ? 'heartFill' : 'heart');
  }
  setAmbient(c && !contain ? coverUrl : null);
  markIaPlaying();
  if (!c) return;
  updateMediaSession();
  updateControls();
  updateProgress();
}

// Фон окна — размытая обложка текущего трека (плавная смена)
let ambUrl = undefined, ambFlip = false;
function setAmbient(url) {
  if (url === ambUrl) return;
  ambUrl = url;
  const [show, hide] = ambFlip ? [$('#amb-a'), $('#amb-b')] : [$('#amb-b'), $('#amb-a')];
  ambFlip = !ambFlip;
  hide.classList.remove('show');
  if (!url) return;
  const img = new Image();
  img.onload = () => { if (ambUrl !== url) return; show.style.backgroundImage = `url('${url}')`; show.classList.add('show'); };
  img.src = url;
}

function updateControls() {
  const playing = !audio.paused;
  $('#btn-play').innerHTML = icon(playing ? 'pause' : 'play');
  $('#np-play').innerHTML = icon(playing ? 'pause' : 'play');
  document.body.classList.toggle('paused', !playing);
  const r = S.settings.repeat;
  for (const id of ['#btn-shuffle', '#np-shuffle']) $(id).classList.toggle('active', !!S.settings.shuffle);
  for (const id of ['#btn-repeat', '#np-repeat']) {
    $(id).classList.toggle('active', r !== 'off');
    $(id).innerHTML = icon(r === 'one' ? 'repeatOne' : 'repeat');
  }
  const live = Player.current?.kind === 'radio';
  $('#seek').classList.toggle('disabled', live || !Player.current);
  $('#np-seek').classList.toggle('disabled', live || !Player.current);
  $('#btn-lyrics').classList.toggle('active', S.panel === 'lyrics');
  $('#btn-queue').classList.toggle('active', S.panel === 'queue');
  $('#btn-panel').classList.toggle('active', !!S.panel);
  $('#btn-eq').classList.toggle('active', !!S.settings.eq.enabled);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

let seeking = false;
function updateProgress() {
  const live = Player.current?.kind === 'radio';
  const d = audio.duration;
  const cur = audio.currentTime || 0;
  const durText = live ? '∞' : fmtTime(isFinite(d) ? d : Player.current?.track?.duration || 0);
  $('#time-cur').textContent = fmtTime(cur);
  $('#time-dur').textContent = durText;
  $('#np-cur').textContent = fmtTime(cur);
  $('#np-dur').textContent = durText;
  if (!seeking) {
    const f = live ? 0 : isFinite(d) && d > 0 ? cur / d : 0;
    setSlider($('#seek'), f);
    setSlider($('#np-seek'), f);
  }
}


function setSlider(el, frac) {
  const p = clamp(frac, 0, 1) * 100 + '%';
  el.querySelector('.slider-fill').style.width = p;
  el.querySelector('.slider-thumb').style.left = p;
}

function bindSlider(el, onMove, onCommit) {
  const fracAt = (e) => {
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const f = fracAt(e);
    setSlider(el, f);
    onMove(f);
    const move = (ev) => { const ff = fracAt(ev); setSlider(el, ff); onMove(ff); };
    const up = (ev) => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      onCommit(fracAt(ev));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

function updateVolume() {
  const v = audio.muted ? 0 : audio.volume;
  setSlider($('#volume'), v);
  $('#btn-mute').innerHTML = icon(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume');
}

// =====================================================================
//  Список треков (виртуальный)
// =====================================================================
const ROW = 48;
let currentList = null;

function sortedTracks(ids, mode) {
  const arr = ids.map((id) => S.tracks.get(id)).filter(Boolean);
  const byAlbum = (a, b) => cmp(albumArtistOf(a), albumArtistOf(b)) || cmp(a.album, b.album) || (a.disc || 0) - (b.disc || 0) || (a.trackNo || 0) - (b.trackNo || 0) || cmp(a.title, b.title);
  if (mode === 'default') arr.sort(byAlbum);
  else if (mode === 'album') arr.sort((a, b) => (a.disc || 0) - (b.disc || 0) || (a.trackNo || 0) - (b.trackNo || 0) || cmp(a.title, b.title));
  else if (mode === 'added') arr.sort((a, b) => b.addedAt - a.addedAt);
  return arr.map((t) => t.id);
}

const SORTERS = {
  title: (a, b) => cmp(a.title, b.title),
  artist: (a, b) => cmp(artistOf(a), artistOf(b)) || cmp(a.album, b.album) || (a.trackNo || 0) - (b.trackNo || 0),
  album: (a, b) => cmp(a.album, b.album) || (a.disc || 0) - (b.disc || 0) || (a.trackNo || 0) - (b.trackNo || 0),
  duration: (a, b) => (a.duration || 0) - (b.duration || 0),
};

class TrackList {
  constructor(host, ids, opts = {}) {
    this.host = host;
    this.baseIds = ids;
    this.opts = opts;
    this.ids = this.applySort();
    this.el = document.createElement('div');
    this.el.className = 'tlist' + (opts.noAlbum ? ' no-album' : '');
    const s = S.sort;
    const h = (key, label) => `<div class="sortable ${s && s.key === key ? 'sorted' : ''}" data-sort="${key}">${label}${s && s.key === key ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}</div>`;
    this.el.innerHTML = `<div class="thead"><div style="text-align:center">#</div>${h('title', 'Название')}${h('artist', 'Исполнитель')}<div class="c-album">${h('album', 'Альбом')}</div><div></div><div style="text-align:right">${h('duration', icon('clock'))}</div></div><div class="tbody"></div>`;
    this.body = this.el.querySelector('.tbody');
    this.body.style.height = this.ids.length * ROW + 'px';
    host.appendChild(this.el);
    this.rendered = new Map();
    this.bind();
    requestAnimationFrame(() => this.refresh());
  }

  applySort() {
    if (!S.sort) return this.baseIds.slice();
    const f = SORTERS[S.sort.key];
    const arr = this.baseIds.map((id) => S.tracks.get(id)).filter(Boolean);
    arr.sort((a, b) => f(a, b) * S.sort.dir);
    return arr.map((t) => t.id);
  }

  range() {
    const view = $('#view');
    const top = this.body.getBoundingClientRect().top - view.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / ROW) - 8);
    const last = Math.min(this.ids.length, Math.ceil((view.clientHeight - top) / ROW) + 8);
    return [first, last];
  }

  refresh() {
    if (!this.el.isConnected) return;
    const [a, b] = this.range();
    let html = '';
    const playingId = Player.current?.id;
    for (let i = a; i < b; i++) {
      const t = S.tracks.get(this.ids[i]);
      if (!t) continue;
      const liked = isLiked(t.id);
      const num = this.opts.trackNumbers && t.trackNo && !S.sort ? t.trackNo : i + 1;
      const cls = (S.selected.has(t.id) ? ' selected' : '') + (t.id === playingId ? ' playing' : '');
      const ak = albumKey(t);
      html += `<div class="trow${cls}" data-i="${i}" draggable="true" style="top:${i * ROW}px">
        <div class="c-num"><span class="n">${num}</span>${icon('play', 'pl')}<span class="bars"><span></span><span></span><span></span></span></div>
        <div class="c-title"><div class="cv${t.cover ? '' : ' nocover'}" style="${bg(t.cover)}" ${t.cover ? '' : 'title="Найти обложку"'}>${t.cover ? '' : icon('music')}</div><div class="meta"><span class="t ell" title="${esc(t.title)}">${esc(t.title)}</span></div></div>
        <div class="ell">${artistLinks(t.artist)}</div>
        <div class="c-album ell">${ak ? `<span class="link" data-album="${esc(ak)}">${esc(t.album)}</span>` : '<span style="color:var(--text-3)">—</span>'}</div>
        <div class="c-like"><button class="${liked ? 'on' : ''}" data-like title="${liked ? 'Убрать из любимых' : 'В любимые'}">${icon(liked ? 'heartFill' : 'heart')}</button></div>
        <div class="c-dur">${fmtTime(t.duration)}</div></div>`;
    }
    this.body.innerHTML = html;
  }

  updateSelection() {
    this.body.querySelectorAll('.trow').forEach((r) => r.classList.toggle('selected', S.selected.has(this.ids[+r.dataset.i])));
  }

  idAt(el) {
    const row = el.closest('.trow');
    return row ? { i: +row.dataset.i, id: this.ids[+row.dataset.i] } : null;
  }

  selectionIds() {
    return this.ids.filter((id) => S.selected.has(id));
  }

  play(i) {
    if (this.opts.onPlay) return this.opts.onPlay(this.ids, i);
    Player.playList(this.ids, i);
  }

  bind() {
    this.el.querySelector('.thead').addEventListener('click', (e) => {
      const s = e.target.closest('[data-sort]');
      if (!s) return;
      const key = s.dataset.sort;
      if (!S.sort || S.sort.key !== key) S.sort = { key, dir: 1 };
      else if (S.sort.dir === 1) S.sort.dir = -1;
      else S.sort = null;
      render(true);
    });
    this.body.addEventListener('click', (e) => {
      const hit = this.idAt(e.target);
      if (!hit) return;
      if (e.target.closest('[data-like]')) return toggleLike(hit.id);
      if (e.target.closest('.cv.nocover')) { const tt = S.tracks.get(hit.id); return coverPicker([hit.id], `${primaryArtist(tt)} ${tt.title}`, tt.title); }
      if (e.target.closest('.link')) return;
      if (e.target.closest('.c-num .pl')) return this.play(hit.i);
      if (e.shiftKey && S.lastSel >= 0) {
        const [a, b] = [Math.min(S.lastSel, hit.i), Math.max(S.lastSel, hit.i)];
        if (!e.ctrlKey) S.selected.clear();
        for (let i = a; i <= b; i++) S.selected.add(this.ids[i]);
      } else if (e.ctrlKey || e.metaKey) {
        S.selected.has(hit.id) ? S.selected.delete(hit.id) : S.selected.add(hit.id);
        S.lastSel = hit.i;
      } else {
        S.selected.clear();
        S.selected.add(hit.id);
        S.lastSel = hit.i;
      }
      this.updateSelection();
    });
    this.body.addEventListener('dblclick', (e) => {
      const hit = this.idAt(e.target);
      if (hit && !e.target.closest('[data-like], .link')) this.play(hit.i);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const hit = this.idAt(e.target);
      if (!hit) return;
      e.preventDefault();
      if (!S.selected.has(hit.id)) {
        S.selected.clear();
        S.selected.add(hit.id);
        S.lastSel = hit.i;
        this.updateSelection();
      }
      trackMenu(e.clientX, e.clientY, this.selectionIds(), this);
    });
    this.body.addEventListener('dragstart', (e) => {
      const hit = this.idAt(e.target);
      if (!hit) return;
      const ids = S.selected.has(hit.id) ? this.selectionIds() : [hit.id];
      e.dataTransfer.setData('application/x-tembr-ids', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copy';
      const ghost = document.createElement('div');
      ghost.className = 'toast';
      ghost.style.cssText = 'position:fixed;top:-100px';
      ghost.textContent = ids.length > 1 ? tracksWord(ids.length) : S.tracks.get(ids[0]).title;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    });
  }
}

$('#view').addEventListener('scroll', () => currentList?.refresh(), { passive: true });
window.addEventListener('resize', () => currentList?.refresh());

// Ссылки на альбом/исполнителя (во всём окне)
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-artist]');
  if (a && a.classList.contains('link')) return navigate({ name: 'artist', key: a.dataset.artist });
  const ia = e.target.closest('[data-ia]');
  if (ia && ia.classList.contains('link')) return navigate({ name: 'archiveItem', key: ia.dataset.ia });
  const al = e.target.closest('[data-album]');
  if (al && al.classList.contains('link')) return navigate({ name: 'album', key: al.dataset.album });
});

// =====================================================================
//  Контекстное меню
// =====================================================================
const ctx = $('#ctx-menu');
function openMenu(x, y, items) {
  ctx.innerHTML = '';
  for (const it of items) {
    if (it === '-') { ctx.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    if (it.danger) b.className = 'danger';
    b.innerHTML = `${icon(it.icon || 'music')}<span>${esc(it.label)}</span>${it.sub ? '<span class="arrow">›</span>' : ''}`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.sub) return openMenu(parseFloat(ctx.style.left), parseFloat(ctx.style.top), it.sub());
      closeMenu();
      it.action();
    });
    ctx.appendChild(b);
  }
  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctx.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function closeMenu() { ctx.classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!ctx.contains(e.target)) closeMenu(); });
window.addEventListener('blur', closeMenu);

function playlistSubmenu(ids) {
  return () => [
    { label: 'Новый плейлист…', icon: 'add', action: () => createPlaylist(ids) },
    ...(S.playlists.length ? ['-'] : []),
    ...S.playlists.map((p) => ({ label: p.name, icon: 'playlist', action: () => addToPlaylist(p.id, ids) })),
  ];
}

function trackMenu(x, y, ids, list) {
  if (!ids.length) return;
  const t = S.tracks.get(ids[0]);
  const allLiked = ids.every(isLiked);
  const items = [
    { label: ids.length > 1 ? `Воспроизвести (${ids.length})` : 'Воспроизвести', icon: 'play', action: () => (ids.length > 1 ? Player.playList(ids, 0) : list ? list.play(list.ids.indexOf(ids[0])) : Player.playList(ids, 0)) },
    { label: 'Играть следующим', icon: 'next', action: () => Player.playNext(ids) },
    { label: 'Добавить в очередь', icon: 'queue', action: () => Player.addToQueue(ids) },
    '-',
    { label: 'Добавить в плейлист', icon: 'playlist', sub: playlistSubmenu(ids) },
    { label: allLiked ? 'Убрать из любимых' : 'Добавить в любимые', icon: allLiked ? 'heartFill' : 'heart', action: () => ids.forEach((id) => toggleLike(id, !allLiked)) },
  ];
  if (ids.length > 1) items.push('-', { label: 'Обложка для выбранных', icon: 'image', sub: coverSubmenu(ids, `${primaryArtist(t)} ${t.album || t.title}`) });
  if (ids.length === 1) {
    items.push('-');
    if (albumKey(t)) items.push({ label: 'Перейти к альбому', icon: 'album', action: () => navigate({ name: 'album', key: albumKey(t) }) });
    const names = trackArtistNames(t);
    if (names.length > 1) items.push({ label: 'Перейти к исполнителю', icon: 'artist', sub: () => names.map((n) => ({ label: n, icon: 'artist', action: () => navigate({ name: 'artist', key: n.toLowerCase() }) })) });
    else items.push({ label: 'Перейти к исполнителю', icon: 'artist', action: () => navigate({ name: 'artist', key: names[0].toLowerCase() }) });
    items.push({ label: 'Обложка', icon: 'image', sub: coverSubmenu(ids, `${primaryArtist(t)} ${t.title}`) });
    items.push({ label: 'Текст песни', icon: 'lyrics', sub: () => [
      { label: 'Найти текст…', icon: 'search', action: () => Lyrics.searchModal(t) },
      { label: 'Вставить свой текст…', icon: 'paste', action: () => Lyrics.pasteModal(t) },
    ] });
    items.push({ label: 'Показать в папке', icon: 'folder', action: () => window.api.showItem(t.path) });
    items.push({ label: 'Сведения о файле', icon: 'more', action: () => trackInfo(t) });
  }
  if (S.view.name === 'playlist') {
    items.push('-', { label: 'Удалить из плейлиста', icon: 'trash', danger: true, action: () => removeFromPlaylist(S.view.id, ids) });
  }
  openMenu(x, y, items);
}

function trackInfo(t) {
  const rows = [
    ['Название', t.title], ['Исполнитель', t.artist], ['Альбом', t.album], ['Исполнитель альбома', t.albumArtist],
    ['Год', t.year], ['Жанр', t.genre], ['Номер', t.trackNo], ['Длительность', fmtTime(t.duration)],
    ['Формат', [t.codec, t.bitrate ? t.bitrate + ' кбит/с' : '', t.sampleRate ? (t.sampleRate / 1000).toFixed(1) + ' кГц' : ''].filter(Boolean).join(' · ')],
    ['Размер', t.size ? (t.size / 1048576).toFixed(1) + ' МБ' : ''], ['Прослушиваний', (S.stats[t.id] || {}).plays || 0], ['Файл', t.path],
  ].filter((r) => r[1] !== '' && r[1] != null);
  modal(`<h2>Сведения о треке</h2><div style="display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:13px;max-width:560px;user-select:text">${rows.map(([k, v]) => `<span style="color:var(--text-2)">${k}</span><span style="word-break:break-all">${esc(v)}</span>`).join('')}</div><div class="row"><button class="btn primary" data-close>Закрыть</button></div>`);
}

// =====================================================================
//  Модальные окна
// =====================================================================
function modal(html, onMount) {
  const bgEl = document.createElement('div');
  bgEl.className = 'modal-bg';
  bgEl.innerHTML = `<div class="modal">${html}</div>`;
  $('#modal-root').appendChild(bgEl);
  const close = () => { bgEl.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  bgEl.addEventListener('mousedown', (e) => { if (e.target === bgEl) close(); });
  bgEl.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  onMount && onMount(bgEl.querySelector('.modal'), close);
  return close;
}

function prompt(title, value, okLabel, cb) {
  modal(`<h2>${esc(title)}</h2><input class="input" id="m-in" value="${esc(value)}" maxlength="100" spellcheck="false"/><div class="row"><button class="btn" data-close>Отмена</button><button class="btn primary" id="m-ok">${esc(okLabel)}</button></div>`, (m, close) => {
    const inp = m.querySelector('#m-in');
    inp.focus();
    inp.select();
    const ok = () => { const v = inp.value.trim(); if (!v) return inp.focus(); close(); cb(v); };
    m.querySelector('#m-ok').addEventListener('click', ok);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  });
}

function confirmBox(title, text, okLabel, cb) {
  modal(`<h2>${esc(title)}</h2><p style="color:var(--text-2);margin:0;max-width:420px;line-height:1.5">${esc(text)}</p><div class="row"><button class="btn" data-close>Отмена</button><button class="btn primary" id="m-ok">${esc(okLabel)}</button></div>`, (m, close) => {
    m.querySelector('#m-ok').addEventListener('click', () => { close(); cb(); });
    m.querySelector('#m-ok').focus();
  });
}

// =====================================================================
//  Плейлисты
// =====================================================================
function createPlaylist(ids = []) {
  prompt('Новый плейлист', `Мой плейлист ${S.playlists.length + 1}`, 'Создать', (name) => {
    const p = { id: uid(), name, ids: [...new Set(ids)], createdAt: Date.now() };
    S.playlists.push(p);
    savePlaylists();
    renderNav();
    if (ids.length) toast(`Плейлист «${name}» создан`);
    else navigate({ name: 'playlist', id: p.id });
  });
}
function addToPlaylist(pid, ids) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p) return;
  const set = new Set(p.ids);
  const fresh = ids.filter((id) => !set.has(id));
  p.ids.push(...fresh);
  savePlaylists();
  renderNav();
  toast(fresh.length ? `Добавлено в «${p.name}»: ${tracksWord(fresh.length)}` : `Уже есть в «${p.name}»`);
  if (S.view.name === 'playlist' && S.view.id === pid) render(true);
}
function removeFromPlaylist(pid, ids) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p) return;
  const rm = new Set(ids);
  p.ids = p.ids.filter((id) => !rm.has(id));
  S.selected.clear();
  savePlaylists();
  renderNav();
  render(true);
}
function renamePlaylist(p) {
  prompt('Переименовать плейлист', p.name, 'Сохранить', (name) => { p.name = name; savePlaylists(); renderNav(); render(true); });
}
function deletePlaylist(p) {
  confirmBox('Удалить плейлист?', `Плейлист «${p.name}» будет удалён. Сами треки останутся в библиотеке.`, 'Удалить', () => {
    S.playlists = S.playlists.filter((x) => x !== p);
    savePlaylists();
    renderNav();
    navigate({ name: 'tracks' }, true);
  });
}

// =====================================================================
//  Боковое меню
// =====================================================================
function navItem(view, ic, label, count) {
  const active = sameView(S.view, view) ? ' active' : '';
  return `<button class="nav-item${active}" data-nav='${esc(JSON.stringify(view))}'>${icon(ic)}<span>${esc(label)}</span>${count != null ? `<span class="count">${count}</span>` : ''}</button>`;
}
function sameView(a, b) {
  return a.name === b.name && (a.id || '') === (b.id || '');
}
function likedIds() {
  return Object.entries(S.stats).filter(([id, s]) => s.liked && S.tracks.has(id)).sort((a, b) => (b[1].likedAt || 0) - (a[1].likedAt || 0)).map(([id]) => id);
}
const LIB_VIEWS = ['tracks', 'albums', 'artists', 'recent'];
function renderNav() {
  const v = S.view.name;
  const item = (view, ic, label, active, count, cls = '') => `<button class="nav-item${cls}${active ? ' active' : ''}" data-nav='${esc(JSON.stringify(view))}'>${icon(ic)}<span>${esc(label)}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`;
  const liked = likedIds().length;
  $('#nav').innerHTML = `
    ${item({ name: 'home' }, 'home', 'Главная', v === 'home')}
    ${item({ name: 'search' }, 'search', 'Поиск', v === 'search')}
    ${item({ name: 'tracks' }, 'library', 'Библиотека', LIB_VIEWS.includes(v) || v === 'album' || v === 'artist')}
    ${item({ name: 'playlists' }, 'playlist', 'Плейлисты', v === 'playlists')}
    ${item({ name: 'liked' }, 'heart', 'Избранное', v === 'liked', liked)}
    ${item({ name: 'radio' }, 'radio', 'Радио', v === 'radio')}
    ${item({ name: 'archive' }, 'globe', 'Архив', v === 'archive' || v === 'archiveItem')}
    ${item({ name: 'settings' }, 'settings', 'Настройки', v === 'settings')}
    <div class="nav-title">Ваши плейлисты <button id="nav-new-pl" title="Новый плейлист">${icon('add')}</button></div>
    ${S.playlists.map((p) => item({ name: 'playlist', id: p.id }, 'playlist', p.name, v === 'playlist' && S.view.id === p.id, p.ids.filter((id) => S.tracks.has(id)).length, ' small')).join('')}
    ${S.playlists.length ? '' : '<div style="padding:4px 14px;color:var(--text-3);font-size:12px;line-height:1.5">Нажмите «+» или перетащите сюда треки</div>'}
  `;
}
$('#nav').addEventListener('click', (e) => {
  if (e.target.closest('#nav-new-pl')) return createPlaylist();
  const b = e.target.closest('[data-nav]');
  if (b) navigate(JSON.parse(b.dataset.nav));
});
$('#nav').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-nav]');
  if (!b) return;
  const v = JSON.parse(b.dataset.nav);
  if (v.name !== 'playlist') return;
  e.preventDefault();
  const p = S.playlists.find((x) => x.id === v.id);
  openMenu(e.clientX, e.clientY, [
    { label: 'Воспроизвести', icon: 'play', action: () => Player.playList(p.ids, 0) },
    { label: 'Перемешать', icon: 'shuffle', action: () => Player.playList(p.ids, 0, { shuffle: true, randomStart: true }) },
    '-',
    { label: 'Переименовать', icon: 'edit', action: () => renamePlaylist(p) },
    { label: 'Удалить', icon: 'trash', danger: true, action: () => deletePlaylist(p) },
  ]);
});
// Перетаскивание треков на плейлист в меню
$('#nav').addEventListener('dragover', (e) => {
  const b = e.target.closest('[data-nav]');
  if (!b || !e.dataTransfer.types.includes('application/x-tembr-ids')) return;
  const v = JSON.parse(b.dataset.nav);
  if (v.name !== 'playlist' && v.name !== 'liked') return;
  e.preventDefault();
  $$('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  b.classList.add('drop-target');
});
$('#nav').addEventListener('dragleave', (e) => e.target.closest?.('[data-nav]')?.classList.remove('drop-target'));
$('#nav').addEventListener('drop', (e) => {
  const b = e.target.closest('[data-nav]');
  $$('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  const raw = e.dataTransfer.getData('application/x-tembr-ids');
  if (!b || !raw) return;
  e.preventDefault();
  e.stopPropagation();
  const v = JSON.parse(b.dataset.nav);
  const ids = JSON.parse(raw);
  if (v.name === 'playlist') addToPlaylist(v.id, ids);
  else if (v.name === 'liked') { ids.forEach((id) => toggleLike(id, true)); toast('Добавлено в любимые'); }
});

// =====================================================================
//  Навигация и экраны
// =====================================================================
function navigate(v, replace = false) {
  if (!replace && !sameView(v, S.view) || (v.key && v.key !== S.view.key)) S.history.push({ view: S.view, scroll: $('#view').scrollTop });
  S.view = v;
  S.sort = null;
  S.selected.clear();
  S.lastSel = -1;
  if (S.search) { S.search = ''; $('#search').value = ''; $('.search').classList.remove('has-text'); }
  closeMenu();
  render(false);
  renderNav();
}
$('#btn-back').addEventListener('click', goBack);
function goBack() {
  const h = S.history.pop();
  if (!h) return;
  S.view = h.view;
  S.sort = null;
  S.selected.clear();
  render(false);
  renderNav();
  $('#view').scrollTop = h.scroll || 0;
  currentList?.refresh();
}

function render(keepScroll) {
  const view = $('#view');
  const scroll = view.scrollTop;
  currentList = null;
  view.innerHTML = '';
  $('#btn-back').disabled = !S.history.length;
  const v = S.view;
  if (S.search.trim() && !['settings', 'radio', 'archive'].includes(v.name)) renderSearch(view);
  else {
    const fn = VIEWS[v.name] || VIEWS.home;
    fn(view, v);
  }
  if (keepScroll) view.scrollTop = scroll;
  else view.scrollTop = 0;
  currentList?.refresh();
}

function head({ kicker, title, sub, art, artClass = '', artIcon = 'music', actions = '', compact = false, banner = null, editable = false }) {
  const bannerBg = banner ? (banner.startsWith('grad-') ? `<div class="banner-bg grad ${banner}"></div>` : `<div class="banner-bg" style="${bg(banner)}"></div>`) : '';
  return `<div class="view-head${compact ? ' compact' : ''}${banner ? ' banner' : ''}">
    ${bannerBg}
    ${art !== false ? `<div class="art ${artClass}${editable ? ' editable' : ''}" style="${art ? bg(art) : ''}">${art ? '' : icon(artIcon)}${editable ? `<div class="edit-hint">${icon('image')}Обложка</div>` : ''}</div>` : ''}
    <div class="info">
      ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
      <h1 title="${esc(title)}">${esc(title)}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div></div>`;
}
const playActions = (extra = '', onBanner = false) => onBanner
  ? `<button class="btn light round" data-act="play">${icon('play')}Слушать</button><button class="btn ghost-light round" data-act="shuffle">${icon('shuffle')}Перемешать</button>${extra}`
  : `<button class="btn primary round" data-act="play">${icon('play')}Слушать</button><button class="btn round" data-act="shuffle">${icon('shuffle')}Перемешать</button>${extra}`;
function bindPlayActions(view, ids) {
  view.querySelector('[data-act="play"]')?.addEventListener('click', () => Player.playList(currentList ? currentList.ids : ids, 0, { shuffle: false }));
  view.querySelector('[data-act="shuffle"]')?.addEventListener('click', () => Player.playList(ids, 0, { shuffle: true, randomStart: true }));
}
const totalDur = (ids) => ids.reduce((s, id) => s + (S.tracks.get(id)?.duration || 0), 0);
const summary = (ids) => `${tracksWord(ids.length)} · ${fmtTotal(totalDur(ids))}`;

function emptyLibrary(view) {
  view.innerHTML = `<div class="empty">
    <div class="big grad-1">${icon('music')}</div>
    <h2>Добавьте свою музыку</h2>
    <p>Укажите папку с музыкой — Tembr найдёт все треки, подтянет обложки и тексты песен и будет сам замечать новые файлы в этой папке.<br/>Можно просто перетащить папку или файлы в это окно.</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
      <button class="btn primary" id="e-folder">${icon('folder')}Выбрать папку</button>
      <button class="btn" id="e-files">${icon('add')}Добавить файлы</button>
      <button class="btn" id="e-radio">${icon('radio')}Слушать радио</button>
    </div>
    ${S.folders.length ? `<p style="margin-top:24px;font-size:12px;color:var(--text-3)">Отслеживаемые папки: ${S.folders.map(esc).join(', ')}${S.progress.scanning ? ' — идёт сканирование…' : ' — аудиофайлов не найдено'}</p>` : ''}
  </div>`;
  $('#e-folder').addEventListener('click', addFolder);
  $('#e-files').addEventListener('click', addFiles);
  $('#e-radio').addEventListener('click', () => navigate({ name: 'radio' }));
}

async function addFolder() {
  const before = S.folders.length;
  S.folders = await window.api.addFolder();
  if (S.folders.length > before) toast('Папка добавлена — сканирую…');
  if (S.view.name === 'settings') render(true);
}
async function addFiles() {
  const ids = await window.api.addFiles();
  if (ids.length) { toast(`Добавлено: ${tracksWord(ids.length)}`); }
}

// ---------- Карточки и ряды ----------
function cardHtml(it, i) {
  const mosaic = it.mosaic && it.mosaic.length >= 4;
  const inner = mosaic ? `<div class="mosaic">${it.mosaic.slice(0, 4).map((c) => `<div style="${bg(c)}"></div>`).join('')}</div>` : it.cover ? '' : icon(it.icon || 'music', it.overlay ? 'big' : '');
  const style = it.cover && !mosaic ? bg(it.cover) : '';
  const fab = it.play ? `<button class="play-fab" data-play title="Слушать">${icon('play')}</button>` : '';
  if (it.overlay) {
    return `<div class="card overlay" data-i="${i}"><div class="art ${it.grad || ''}" style="${style}">${inner}<div class="label"><div class="t ell">${esc(it.title)}</div><div class="s ell">${esc(it.sub || '')}</div></div></div>${fab}</div>`;
  }
  return `<div class="card" data-i="${i}"><div class="art${it.round ? ' round' : ''} ${it.grad || ''}" style="${style}">${inner}</div>${fab}<div class="t ell" title="${esc(it.title)}" style="${it.round ? 'text-align:center' : ''}">${esc(it.title)}</div><div class="s ell" style="${it.round ? 'text-align:center' : ''}">${esc(it.sub || '')}</div></div>`;
}
function bindCards(el, items) {
  el.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const it = items[+c.dataset.i];
    if (e.target.closest('[data-play]')) return it.play && it.play();
    (it.open || it.play)?.();
  });
  el.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const it = items[+c.dataset.i];
    if (it.menu) { e.preventDefault(); return it.menu(e.clientX, e.clientY); }
    const ids = it.ids && it.ids();
    if (!ids || !ids.length) return;
    e.preventDefault();
    trackMenu(e.clientX, e.clientY, ids);
  });
}
function rowSection(view, title, items, { wide = false, more = null, grid = false } = {}) {
  if (!items.length) return;
  const sec = document.createElement('div');
  sec.innerHTML = `<div class="section-title"><span>${esc(title)}</span>${more ? `<button data-more>Все ${icon('arrowRight')}</button>` : ''}</div><div class="${grid ? 'grid' : 'hrow' + (wide ? ' wide' : '')}">${items.map(cardHtml).join('')}</div>`;
  sec.querySelector('[data-more]')?.addEventListener('click', more);
  bindCards(sec, items);
  view.appendChild(sec);
}
const albumItem = (a) => ({
  title: a.name, sub: [a.artist, a.year].filter(Boolean).join(' · '), cover: a.cover, icon: 'album',
  open: () => navigate({ name: 'album', key: a.key }), play: () => Player.playList(sortedTracks(a.ids, 'album'), 0), ids: () => sortedTracks(a.ids, 'album'),
});
const artistItem = (a) => ({
  title: a.name, sub: tracksWord(a.ids.length), cover: a.cover, icon: 'artist', round: true,
  open: () => navigate({ name: 'artist', key: a.key }), play: () => Player.playList(sortedTracks(a.ids, 'default'), 0), ids: () => sortedTracks(a.ids, 'default'),
  menu: (x, y) => artistMenu(x, y, a),
});
const coversOf = (ids, n = 4) => [...new Set(ids.map((id) => S.tracks.get(id)?.cover).filter(Boolean))].slice(0, n);
const topIds = () => Object.entries(S.stats).filter(([id, s]) => s.plays > 0 && S.tracks.has(id)).sort((a, b) => b[1].plays - a[1].plays || b[1].last - a[1].last).slice(0, 100).map(([id]) => id);
const historyIds = () => Object.entries(S.stats).filter(([id, s]) => s.last && S.tracks.has(id)).sort((a, b) => b[1].last - a[1].last).slice(0, 200).map(([id]) => id);
const recentIds = () => sortedTracks(Array.from(S.tracks.keys()), 'added').slice(0, 300);

// ---------- Главная: баннер-карусель ----------
let heroTimer = null;
function heroSlides() {
  const slides = [];
  const albums = index().albums;
  if (!S.tracks.size) {
    slides.push({ kicker: 'Добро пожаловать', title: 'Музыка начинается здесь', sub: 'Добавьте папку с музыкой — Tembr сам найдёт треки, обложки и тексты песен', grad: 'grad-6', playLabel: 'Добавить папку', play: addFolder, iconName: 'folder' });
    slides.push({ kicker: 'Онлайн', title: 'Интернет-радио', sub: 'Тысячи бесплатных станций со всего мира', grad: 'grad-3', playLabel: 'Открыть радио', play: () => navigate({ name: 'radio' }), iconName: 'radio' });
    return slides;
  }
  const hist = historyIds();
  const last = hist.length ? S.tracks.get(hist[0]) : null;
  let usedKey = null;
  if (last) {
    const ak = albumKey(last);
    const a = ak && albums.get(ak);
    usedKey = ak;
    slides.push(a
      ? { kicker: 'Продолжить слушать', title: a.name, sub: `${a.artist}${a.year ? ' · ' + a.year : ''}`, cover: a.cover, play: () => { const ids = sortedTracks(a.ids, 'album'); Player.playList(ids, Math.max(0, ids.indexOf(last.id))); }, open: () => navigate({ name: 'album', key: ak }) }
      : { kicker: 'Продолжить слушать', title: last.title, sub: artistOf(last), cover: last.cover, play: () => Player.playList(hist.slice(0, 50), 0) });
  }
  const list = Array.from(albums.values()).filter((a) => a.key !== usedKey).sort((a, b) => cmp(a.key, b.key));
  if (list.length) {
    const day = Math.floor(Date.now() / 86400000);
    const a = list[day % list.length];
    slides.push({ kicker: 'Альбом дня', title: a.name, sub: `${a.artist}${a.year ? ' · ' + a.year : ''} · ${tracksWord(a.ids.length)}`, cover: a.cover, play: () => Player.playList(sortedTracks(a.ids, 'album'), 0), open: () => navigate({ name: 'album', key: a.key }) });
  }
  const liked = likedIds();
  if (liked.length) slides.push({ kicker: 'Ваша подборка', title: 'Любимые треки', sub: tracksWord(liked.length), cover: coversOf(liked, 1)[0], grad: 'grad-2', play: () => Player.playList(liked, 0), open: () => navigate({ name: 'liked' }) });
  const all = Array.from(S.tracks.keys());
  const someCover = coversOf(shuffleArr(all.slice()).slice(0, 40), 1)[0];
  slides.push({ kicker: 'Микс', title: 'Утро начинается с музыки', sub: 'Вся ваша библиотека вперемешку', cover: someCover, grad: 'grad-6', play: () => Player.playList(all, 0, { shuffle: true, randomStart: true }) });
  slides.push({ kicker: 'Онлайн', title: 'Интернет-радио', sub: 'Тысячи бесплатных станций со всего мира', grad: 'grad-3', playLabel: 'Открыть', play: () => navigate({ name: 'radio' }), iconName: 'radio' });
  return slides;
}

function buildHero(slides) {
  const hero = document.createElement('div');
  hero.className = 'hero';
  hero.innerHTML = slides.map((s, i) => `
    <div class="hero-slide${i === 0 ? ' active' : ''}" data-i="${i}">
      <div class="hero-bg${s.cover ? '' : ' grad ' + (s.grad || 'grad-6')}" style="${s.cover ? bg(s.cover) : ''}"></div>
      ${s.cover ? `<div class="hero-img" style="${bg(s.cover)}"></div>` : ''}
      <div class="hero-shade"></div>
      <div class="hero-text">
        <div class="hero-kicker">${esc(s.kicker)}</div>
        <h2 class="${s.title.length > 22 ? 'long' : ''}">${esc(s.title)}</h2>
        <div class="hero-sub">${esc(s.sub || '')}</div>
        <div class="hero-actions">
          <button class="btn light round" data-hplay>${icon(s.iconName || 'play')}${esc(s.playLabel || 'Слушать')}</button>
          ${s.open ? `<button class="circle-btn ghost-light" data-hopen title="Открыть">${icon('arrowRight')}</button>` : ''}
        </div>
      </div>
    </div>`).join('') + (slides.length > 1 ? `<div class="hero-dots">${slides.map((_, i) => `<button data-dot="${i}" class="${i === 0 ? 'active' : ''}"></button>`).join('')}</div>` : '');
  let cur = 0;
  const go = (i) => {
    cur = (i + slides.length) % slides.length;
    hero.querySelectorAll('.hero-slide').forEach((el, k) => el.classList.toggle('active', k === cur));
    hero.querySelectorAll('[data-dot]').forEach((el, k) => el.classList.toggle('active', k === cur));
  };
  hero.addEventListener('click', (e) => {
    const d = e.target.closest('[data-dot]');
    if (d) return go(+d.dataset.dot);
    const s = slides[cur];
    if (e.target.closest('[data-hplay]')) return s.play && s.play();
    if (e.target.closest('[data-hopen]')) return s.open && s.open();
  });
  let paused = false;
  hero.addEventListener('mouseenter', () => { paused = true; });
  hero.addEventListener('mouseleave', () => { paused = false; });
  clearInterval(heroTimer);
  if (slides.length > 1) heroTimer = setInterval(() => { if (!hero.isConnected) return clearInterval(heroTimer); if (!paused) go(cur + 1); }, 8000);
  return hero;
}

function libTabs(view, tab) {
  const tabs = [['tracks', 'Треки'], ['albums', 'Альбомы'], ['artists', 'Исполнители'], ['recent', 'Недавно добавленные']];
  const el = document.createElement('div');
  el.className = 'tabs';
  el.innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== tab) navigate({ name: b.dataset.tab }, true); });
  view.appendChild(el);
}

function coverEditable(view, ids, query) {
  view.querySelector('.view-head .art.editable')?.addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    coverMenu(r.left + 20, r.bottom - 10, ids, query);
  });
}

const VIEWS = {
  home(view) {
    view.appendChild(buildHero(heroSlides()));
    if (!S.tracks.size) {
      const box = document.createElement('div');
      emptyLibrary(box);
      view.appendChild(box);
      return;
    }
    const albums = index().albums;
    // Недавно прослушанные: альбомы или отдельные треки
    const seen = new Set();
    const recent = [];
    for (const id of historyIds()) {
      const t = S.tracks.get(id);
      const ak = albumKey(t);
      const k = ak || 't:' + id;
      if (seen.has(k)) continue;
      seen.add(k);
      if (ak && albums.get(ak)) recent.push(albumItem(albums.get(ak)));
      else recent.push({ title: t.title, sub: artistOf(t), cover: t.cover, play: () => Player.playList([id], 0), ids: () => [id] });
      if (recent.length >= 14) break;
    }
    rowSection(view, 'Недавно прослушанные', recent, { more: () => navigate({ name: 'history' }) });

    const liked = likedIds(), top = topIds(), hist = historyIds(), added = recentIds(), all = Array.from(S.tracks.keys());
    const mixes = [
      { title: 'Любимые', sub: liked.length ? tracksWord(liked.length) : 'Отмечайте треки ♡', overlay: true, grad: 'grad-2', icon: 'heartFill', mosaic: coversOf(liked), open: () => navigate({ name: 'liked' }), play: liked.length ? () => Player.playList(liked, 0) : null },
      { title: 'Часто слушаю', sub: top.length ? tracksWord(top.length) : 'Пока пусто', overlay: true, grad: 'grad-4', icon: 'fire', mosaic: coversOf(top), open: () => navigate({ name: 'top' }), play: top.length ? () => Player.playList(top, 0) : null },
      { title: 'Недавно добавленные', sub: tracksWord(added.length), overlay: true, grad: 'grad-3', icon: 'sparkle', mosaic: coversOf(added), open: () => navigate({ name: 'recent' }), play: () => Player.playList(added, 0) },
      { title: 'Случайный микс', sub: 'Вся библиотека', overlay: true, grad: 'grad-6', icon: 'shuffle', mosaic: coversOf(shuffleArr(all.slice()).slice(0, 60)), play: () => Player.playList(all, 0, { shuffle: true, randomStart: true }) },
      { title: 'Недавно играли', sub: hist.length ? tracksWord(hist.length) : 'История пуста', overlay: true, grad: 'grad-5', icon: 'clock', mosaic: coversOf(hist), open: () => navigate({ name: 'history' }), play: hist.length ? () => Player.playList(hist, 0) : null },
    ];
    rowSection(view, 'Подборки для вас', mixes, { wide: true });

    const newAlbums = Array.from(albums.values()).map((a) => ({ a, t: Math.max(...a.ids.map((id) => S.tracks.get(id)?.addedAt || 0)) })).sort((x, y) => y.t - x.t).slice(0, 14).map((x) => albumItem(x.a));
    rowSection(view, 'Новые альбомы в библиотеке', newAlbums, { more: () => navigate({ name: 'albums' }) });

    const artists = Array.from(index().artists.values()).sort((a, b) => b.ids.length - a.ids.length).slice(0, 14).map(artistItem);
    rowSection(view, 'Исполнители', artists, { more: () => navigate({ name: 'artists' }) });

    if (S.playlists.length) rowSection(view, 'Ваши плейлисты', S.playlists.map(playlistItem), { more: () => navigate({ name: 'playlists' }) });
  },

  search(view) {
    const genres = new Map();
    for (const t of S.tracks.values()) if (t.genre) genres.set(t.genre, (genres.get(t.genre) || 0) + 1);
    const top = [...genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Поиск', title: 'Что послушаем?', sub: 'Начните вводить название трека, исполнителя или альбома в строке поиска сверху', art: false, compact: true }));
    if (top.length) {
      view.insertAdjacentHTML('beforeend', `<div class="section-title">Жанры в вашей библиотеке</div><div class="radio-filters" id="genres">${top.map(([g, n]) => `<button class="chip" data-g="${esc(g)}">${esc(g)} <span style="opacity:.6">${n}</span></button>`).join('')}</div>`);
      $('#genres').addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (!b) return; $('#search').value = b.dataset.g; $('#search').dispatchEvent(new Event('input')); });
    }
    setTimeout(() => $('#search').focus(), 0);
  },

  tracks(view) {
    const ids = sortedTracks(Array.from(S.tracks.keys()), 'default');
    if (!ids.length) return emptyLibrary(view);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Моя музыка', title: 'Библиотека', sub: summary(ids), art: false, compact: true, actions: playActions(`<button class="btn round" id="h-add">${icon('folder')}Добавить папку</button>`) }));
    bindPlayActions(view, ids);
    $('#h-add').addEventListener('click', addFolder);
    libTabs(view, 'tracks');
    currentList = new TrackList(view, ids);
  },

  albums(view) {
    if (!S.tracks.size) return emptyLibrary(view);
    const albums = Array.from(index().albums.values()).sort((a, b) => cmp(a.artist, b.artist) || (a.year || 0) - (b.year || 0) || cmp(a.name, b.name));
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Моя музыка', title: 'Библиотека', sub: plural(albums.length, 'альбом', 'альбома', 'альбомов'), art: false, compact: true }));
    libTabs(view, 'albums');
    view.appendChild(albumGrid(albums));
  },

  artists(view) {
    if (!S.tracks.size) return emptyLibrary(view);
    const artists = Array.from(index().artists.values()).sort((a, b) => cmp(a.name, b.name));
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Моя музыка', title: 'Библиотека', sub: plural(artists.length, 'исполнитель', 'исполнителя', 'исполнителей'), art: false, compact: true }));
    libTabs(view, 'artists');
    view.appendChild(artistGrid(artists));
  },

  recent(view) {
    const ids = recentIds();
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Моя музыка', title: 'Библиотека', sub: ids.length ? `Последние ${tracksWord(ids.length)}, появившиеся в библиотеке` : 'Пока пусто', art: false, compact: true, actions: ids.length ? playActions() : '' }));
    bindPlayActions(view, ids);
    libTabs(view, 'recent');
    if (ids.length) currentList = new TrackList(view, ids);
  },

  album(view, v) {
    const a = index().albums.get(v.key);
    if (!a) return (view.innerHTML = '<div class="empty"><h2>Альбом не найден</h2></div>');
    const ids = sortedTracks(a.ids, 'album');
    view.insertAdjacentHTML('beforeend', head({
      kicker: 'Альбом', title: a.name, art: a.cover, artIcon: 'album', banner: a.cover || 'grad-6', editable: true,
      sub: `${artistLinks(a.artist)}${a.year ? ' · ' + a.year : ''} · ${summary(ids)}`,
      actions: playActions('', true),
    }));
    bindPlayActions(view, ids);
    coverEditable(view, ids, `${a.artist} ${a.name}`);
    view.insertAdjacentHTML('beforeend', '<div style="height:14px"></div>');
    currentList = new TrackList(view, ids, { noAlbum: true, trackNumbers: true });
  },

  artist(view, v) {
    const ar = index().artists.get(v.key);
    if (!ar) return (view.innerHTML = '<div class="empty"><h2>Исполнитель не найден</h2></div>');
    const ids = sortedTracks(ar.ids, 'default');
    const albums = Array.from(index().albums.values()).filter((a) => a.ids.some((id) => ar.ids.includes(id))).sort((a, b) => (b.year || 0) - (a.year || 0));
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Исполнитель', title: ar.name, art: ar.cover, artClass: 'round', artIcon: 'artist', banner: ar.cover || 'grad-6', editable: true, sub: `${summary(ids)}${albums.length ? ' · ' + plural(albums.length, 'альбом', 'альбома', 'альбомов') : ''}`, actions: playActions('', true) }));
    bindPlayActions(view, ids);
    view.querySelector('.view-head .art.editable')?.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      artistMenu(r.left + 20, r.bottom - 10, ar);
    });
    if (albums.length) rowSection(view, 'Альбомы', albums.map(albumItem));
    view.insertAdjacentHTML('beforeend', '<div class="section-title">Все треки</div>');
    currentList = new TrackList(view, ids);
  },

  liked(view) { smartView(view, likedIds(), { kicker: 'Избранное', title: 'Любимые треки', grad: 'grad-2', ic: 'heartFill', empty: 'Нажмите ♡ у трека, чтобы добавить его сюда' }); },
  top(view) { smartView(view, topIds(), { kicker: 'Подборка', title: 'Часто слушаю', grad: 'grad-4', ic: 'fire', empty: 'Слушайте музыку — здесь соберутся ваши хиты', sub: (ids) => `${tracksWord(ids.length)}, которые вы слушаете чаще всего` }); },
  history(view) { smartView(view, historyIds(), { kicker: 'Подборка', title: 'Недавно играли', grad: 'grad-5', ic: 'clock', empty: 'История прослушивания пока пуста' }); },

  playlists(view) {
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Моя музыка', title: 'Плейлисты', sub: S.playlists.length ? plural(S.playlists.length, 'плейлист', 'плейлиста', 'плейлистов') : 'У вас пока нет плейлистов', art: false, compact: true, actions: `<button class="btn primary round" id="pl-new">${icon('add')}Создать плейлист</button>` }));
    $('#pl-new').addEventListener('click', () => createPlaylist());
    const items = [...S.playlists.map(playlistItem), ...smartItems()];
    rowSection(view, 'Ваши плейлисты и подборки', items, { grid: true });
  },

  playlist(view, v) {
    const p = S.playlists.find((x) => x.id === v.id);
    if (!p) return navigate({ name: 'home' }, true);
    const ids = p.ids.filter((id) => S.tracks.has(id));
    const covers = coversOf(ids);
    view.insertAdjacentHTML('beforeend', head({
      kicker: 'Плейлист', title: p.name, art: covers[0] || null, artClass: covers.length ? '' : 'grad-1', artIcon: 'playlist', banner: covers[0] || 'grad-1',
      sub: ids.length ? summary(ids) : 'Плейлист пуст — добавьте треки через правый клик или перетащите их на плейлист в меню слева',
      actions: (ids.length ? playActions('', true) : '') + `<button class="circle-btn ghost-light" id="pl-rename" title="Переименовать">${icon('edit')}</button><button class="circle-btn ghost-light" id="pl-del" title="Удалить плейлист">${icon('trash')}</button>`,
    }));
    if (covers.length >= 4) {
      const art = view.querySelector('.view-head .art');
      art.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;overflow:hidden;';
      art.innerHTML = covers.map((c) => `<div style="${bg(c)};background-size:cover;background-position:center"></div>`).join('');
    }
    bindPlayActions(view, ids);
    $('#pl-rename').addEventListener('click', () => renamePlaylist(p));
    $('#pl-del').addEventListener('click', () => deletePlaylist(p));
    view.insertAdjacentHTML('beforeend', '<div style="height:14px"></div>');
    if (ids.length) currentList = new TrackList(view, ids);
  },

  radio(view) { renderRadio(view); },
  archive(view) { renderArchive(view); },
  archiveItem(view, v) { renderArchiveItem(view, v.key); },
  settings(view) { renderSettings(view); },
};

function smartView(view, ids, o) {
  const cover = coversOf(ids, 1)[0];
  view.insertAdjacentHTML('beforeend', head({ kicker: o.kicker, title: o.title, sub: ids.length ? (o.sub ? o.sub(ids) : summary(ids)) : o.empty, art: null, artClass: o.grad, artIcon: o.ic, banner: cover || o.grad, actions: ids.length ? playActions('', true) : '' }));
  bindPlayActions(view, ids);
  view.insertAdjacentHTML('beforeend', '<div style="height:14px"></div>');
  if (ids.length) currentList = new TrackList(view, ids);
}
function playlistItem(p) {
  const ids = p.ids.filter((id) => S.tracks.has(id));
  const covers = coversOf(ids);
  return { title: p.name, sub: tracksWord(ids.length), cover: covers[0], mosaic: covers, icon: 'playlist', grad: covers.length ? '' : 'grad-1', open: () => navigate({ name: 'playlist', id: p.id }), play: ids.length ? () => Player.playList(ids, 0) : null, ids: () => ids };
}
function smartItems() {
  const liked = likedIds(), top = topIds();
  return [
    { title: 'Любимые', sub: tracksWord(liked.length), overlay: true, grad: 'grad-2', icon: 'heartFill', mosaic: coversOf(liked), open: () => navigate({ name: 'liked' }), play: liked.length ? () => Player.playList(liked, 0) : null },
    { title: 'Часто слушаю', sub: tracksWord(top.length), overlay: true, grad: 'grad-4', icon: 'fire', mosaic: coversOf(top), open: () => navigate({ name: 'top' }), play: top.length ? () => Player.playList(top, 0) : null },
  ];
}

function albumGrid(albums, hideArtist = false) {
  const g = document.createElement('div');
  g.className = 'grid';
  g.innerHTML = albums.map((a) => `<div class="card" data-key="${esc(a.key)}">
    <div class="art" style="${bg(a.cover)}">${a.cover ? '' : icon('album')}</div>
    <button class="play-fab" data-play title="Слушать">${icon('play')}</button>
    <div class="t ell" title="${esc(a.name)}">${esc(a.name)}</div>
    <div class="s ell">${hideArtist ? (a.year || tracksWord(a.ids.length)) : esc(a.artist) + (a.year ? ' · ' + a.year : '')}</div></div>`).join('');
  g.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const a = index().albums.get(c.dataset.key);
    if (e.target.closest('[data-play]')) return Player.playList(sortedTracks(a.ids, 'album'), 0);
    navigate({ name: 'album', key: c.dataset.key });
  });
  g.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    e.preventDefault();
    trackMenu(e.clientX, e.clientY, sortedTracks(index().albums.get(c.dataset.key).ids, 'album'));
  });
  return g;
}

function artistGrid(artists) {
  const g = document.createElement('div');
  g.className = 'grid';
  g.innerHTML = artists.map((a) => `<div class="card" data-key="${esc(a.key)}">
    <div class="art round" style="${bg(a.cover)}">${a.cover ? '' : icon('artist')}</div>
    <button class="play-fab" data-play title="Слушать">${icon('play')}</button>
    <div class="t ell" style="text-align:center">${esc(a.name)}</div>
    <div class="s ell" style="text-align:center">${tracksWord(a.ids.length)}</div></div>`).join('');
  g.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    if (e.target.closest('[data-play]')) return Player.playList(sortedTracks(index().artists.get(c.dataset.key).ids, 'default'), 0);
    navigate({ name: 'artist', key: c.dataset.key });
  });
  g.addEventListener('contextmenu', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    e.preventDefault();
    artistMenu(e.clientX, e.clientY, index().artists.get(c.dataset.key));
  });
  return g;
}

// ---------- Поиск ----------
// Поиск на разных языках: «aromat» найдёт «аромат» и наоборот,
// а также текст, набранный не в той раскладке («фкщьфе» → «aromat», «ltdjxrf» → «девочка»)
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u' };
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const LAYOUT = {};
for (let i = 0; i < EN.length; i++) { LAYOUT[EN[i]] = RU[i]; LAYOUT[RU[i]] = EN[i]; }
const translitStr = (s) => s.replace(/[а-яёіїєґў]/g, (c) => TRANSLIT[c] ?? c);
// приводим к единой «латинской» форме: транслит кириллицы, без диакритики (é → e), c/k, h/kh, y/i/j, w/v
function foldText(s) {
  return translitStr(String(s || '').toLowerCase().replace(/ё/g, 'е'))
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/c/g, 'k').replace(/kh/g, 'h').replace(/[yj]/g, 'i').replace(/w/g, 'v').replace(/[^\p{L}\p{N}]+/gu, ' ');
}
const swapLayout = (w) => [...w].map((c) => LAYOUT[c] ?? c).join('');
function searchMatcher(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const variants = words.map((w) => [...new Set([w, swapLayout(w)].map((x) => foldText(x).trim()).filter(Boolean))]);
  return (raw) => {
    const low = raw.toLowerCase();
    const hay = foldText(raw);
    return words.every((w, i) => low.includes(w) || variants[i].some((v) => hay.includes(v)));
  };
}

function renderSearch(view) {
  const match = searchMatcher(S.search);
  const ids = [];
  for (const t of S.tracks.values()) {
    if (match(`${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre}`)) ids.push(t.id);
  }
  const albums = Array.from(index().albums.values()).filter((a) => match(`${a.name} ${a.artist}`)).slice(0, 12);
  const artists = Array.from(index().artists.values()).filter((a) => match(a.name)).slice(0, 12);
  view.insertAdjacentHTML('beforeend', head({ kicker: 'Поиск', title: `«${S.search.trim()}»`, art: false, compact: true, sub: ids.length || albums.length || artists.length ? `Найдено: ${tracksWord(ids.length)}` : 'Ничего не найдено', actions: ids.length ? playActions() : '' }));
  const sorted = sortedTracks(ids, 'default');
  bindPlayActions(view, sorted);
  if (artists.length) {
    view.insertAdjacentHTML('beforeend', '<div class="section-title">Исполнители</div>');
    view.appendChild(artistGrid(artists));
  }
  if (albums.length) {
    view.insertAdjacentHTML('beforeend', '<div class="section-title">Альбомы</div>');
    view.appendChild(albumGrid(albums));
  }
  if (sorted.length) {
    view.insertAdjacentHTML('beforeend', '<div class="section-title">Треки</div>');
    currentList = new TrackList(view, sorted);
  }
}
const onSearch = debounce(() => { S.selected.clear(); render(false); }, 180);
$('#search').addEventListener('input', (e) => {
  S.search = e.target.value;
  $('.search').classList.toggle('has-text', !!S.search);
  if (S.view.name === 'settings' || S.view.name === 'radio' || S.view.name === 'archive') {
    if (S.search.trim()) { S.history.push({ view: S.view, scroll: 0 }); S.view = { name: 'tracks' }; renderNav(); }
  }
  onSearch();
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; S.search = ''; $('.search').classList.remove('has-text'); render(false); e.target.blur(); }
  if (e.key === 'Enter' && currentList && currentList.ids.length) Player.playList(currentList.ids, 0);
});
$('#search-clear').addEventListener('click', () => { $('#search').value = ''; S.search = ''; $('.search').classList.remove('has-text'); render(false); });

// =====================================================================
//  Радио
// =====================================================================
const RADIO_TAGS = [
  ['', 'Популярные'], ['pop', 'Поп'], ['rock', 'Рок'], ['dance', 'Танцевальная'], ['electronic', 'Электроника'], ['hip hop', 'Хип-хоп'],
  ['rap', 'Рэп'], ['jazz', 'Джаз'], ['chillout', 'Чилаут'], ['lounge', 'Лаунж'], ['classical', 'Классика'], ['metal', 'Метал'],
  ['retro', 'Ретро'], ['80s', '80-е'], ['90s', '90-е'], ['lofi', 'Lo-fi'], ['ambient', 'Эмбиент'], ['news', 'Новости'],
];
const RADIO_COUNTRIES = [['', 'Все страны'], ['RU', 'Россия'], ['BY', 'Беларусь'], ['UA', 'Украина'], ['KZ', 'Казахстан'], ['US', 'США'], ['GB', 'Великобритания'], ['DE', 'Германия'], ['FR', 'Франция'], ['IT', 'Италия'], ['JP', 'Япония']];

function stationCard(st) {
  const fav = S.radioFavs.some((f) => f.id === st.id);
  const playing = Player.current?.id === 'r:' + st.id;
  return `<div class="station${playing ? ' playing' : ''}" data-id="${esc(st.id)}">
    <div class="logo-s">${st.favicon ? `<img src="${esc(st.favicon)}" loading="lazy" referrerpolicy="no-referrer"/>` : icon('radio')}</div>
    <div class="info"><div class="n ell" title="${esc(st.name)}">${esc(st.name)}</div>
    <div class="d ell">${esc([st.countrycode, st.tags.join(', '), st.bitrate ? st.bitrate + ' кбит/с' : ''].filter(Boolean).join(' · '))}</div></div>
    <button class="icon-btn small fav${fav ? ' on' : ''}" data-fav title="${fav ? 'Убрать из избранного' : 'В избранное'}">${icon(fav ? 'starFill' : 'star')}</button></div>`;
}

function renderRadio(view) {
  const R = S.radio;
  view.insertAdjacentHTML('beforeend', head({ kicker: 'Онлайн', title: 'Интернет-радио', sub: 'Тысячи бесплатных станций со всего мира · каталог Radio Browser', art: null, artClass: 'grad-3', artIcon: 'radio' }));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="radio-filters">
      <input class="input" id="r-q" placeholder="Название станции…" value="${esc(R.query)}" style="width:240px" spellcheck="false"/>
      <select class="select" id="r-country">${RADIO_COUNTRIES.map(([c, n]) => `<option value="${c}" ${c === R.country ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="radio-filters">${RADIO_TAGS.map(([t, n]) => `<button class="chip${t === R.tag ? ' active' : ''}" data-tag="${t}">${n}</button>`).join('')}</div>
    ${S.radioFavs.length ? `<div class="section-title">Избранные станции</div><div class="station-grid" id="r-favs">${S.radioFavs.map(stationCard).join('')}</div>` : ''}
    <div class="section-title">${R.query ? 'Результаты поиска' : R.tag ? 'Станции: ' + esc(RADIO_TAGS.find((x) => x[0] === R.tag)?.[1] || R.tag) : 'Популярные станции'}</div>
    <div id="r-results"></div>`;
  view.appendChild(wrap);
  const results = $('#r-results');
  const draw = () => {
    if (R.loading) results.innerHTML = '<div class="scan-status" style="padding:20px 0"><div class="spinner"></div>Загружаю станции…</div>';
    else if (R.results === null) results.innerHTML = '';
    else if (R.results === false) results.innerHTML = '<div class="empty" style="padding:30px"><p>Не удалось загрузить список станций. Проверьте подключение к интернету.</p><button class="btn" id="r-retry">Повторить</button></div>';
    else if (!R.results.length) results.innerHTML = '<div class="empty" style="padding:30px"><p>Ничего не найдено. Попробуйте другой запрос или страну.</p></div>';
    else results.innerHTML = `<div class="station-grid">${R.results.map(stationCard).join('')}</div>`;
    $('#r-retry')?.addEventListener('click', load);
  };
  const load = async () => {
    R.loading = true;
    draw();
    const key = JSON.stringify([R.query, R.tag, R.country]);
    R.key = key;
    const res = await window.api.radioSearch({ name: R.query, tag: R.tag, countrycode: R.country, limit: 80 });
    if (R.key !== key) return;
    R.loading = false;
    R.results = res ? res.filter((s) => s.url) : false;
    if (S.view.name === 'radio') draw();
  };
  wrap.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag]');
    if (chip) { R.tag = chip.dataset.tag; R.results = null; return render(true); }
    const card = e.target.closest('.station');
    if (!card) return;
    const st = [...(R.results || []), ...S.radioFavs].find((s) => s.id === card.dataset.id);
    if (!st) return;
    if (e.target.closest('[data-fav]')) {
      const i = S.radioFavs.findIndex((f) => f.id === st.id);
      if (i >= 0) S.radioFavs.splice(i, 1); else S.radioFavs.push(st);
      saveRadioFavs();
      return render(true);
    }
    if (Player.current?.id === 'r:' + st.id) return Player.toggle();
    Player.playStation(st);
    $$('.station').forEach((s) => s.classList.toggle('playing', s.dataset.id === st.id));
  });
  wrap.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.replaceWith(Object.assign(document.createElement('div'), { innerHTML: icon('radio') }).firstChild); }, true);
  const q = $('#r-q');
  q.addEventListener('input', debounce(() => { R.query = q.value.trim(); R.results = null; load(); view.querySelector('.section-title:last-of-type').textContent = R.query ? 'Результаты поиска' : 'Популярные станции'; }, 450));
  $('#r-country').addEventListener('change', (e) => { R.country = e.target.value; R.results = null; load(); });
  if (R.results === null) load(); else draw();
}

// =====================================================================
//  Internet Archive
// =====================================================================
const IA_CATEGORIES = [
  ['free', 'Свободная музыка', 'Независимые музыканты и нетлейблы под лицензиями Creative Commons — можно слушать и скачивать бесплатно.'],
  ['live', 'Живые концерты', 'Записи концертов групп, которые разрешают их распространять (Grateful Dead, Phish и тысячи других).'],
  ['old', 'Старые записи', 'Граммофонные пластинки 1890–1923 годов — общественное достояние: блюз, джаз, опера, оркестры.'],
  ['classic', 'Классика', 'Записи Musopen: Бах, Шопен, Бетховен и другие — общественное достояние.'],
];

function renderArchive(view) {
  const A = S.archive;
  const cat = IA_CATEGORIES.find((c) => c[0] === A.cat) || IA_CATEGORIES[0];
  view.insertAdjacentHTML('beforeend', head({ kicker: 'Онлайн · archive.org', title: 'Internet Archive', sub: 'Музыка, которую можно законно слушать и скачивать бесплатно: свободные лицензии и общественное достояние', art: null, artClass: 'grad-3', artIcon: 'globe', banner: 'grad-3' }));
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="radio-filters">
      <input class="input" id="ia-q" placeholder="Поиск по архиву (лучше на английском)…" value="${esc(A.query)}" style="width:320px" spellcheck="false"/>
      <div class="seg"><button data-sort="downloads" class="${A.sort !== 'new' ? 'on' : ''}">Популярное</button><button data-sort="new" class="${A.sort === 'new' ? 'on' : ''}">Новое</button></div>
    </div>
    <div class="radio-filters">${IA_CATEGORIES.map(([k, n]) => `<button class="chip${k === A.cat ? ' active' : ''}" data-cat="${k}">${n}</button>`).join('')}</div>
    <div class="ia-desc">${esc(cat[2])}</div>
    <div id="ia-res"></div>`;
  view.appendChild(wrap);
  const res = wrap.querySelector('#ia-res');
  const draw = () => {
    if (A.items === false) { res.innerHTML = '<div class="empty" style="padding:30px"><p>Не удалось загрузить архив. Проверьте подключение к интернету.</p><button class="btn" id="ia-retry">Повторить</button></div>'; res.querySelector('#ia-retry').onclick = () => load(1); return; }
    if (!A.items) { res.innerHTML = '<div class="scan-status" style="padding:20px 0"><div class="spinner"></div>Загружаю…</div>'; return; }
    if (!A.items.length) { res.innerHTML = '<div class="empty" style="padding:30px"><p>Ничего не найдено. Попробуйте другой запрос — архив лучше понимает английский.</p></div>'; return; }
    const items = A.items.map((x) => ({
      title: x.title, sub: [x.creator, x.year].filter(Boolean).join(' · '), cover: x.cover, icon: 'globe',
      open: () => navigate({ name: 'archiveItem', key: x.id }),
      play: () => playArchive(x.id, 0),
    }));
    res.innerHTML = `<div class="section-title"><span>${esc(cat[1])}</span><small>${A.total.toLocaleString('ru')} записей</small></div><div class="grid">${items.map(cardHtml).join('')}</div>${A.items.length < A.total ? `<div style="text-align:center;margin:24px 0"><button class="btn" id="ia-more">${A.loading ? 'Загружаю…' : 'Показать ещё'}</button></div>` : ''}`;
    bindCards(res, items);
    res.querySelector('#ia-more')?.addEventListener('click', () => !A.loading && load(A.page + 1));
  };
  const load = async (page) => {
    A.loading = true;
    if (page === 1) A.items = null;
    draw();
    const key = JSON.stringify([A.cat, A.query, A.sort, page]);
    A.key = key;
    const r = await window.api.iaSearch({ category: A.cat, query: A.query, page, sort: A.sort });
    if (A.key !== key) return;
    A.loading = false;
    if (!r) { if (page === 1) A.items = false; }
    else { A.items = page === 1 ? r.items : [...(A.items || []), ...r.items]; A.total = r.total; A.page = page; }
    if (S.view.name === 'archive') draw();
  };
  wrap.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) { A.cat = c.dataset.cat; A.items = null; return render(false); }
    const so = e.target.closest('[data-sort]');
    if (so) { A.sort = so.dataset.sort; A.items = null; return render(false); }
  });
  const q = wrap.querySelector('#ia-q');
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { A.query = q.value.trim(); load(1); } });
  q.addEventListener('input', debounce(() => { if (q.value.trim() !== A.query) { A.query = q.value.trim(); load(1); } }, 700));
  if (A.items === null || A.items === undefined) load(1); else draw();
}

async function loadIaItem(id) {
  let it = S.iaItems.get(id);
  if (!it) {
    it = await window.api.iaItem(id);
    if (!it) return null;
    S.iaItems.set(id, it);
  }
  for (const t of it.tracks) S.online.set(t.id, t);
  return it;
}
async function playArchive(id, start, shuffle) {
  const it = await loadIaItem(id);
  if (!it || !it.tracks.length) return toast('В этой записи нет аудиофайлов');
  Player.playList(it.tracks.map((t) => t.id), start, shuffle ? { shuffle: true, randomStart: true } : { shuffle: false });
}
function markIaPlaying() {
  const id = Player.current?.id;
  $$('.ia-row').forEach((r) => r.classList.toggle('playing', r.dataset.id === id));
}
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ');

async function renderArchiveItem(view, id) {
  view.innerHTML = '<div class="panel-empty" style="padding:80px"><div class="spinner" style="margin:0 auto 14px"></div>Загружаю запись из архива…</div>';
  const it = await loadIaItem(id);
  if (!(S.view.name === 'archiveItem' && S.view.key === id)) return;
  view.innerHTML = '';
  if (!it) return (view.innerHTML = '<div class="empty"><h2>Не удалось загрузить запись</h2><p>Проверьте подключение к интернету и попробуйте ещё раз.</p></div>');
  const total = it.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const size = it.tracks.reduce((a, t) => a + (t.size || 0), 0);
  const lic = it.license ? (/publicdomain/.test(it.license) ? 'общественное достояние' : /creativecommons/.test(it.license) ? 'лицензия Creative Commons' : 'лицензия') : '';
  view.insertAdjacentHTML('beforeend', head({
    kicker: 'Internet Archive', title: it.title, art: it.cover, banner: it.cover,
    sub: `${esc([it.creator, it.year].filter(Boolean).join(' · '))}${it.tracks.length ? ' · ' + tracksWord(it.tracks.length) + (total ? ' · ' + fmtTotal(total) : '') : ''}${lic ? ` · <span class="link" data-ext="${esc(it.license)}">${lic}</span>` : ''}`,
    actions: (it.tracks.length ? playActions(`<button class="btn ghost-light round" id="ia-dl-all">${icon('folder')}Скачать в библиотеку${size ? ' · ' + fmtSize(size) : ''}</button>`, true) : '') + `<button class="circle-btn ghost-light" id="ia-page" title="Открыть на archive.org">${icon('web')}</button>`,
  }));
  view.querySelector('[data-act="play"]')?.addEventListener('click', () => playArchive(id, 0));
  view.querySelector('[data-act="shuffle"]')?.addEventListener('click', () => playArchive(id, 0, true));
  view.querySelector('#ia-page').addEventListener('click', () => window.api.openExternal(it.page));
  view.querySelector('[data-ext]')?.addEventListener('click', (e) => window.api.openExternal(e.currentTarget.dataset.ext.replace(/^http:/, 'https:')));
  view.querySelector('#ia-dl-all')?.addEventListener('click', () => {
    confirmBox('Скачать всю запись?', `${tracksWord(it.tracks.length)}${size ? ', около ' + fmtSize(size) : ''} будут сохранены в папку «Internet Archive» внутри вашей папки с музыкой и появятся в библиотеке.`, 'Скачать', () => downloadIa(it.tracks));
  });
  if (it.description) view.insertAdjacentHTML('beforeend', `<div class="ia-about glass-box">${esc(it.description)}</div>`);
  if (!it.tracks.length) return view.insertAdjacentHTML('beforeend', '<div class="empty"><p>В этой записи нет аудиофайлов, которые можно воспроизвести.</p></div>');
  const list = document.createElement('div');
  list.className = 'tlist ia-list';
  list.innerHTML = it.tracks.map((t, i) => `<div class="ia-row" data-i="${i}" data-id="${esc(t.id)}">
      <div class="c-num"><span class="n">${t.trackNo || i + 1}</span>${icon('play', 'pl')}<span class="bars"><span></span><span></span><span></span></span></div>
      <div class="meta"><div class="t ell" title="${esc(t.title)}">${esc(t.title)}</div><div class="a ell">${esc(t.artist)}</div></div>
      <div class="c-dur">${t.duration ? fmtTime(t.duration) : ''}</div>
      <button class="icon-btn small" data-dl title="Скачать в библиотеку${t.size ? ' · ' + fmtSize(t.size) : ''}">${icon('add')}</button>
    </div>`).join('');
  view.appendChild(list);
  markIaPlaying();
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ia-row');
    if (!row) return;
    const i = +row.dataset.i;
    if (e.target.closest('[data-dl]')) return downloadIa([it.tracks[i]]);
    if (Player.current?.id === row.dataset.id) return Player.toggle();
    playArchive(id, i);
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.ia-row');
    if (!row) return;
    e.preventDefault();
    const t = it.tracks[+row.dataset.i];
    openMenu(e.clientX, e.clientY, [
      { label: 'Воспроизвести', icon: 'play', action: () => playArchive(id, +row.dataset.i) },
      { label: 'Играть следующим', icon: 'next', action: () => Player.playNext([t.id]) },
      { label: 'Добавить в очередь', icon: 'queue', action: () => Player.addToQueue([t.id]) },
      '-',
      { label: 'Скачать в библиотеку', icon: 'folder', action: () => downloadIa([t]) },
    ]);
  });
}

async function downloadIa(tracks) {
  toast(tracks.length > 1 ? `Скачиваю ${tracksWord(tracks.length)}…` : `Скачиваю «${tracks[0].title}»…`);
  const r = await window.api.iaDownload(tracks.map((t) => ({ id: t.id, url: t.url, name: t.name, artist: t.artist, album: t.album })));
  if (r.saved.length) toast(`Сохранено в библиотеку: ${tracksWord(r.saved.length)}`);
  if (r.saved.length < tracks.length) toast(`Не удалось скачать: ${tracksWord(tracks.length - r.saved.length)}`);
  S.folders = (await window.api.init()).folders;
}
window.api.onIaProgress((p) => {
  const row = $$('.ia-row').find((r) => r.dataset.id === p.id);
  const btn = row && row.querySelector('[data-dl]');
  if (!btn) return;
  if (p.error) { btn.innerHTML = icon('close'); btn.title = 'Ошибка: ' + p.error; return; }
  if (p.finished) { btn.innerHTML = icon('check'); btn.classList.add('active'); btn.title = 'Сохранено в библиотеку'; return; }
  if (p.total) btn.textContent = Math.floor((p.done / p.total) * 100) + '%';
});

// =====================================================================
//  Настройки
// =====================================================================
const ACCENTS = ['#ffffff', '#7c5cff', '#2d7cf6', '#1db97a', '#ff5c8a', '#ff8a3d', '#e5484d', '#00b3c7', '#c084fc'];
function renderSettings(view) {
  const st = S.settings;
  const sw = (key, on) => `<button class="switch${on ? ' on' : ''}" data-switch="${key}"></button>`;
  const albums = index().albums.size;
  view.insertAdjacentHTML('beforeend', head({ title: 'Настройки', art: false, compact: true }));
  const el = document.createElement('div');
  el.className = 'settings';
  el.innerHTML = `
    <div class="set-group">
      <h3>Папки с музыкой</h3>
      <div class="desc">Tembr следит за этими папками: новые файлы появляются в библиотеке сами, удалённые — исчезают. Подойдут и папки, синхронизируемые с OneDrive, Google Drive или Яндекс Диском.</div>
      ${S.folders.map((f) => `<div class="set-row folder-row">${icon('folder')}<div class="l"><b class="ell" title="${esc(f)}">${esc(f)}</b></div><button class="icon-btn small" data-open="${esc(f)}" title="Открыть">${icon('expand')}</button><button class="icon-btn small" data-rm="${esc(f)}" title="Не отслеживать">${icon('trash')}</button></div>`).join('')}
      <div class="set-row"><div class="l"><small>${tracksWord(S.tracks.size)} · ${plural(albums, 'альбом', 'альбома', 'альбомов')}${S.progress.scanning ? ' · сканирование…' : ''}</small></div>
        <button class="btn" id="s-rescan">${icon('refresh')}Пересканировать</button>
        <button class="btn" id="s-files">${icon('add')}Файлы</button>
        <button class="btn primary" id="s-add">${icon('folder')}Добавить папку</button></div>
    </div>
    <div class="set-group">
      <h3>Интернет</h3>
      <div class="set-row"><div class="l"><b>Искать обложки автоматически</b><small>Если у трека нет обложки, Tembr найдёт её по названию (Deezer, Яндекс Музыка, Apple Music, Genius, MusicBrainz). Клик по пустой обложке — выбрать вручную</small></div>${sw('autoCovers', st.autoCovers)}</div>
      <div class="set-row"><div class="l"><b>Тексты песен</b><small>Загружаются из LRCLIB (с таймингами) и Genius при открытии панели «Текст». Свой текст можно вставить вручную.</small></div></div>
      <div class="set-row"><div class="l"><b>Повторить поиск</b><small>Сбросить кэш ненайденных обложек и текстов и поискать заново</small></div><button class="btn" id="s-cache">Сбросить</button></div>
    </div>
    <div class="set-group">
      <h3>Оформление</h3>
      <div class="set-row"><div class="l"><b>Тема</b></div><div class="seg"><button data-theme="dark" class="${st.theme !== 'light' ? 'on' : ''}">Тёмная</button><button data-theme="light" class="${st.theme === 'light' ? 'on' : ''}">Светлая</button></div></div>
      <div class="set-row"><div class="l"><b>Акцентный цвет</b></div><div class="swatches">${ACCENTS.map((c) => `<button class="swatch${c === st.accent ? ' on' : ''}" data-accent="${c}" style="background:${c}" title="${c === '#ffffff' ? 'Белый (в светлой теме — чёрный)' : ''}"></button>`).join('')}</div></div>
    </div>
    <div class="set-group">
      <h3>Поведение</h3>
      <div class="set-row"><div class="l"><b>Сворачивать в трей при закрытии</b><small>Музыка продолжит играть, плеер останется в области уведомлений</small></div>${sw('closeToTray', st.closeToTray)}</div>
    </div>
    <div class="set-group">
      <h3>Горячие клавиши</h3>
      <div class="keys">
        <kbd>Пробел</kbd><span>Играть / пауза</span>
        <kbd>Ctrl + → / ←</kbd><span>Следующий / предыдущий трек</span>
        <kbd>→ / ←</kbd><span>Перемотка на 5 секунд</span>
        <kbd>Ctrl + ↑ / ↓</kbd><span>Громкость</span>
        <kbd>M</kbd><span>Выключить звук</span>
        <kbd>S / R</kbd><span>Перемешивание / повтор</span>
        <kbd>L</kbd><span>Добавить текущий трек в любимые</span>
        <kbd>Ctrl + F</kbd><span>Поиск</span>
        <kbd>Ctrl + L / Q / E</kbd><span>Текст песни / очередь / эквалайзер</span>
        <kbd>Ctrl + M</kbd><span>Мини-плеер</span>
        <kbd>Медиаклавиши</kbd><span>Работают и когда окно свёрнуто</span>
      </div>
    </div>
    <div class="set-group">
      <h3>О программе</h3>
      <div class="set-row"><div class="l"><b>Tembr ${esc(S.version)}</b><small>Данные: ${esc(S.dataDir)}</small></div><button class="btn" id="s-data">Открыть папку данных</button></div>
      <div class="set-row"><div class="l"><b>Обновления</b><small class="upd-status" id="upd-status">${esc(updateText())}</small></div>${S.update.state === 'ready' ? `<button class="btn primary" id="s-upd-install">Перезапустить и обновить</button>` : `<button class="btn" id="s-upd">${icon('refresh')}Проверить</button>`}</div>
    </div>`;
  view.appendChild(el);
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.switch) { setSetting({ [t.dataset.switch]: !S.settings[t.dataset.switch] }); t.classList.toggle('on'); return; }
    if (t.dataset.theme) { setSetting({ theme: t.dataset.theme }); applyTheme(); return render(true); }
    if (t.dataset.accent) { setSetting({ accent: t.dataset.accent }); applyTheme(); return render(true); }
    if (t.dataset.rm) {
      const f = t.dataset.rm;
      return confirmBox('Не отслеживать папку?', `Треки из «${f}» пропадут из библиотеки. Сами файлы на диске не удаляются.`, 'Убрать', async () => {
        S.folders = await window.api.removeFolder(f);
        render(true);
      });
    }
    if (t.dataset.open) return window.api.openPath(t.dataset.open);
    if (t.id === 's-add') return addFolder();
    if (t.id === 's-files') return addFiles();
    if (t.id === 's-rescan') { toast('Сканирую папки…'); await window.api.rescan(); toast('Готово'); return; }
    if (t.id === 's-cache') { await window.api.clearCache(); Lyrics.cache.clear(); toast('Кэш сброшен — ищу заново'); return; }
    if (t.id === 's-data') return window.api.openPath(S.dataDir);
    if (t.id === 's-upd') { S.update = await window.api.updateCheck(); return render(true); }
    if (t.id === 's-upd-install') return window.api.updateInstall();
  });
}

// Белый акцент: в тёмной теме белый, в светлой — почти чёрный (белое на светлом не видно)
function effectiveAccent(accent, theme) {
  const a = (accent || '#7c5cff').toLowerCase();
  if (a === '#ffffff' && theme === 'light') return '#1c1f3b';
  return a;
}
function isLightColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}
function applyTheme() {
  const theme = S.settings.theme === 'light' ? 'light' : 'dark';
  const acc = effectiveAccent(S.settings.accent, theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--accent', acc);
  document.documentElement.style.setProperty('--on-accent', isLightColor(acc) ? '#111114' : '#ffffff');
  document.documentElement.style.setProperty('--accent-2', acc === '#ffffff' ? '#9a9aa2' : acc === '#1c1f3b' ? '#55597a' : '');
  if (!document.documentElement.style.getPropertyValue('--accent-2')) document.documentElement.style.removeProperty('--accent-2');
}

// =====================================================================
//  Эквалайзер
// =====================================================================
function openEq() {
  const eq = S.settings.eq;
  const label = (f) => (f >= 1000 ? f / 1000 + 'k' : f);
  const fmtDb = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(0);
  modal(`<h2>Эквалайзер <button class="switch${eq.enabled ? ' on' : ''}" id="eq-on" title="Вкл/выкл"></button></h2>
    <div class="eq-presets">${Object.entries(EQ_PRESETS).map(([k, p]) => `<button class="chip${eq.preset === k ? ' active' : ''}" data-preset="${k}">${p.name}</button>`).join('')}</div>
    <div class="eq-bands">
      <div class="eq-band pre"><span class="v" id="pre-v">${fmtDb(eq.preamp)}</span><input type="range" class="vslider" min="-12" max="12" step="1" value="${eq.preamp}" id="eq-pre"/><span class="f">Усил.</span></div>
      ${EQ_FREQS.map((f, i) => `<div class="eq-band"><span class="v">${fmtDb(eq.bands[i])}</span><input type="range" class="vslider" min="-12" max="12" step="1" value="${eq.bands[i]}" data-band="${i}"/><span class="f">${label(f)}</span></div>`).join('')}
    </div>
    <div class="row"><button class="btn" id="eq-reset">Сбросить</button><button class="btn primary" data-close>Готово</button></div>`, (m) => {
    m.classList.toggle('eq-disabled', !eq.enabled);
    const commit = () => { setSetting({ eq: S.settings.eq }); Player.applyEq(); updateControls(); };
    const sync = () => {
      m.querySelectorAll('[data-band]').forEach((r) => { r.value = eq.bands[+r.dataset.band]; r.previousElementSibling.textContent = fmtDb(r.value); });
      m.querySelector('#eq-pre').value = eq.preamp;
      m.querySelector('#pre-v').textContent = fmtDb(eq.preamp);
      m.querySelectorAll('[data-preset]').forEach((c) => c.classList.toggle('active', c.dataset.preset === eq.preset));
    };
    m.querySelector('#eq-on').addEventListener('click', (e) => {
      eq.enabled = !eq.enabled;
      e.target.classList.toggle('on', eq.enabled);
      m.classList.toggle('eq-disabled', !eq.enabled);
      Player.initGraph();
      commit();
    });
    m.addEventListener('input', (e) => {
      const r = e.target;
      if (r.dataset.band !== undefined) { eq.bands[+r.dataset.band] = +r.value; eq.preset = 'custom'; }
      else if (r.id === 'eq-pre') eq.preamp = +r.value;
      else return;
      if (!eq.enabled) { eq.enabled = true; m.querySelector('#eq-on').classList.add('on'); m.classList.remove('eq-disabled'); }
      Player.initGraph();
      sync();
      commit();
    });
    m.addEventListener('click', (e) => {
      const p = e.target.closest('[data-preset]');
      if (p) {
        eq.bands = EQ_PRESETS[p.dataset.preset].bands.slice();
        eq.preset = p.dataset.preset;
        eq.enabled = true;
        m.querySelector('#eq-on').classList.add('on');
        m.classList.remove('eq-disabled');
        Player.initGraph();
        sync();
        commit();
      }
      if (e.target.id === 'eq-reset') { eq.bands = EQ_PRESETS.flat.bands.slice(); eq.preamp = 0; eq.preset = 'flat'; sync(); commit(); }
    });
  });
}

// =====================================================================
//  Правая панель: текст песни и очередь
// =====================================================================
// toggle=true: повторный выбор той же вкладки скрывает панель
function setPanel(name, toggle = true) {
  if (name === null) S.panel = null;
  else if (toggle && S.panel === name) S.panel = null;
  else S.panel = name;
  if (S.panel) S.panelTab = S.panel;
  document.body.classList.toggle('panel-closed', !S.panel);
  setSettingDebounced({ panel: S.panel || 'closed' });
  $$('.panel-tabs [data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === S.panel));
  updateControls();
  renderPanelBody();
  currentList?.refresh();
}
function renderPanelBody() {
  if (S.panel === 'lyrics') Lyrics.render();
  else if (S.panel === 'queue') renderQueuePanel();
  else if (S.panel === 'similar') renderSimilar();
}
$('.panel-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-panel]');
  if (b && b.dataset.panel !== S.panel) setPanel(b.dataset.panel, false);
});
$('#panel-close').addEventListener('click', () => setPanel(null));

// ---------- Похожие треки ----------
function similarIds(t, n = 20) {
  const out = [];
  const add = (id) => { if (id !== t.id && !out.includes(id) && S.tracks.has(id)) out.push(id); };
  const ar = index().artists.get(primaryArtist(t).toLowerCase());
  const curAlbum = albumKey(t);
  // Тот же исполнитель, но другие альбомы — в первую очередь
  if (ar) shuffleArr(ar.ids.filter((id) => albumKey(S.tracks.get(id)) !== curAlbum)).forEach(add);
  if (t.genre) shuffleArr(Array.from(S.tracks.values()).filter((x) => x.genre && x.genre.toLowerCase() === t.genre.toLowerCase()).map((x) => x.id)).forEach((id) => out.length < n && add(id));
  if (ar) ar.ids.forEach((id) => out.length < n && add(id));
  if (out.length < 6) shuffleArr(likedIds().slice()).forEach((id) => out.length < 10 && add(id));
  if (out.length < 6) shuffleArr(Array.from(S.tracks.keys())).forEach((id) => out.length < 12 && add(id));
  return out.slice(0, n);
}
let similarFor = null, similarList = [];
function renderSimilar(force) {
  if (S.panel !== 'similar') return;
  const body = $('#panel-body');
  const c = Player.current;
  if (!c || c.kind !== 'track') {
    similarFor = null;
    const pool = shuffleArr(Array.from(S.tracks.keys())).slice(0, 12);
    similarList = pool;
    body.innerHTML = pool.length ? `<div class="q-section">Попробуйте послушать</div>${pool.map((id) => simItem(id)).join('')}` : `<div class="panel-empty">${icon('music')}Добавьте музыку, и здесь появятся рекомендации</div>`;
    return;
  }
  if (similarFor !== c.id || force) { similarFor = c.id; similarList = similarIds(c.track); }
  body.innerHTML = similarList.length
    ? `<div class="q-section">${S.tracks.size > 30 ? 'Похожие треки' : 'Вам может понравиться'}<button id="sim-play">Слушать все</button></div>${similarList.map((id) => simItem(id)).join('')}`
    : `<div class="panel-empty">${icon('sparkle')}Похожих треков в библиотеке пока нет.<br/><small style="color:var(--text-3)">Чем больше музыки — тем точнее подборка.</small></div>`;
}
function simItem(id) {
  const t = S.tracks.get(id);
  if (!t) return '';
  return `<div class="q-item" data-sim="${esc(id)}"><div class="cv" style="${bg(t.cover)}">${t.cover ? '' : icon('music')}</div><div class="meta"><div class="t ell">${esc(t.title)}</div><div class="a ell">${esc(artistOf(t))}</div></div><button class="icon-btn small add" data-add title="Добавить в очередь">${icon('add')}</button></div>`;
}

// ---------- Текст песни ----------
const Lyrics = {
  cache: new Map(),
  lines: null,
  active: -1,
  lastUserScroll: 0,

  parseLrc(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
      if (!stamps.length) continue;
      const line = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const s of stamps) out.push({ t: +s[1] * 60 + parseFloat(s[2].replace(':', '.')), text: line });
    }
    return out.sort((a, b) => a.t - b.t);
  },

  onTrack() {
    this.lines = null;
    this.active = -1;
    if (S.panel === 'lyrics') this.render();
  },

  async load(t) {
    let data = await window.api.lyrics({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration });
    if (data && data.retry) return t.lyrics ? (/\[\d+:\d+/.test(t.lyrics) ? { synced: t.lyrics, source: 'файл трека' } : { plain: t.lyrics, source: 'файл трека' }) : data;
    if (!data && t.lyrics) data = /\[\d+:\d+/.test(t.lyrics) ? { synced: t.lyrics, source: 'файл трека' } : { plain: t.lyrics, source: 'файл трека' };
    return data || { none: true };
  },

  async render() {
    if (S.panel !== 'lyrics') return;
    const body = $('#panel-body');
    const c = Player.current;
    this.lines = null;
    this.active = -1;
    if (!c) return (body.innerHTML = `<div class="panel-empty">${icon('lyrics')}Включите трек, и здесь появится его текст</div>`);
    if (c.kind === 'radio') return (body.innerHTML = `<div class="panel-empty">${icon('radio')}Для радио тексты песен недоступны</div>`);
    const t = c.track;
    let data = this.cache.get(t.id);
    if (!data) {
      body.innerHTML = `<div class="panel-empty"><div class="spinner" style="margin:0 auto 14px"></div>Ищу текст песни…</div>`;
      data = await this.load(t);
      if (!data.retry) this.cache.set(t.id, data);
      if (Player.current?.id !== t.id || S.panel !== 'lyrics') return;
    }
    const src = `<div class="lyrics-src"><span>Источник: ${esc(data.source || 'LRCLIB')}</span><button data-ly="search">Другой вариант</button>${data.manual ? '<button data-ly="reset">Сбросить</button>' : '<button data-ly="paste">Свой текст</button>'}</div>`;
    if (data.retry) return (body.innerHTML = `<div class="panel-empty">${icon('web')}Не удалось связаться с сервисом текстов. Проверьте интернет.<div class="acts"><button class="btn" data-ly="retry">${icon('refresh')}Повторить</button></div></div>`);
    if (data.instrumental) return (body.innerHTML = `<div class="panel-empty">${icon('music')}Это инструментальная композиция ♪</div>${src}`);
    if (data.synced) {
      this.lines = this.parseLrc(data.synced);
      body.innerHTML = `<div class="lyrics">${this.lines.map((l, i) => `<div class="line" data-i="${i}">${esc(l.text) || '♪'}</div>`).join('')}</div>${src}`;
      this.tick(true);
      return;
    }
    if (data.plain) {
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : t.duration;
      if (S.settings.approxLyrics !== false && dur > 20) {
        this.lines = this.approximate(data.plain, dur);
        const srcA = src.replace('</div>', '<span>· подсветка примерная</span><button data-ly="approx-off">Без подсветки</button></div>');
        body.innerHTML = `<div class="lyrics approx">${this.lines.map((l, i) => `<div class="line${l.gap ? ' gap' : ''}${l.tag ? ' tag' : ''}" data-i="${i}">${esc(l.text)}</div>`).join('')}</div>${srcA}`;
        this.tick(true);
        return;
      }
      const srcP = src.replace('</div>', '<button data-ly="approx-on">Подсвечивать строки</button></div>');
      body.innerHTML = `<div class="lyrics plain">${esc(data.plain)}</div>${srcP}`;
      return;
    }
    body.innerHTML = `<div class="panel-empty">${icon('lyrics')}<b>Текст не найден</b><br/><small style="color:var(--text-3)">В открытой базе LRCLIB нет этой песни. Можно поискать по-другому или вставить текст самому — он сохранится.</small>
      <div class="acts">
        <button class="btn" data-ly="search">${icon('search')}Найти вручную</button>
        <button class="btn" data-ly="paste">${icon('paste')}Вставить текст</button>
        <button class="btn" data-ly="web">${icon('web')}Искать в интернете</button>
      </div></div>`;
  },

  // Текст без таймингов: раскладываем строки по длительности трека пропорционально их длине
  approximate(text, dur) {
    const raw = text.split(/\r?\n/);
    const lines = [];
    let gap = false;
    for (const r of raw) {
      const l = r.trim();
      if (!l) { gap = lines.length > 0; continue; }
      const tag = /^\[.*\]$/.test(l);
      lines.push({ text: l, gap, tag, w: tag ? 2 : l.length + 12 });
      gap = false;
    }
    const start = Math.min(dur * 0.06, 12), end = dur * 0.96;
    const total = lines.reduce((s, l) => s + l.w, 0) || 1;
    let acc = 0;
    for (const l of lines) { l.t = start + (end - start) * (acc / total); acc += l.w; }
    return lines;
  },

  tick(force) {
    if (!this.lines || S.panel !== 'lyrics') return;
    const ct = audio.currentTime + 0.25;
    let i = -1;
    for (let k = 0; k < this.lines.length; k++) { if (this.lines[k].t <= ct) i = k; else break; }
    if (i === this.active && !force) return;
    this.active = i;
    const els = $$('#panel-body .line');
    els.forEach((el, k) => { el.classList.toggle('active', k === i); el.classList.toggle('past', k < i); });
    if (i >= 0 && Date.now() - this.lastUserScroll > 3000) els[i]?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  },

  async save(t, data) {
    await window.api.lyricsSet(t.id, data);
    this.cache.delete(t.id);
    if (Player.current?.id === t.id) this.render();
  },

  searchModal(t) {
    const q0 = `${primaryArtist(t) === UNKNOWN_ARTIST ? '' : primaryArtist(t)} ${t.title}`.trim();
    modal(`<h2>Найти текст песни</h2><div class="hint">Поиск по LRCLIB (тексты с таймингами) и Genius. Попробуйте изменить запрос: только название, другое написание исполнителя, латиницу/кириллицу.</div>
      <div class="search-row"><input class="input" id="lq" value="${esc(q0)}" spellcheck="false"/><button class="btn primary" id="lgo">${icon('search')}Найти</button></div>
      <div class="ly-list" id="lres"></div>
      <div class="row"><button class="btn" data-close>Закрыть</button></div>`, (m, close) => {
      let results = [];
      const run = async () => {
        const box = m.querySelector('#lres');
        box.innerHTML = '<div class="scan-status" style="padding:10px"><div class="spinner"></div>Ищу…</div>';
        results = await window.api.lyricsSearch(m.querySelector('#lq').value);
        box.innerHTML = results.length ? results.map((r, i) => `<div class="ly-item" data-i="${i}"><div class="meta"><div class="t ell">${esc(r.title)}</div><div class="s ell">${esc([r.artist, r.album, r.duration ? fmtTime(r.duration) : ''].filter(Boolean).join(' · '))}</div></div><span class="badge">${r.geniusUrl ? 'Genius' : r.synced ? 'синхр.' : 'текст'}</span></div>`).join('') : '<div class="panel-empty" style="padding:20px">Ничего не найдено. Попробуйте другой запрос или вставьте текст вручную.</div>';
      };
      m.querySelector('#lgo').addEventListener('click', run);
      m.querySelector('#lq').addEventListener('keydown', (e) => e.key === 'Enter' && run());
      m.querySelector('#lres').addEventListener('click', async (e) => {
        const it = e.target.closest('.ly-item');
        if (!it) return;
        const r = results[+it.dataset.i];
        if (r.geniusUrl) {
          it.style.opacity = '.5';
          const text = await window.api.lyricsGenius(r.geniusUrl);
          it.style.opacity = '';
          if (!text) return toast('Не удалось загрузить текст с Genius');
          close();
          this.save(t, { plain: text, source: `Genius · ${r.artist} — ${r.title}` });
          return toast('Текст сохранён для этого трека');
        }
        close();
        this.save(t, { synced: r.synced, plain: r.plain, source: `LRCLIB · ${r.artist} — ${r.title}` });
        toast('Текст сохранён для этого трека');
      });
      run();
    });
  },

  pasteModal(t) {
    modal(`<h2>Свой текст песни</h2><div class="hint">Вставьте текст. Если в нём есть метки времени вида <b>[01:23.45]</b> (формат LRC), строки будут подсвечиваться по ходу песни.</div>
      <textarea class="input" id="lt" rows="14" style="width:560px;max-width:80vw" spellcheck="false" placeholder="Текст песни…"></textarea>
      <div class="row"><button class="btn" data-close>Отмена</button><button class="btn primary" id="lok">Сохранить</button></div>`, (m, close) => {
      const ta = m.querySelector('#lt');
      ta.focus();
      m.querySelector('#lok').addEventListener('click', () => {
        const v = ta.value.trim();
        if (!v) return ta.focus();
        close();
        const synced = /\[\d+:\d+(?:[.:]\d+)?\]/.test(v);
        this.save(t, synced ? { synced: v, source: 'вручную' } : { plain: v, source: 'вручную' });
        toast('Текст сохранён');
      });
    });
  },
};
$('#panel-body').addEventListener('click', (e) => {
  const act = e.target.closest('[data-ly]');
  const t = Player.current?.track;
  if (act && t) {
    const a = act.dataset.ly;
    if (a === 'search') return Lyrics.searchModal(t);
    if (a === 'paste') return Lyrics.pasteModal(t);
    if (a === 'reset') return Lyrics.save(t, null);
    if (a === 'retry') return Lyrics.render();
    if (a === 'approx-off' || a === 'approx-on') { setSetting({ approxLyrics: a === 'approx-on' }); return Lyrics.render(); }
    if (a === 'web') return window.api.openExternal('https://www.google.com/search?q=' + encodeURIComponent(`${artistOf(t)} ${t.title} текст песни`));
  }
  if (S.panel === 'similar') {
    if (e.target.closest('#sim-play')) return Player.playList(similarList, 0);
    const it = e.target.closest('[data-sim]');
    if (!it) return;
    const id = it.dataset.sim;
    if (e.target.closest('[data-add]')) return Player.addToQueue([id]);
    if (Player.index < 0) return Player.playList([id], 0);
    Player.queue.splice(Player.index + 1, 0, Player.entry(id));
    Player.base.push(Player.queue[Player.index + 1]);
    Player.next();
  }
});
$('#panel-body').addEventListener('contextmenu', (e) => {
  const it = e.target.closest('[data-sim]');
  if (!it) return;
  e.preventDefault();
  trackMenu(e.clientX, e.clientY, [it.dataset.sim]);
});

// ---------- Обложки вручную ----------
function coverMenu(x, y, ids, query) {
  openMenu(x, y, coverSubmenu(ids, query)());
}
function coverSubmenu(ids, query) {
  return () => [
    { label: 'Найти обложку в интернете…', icon: 'search', action: () => coverPicker(ids, query) },
    { label: 'Выбрать картинку с компьютера…', icon: 'image', action: async () => { if (await window.api.coverFile(ids)) toast('Обложка обновлена'); } },
    '-',
    { label: 'Найти автоматически заново', icon: 'refresh', action: async () => { await window.api.coverReset(ids, true); toast('Ищу обложку…'); } },
    { label: 'Убрать обложку', icon: 'trash', danger: true, action: () => window.api.coverReset(ids, false) },
  ];
}
function artistMenu(x, y, ar) {
  if (!ar) return;
  openMenu(x, y, [
    { label: 'Слушать', icon: 'play', action: () => Player.playList(sortedTracks(ar.ids, 'default'), 0) },
    { label: 'Открыть страницу', icon: 'artist', action: () => navigate({ name: 'artist', key: ar.key }) },
    '-',
    { label: 'Найти фото в интернете…', icon: 'search', action: () => artistPicker(ar) },
    { label: 'Выбрать фото с компьютера…', icon: 'image', action: async () => { if (await window.api.artistFile(ar.key)) toast('Фото обновлено'); } },
    { label: 'Найти автоматически заново', icon: 'refresh', action: async () => { await window.api.artistReset(ar.key, true); toast('Ищу фото…'); } },
    ...(ar.photo ? [{ label: 'Убрать фото', icon: 'trash', danger: true, action: () => window.api.artistReset(ar.key, false) }] : []),
  ]);
}
function artistPicker(ar) {
  modal(`<h2>Фото исполнителя</h2><div class="hint">Найдите исполнителя по имени и нажмите на подходящее фото.</div>
    <div class="search-row"><input class="input" id="aq" value="${esc(ar.name)}" spellcheck="false"/><button class="btn primary" id="ago">${icon('search')}Найти</button></div>
    <div class="pick-grid round" id="ares"></div>
    <div class="row"><button class="btn" data-close>Закрыть</button></div>`, (m, close) => {
    let results = [];
    const run = async () => {
      const box = m.querySelector('#ares');
      box.innerHTML = '<div class="scan-status"><div class="spinner"></div>Ищу…</div>';
      results = await window.api.artistSearch(m.querySelector('#aq').value);
      box.innerHTML = results.length ? results.map((r, i) => `<div class="pick" data-i="${i}" title="${esc(r.source)}"><img src="${esc(r.thumb || r.image)}" loading="lazy" referrerpolicy="no-referrer"/><div class="t ell">${esc(r.title)}</div><div class="s ell">${esc(r.sub || r.source)}</div></div>`).join('') : '<div class="panel-empty" style="grid-column:1/-1">Ничего не найдено. Попробуйте другое написание имени.</div>';
    };
    m.querySelector('#ago').addEventListener('click', run);
    m.querySelector('#aq').addEventListener('keydown', (e) => e.key === 'Enter' && run());
    m.querySelector('#ares').addEventListener('click', async (e) => {
      const it = e.target.closest('.pick');
      if (!it) return;
      it.style.opacity = '.5';
      const ok = await window.api.artistApply(ar.key, results[+it.dataset.i].image);
      if (ok) { close(); toast('Фото обновлено'); } else { it.style.opacity = ''; toast('Не удалось скачать фото'); }
    });
    run();
  });
}
function coverPicker(ids, query, fallbackQuery) {
  modal(`<h2>Выбор обложки</h2><div class="hint">Найдите трек или альбом по названию и нажмите на подходящую обложку.</div>
    <div class="search-row"><input class="input" id="cq" value="${esc(query)}" spellcheck="false"/><button class="btn primary" id="cgo">${icon('search')}Найти</button></div>
    <div class="pick-grid" id="cres"></div>
    <div class="row"><button class="btn" data-close>Закрыть</button></div>`, (m, close) => {
    let results = [];
    let first = true;
    const run = async () => {
      const box = m.querySelector('#cres');
      box.innerHTML = '<div class="scan-status"><div class="spinner"></div>Ищу…</div>';
      results = await window.api.coverSearch(m.querySelector('#cq').value);
      if (!results.length && fallbackQuery && first) { first = false; m.querySelector('#cq').value = fallbackQuery; results = await window.api.coverSearch(fallbackQuery); }
      box.innerHTML = results.length ? results.map((r, i) => `<div class="pick" data-i="${i}" title="${esc(r.source)}"><img src="${esc(r.thumb || r.image)}" loading="lazy" referrerpolicy="no-referrer"/><div class="t ell">${esc(r.title)}</div><div class="s ell">${esc(r.artist || '')}</div></div>`).join('') : '<div class="panel-empty" style="grid-column:1/-1">Ничего не найдено. Попробуйте изменить запрос.</div>';
    };
    m.querySelector('#cgo').addEventListener('click', run);
    m.querySelector('#cq').addEventListener('keydown', (e) => e.key === 'Enter' && run());
    m.querySelector('#cres').addEventListener('click', async (e) => {
      const it = e.target.closest('.pick');
      if (!it) return;
      const r = results[+it.dataset.i];
      it.style.opacity = '.5';
      const ok = await window.api.coverApply(ids, r.image);
      if (ok) { close(); toast('Обложка обновлена'); } else { it.style.opacity = ''; toast('Не удалось скачать картинку'); }
    });
    run();
  });
}

$('#panel-body').addEventListener('wheel', () => { Lyrics.lastUserScroll = Date.now(); }, { passive: true });
$('#panel-body').addEventListener('click', (e) => {
  const line = e.target.closest('.line');
  if (line && Lyrics.lines) { Player.seek(Lyrics.lines[+line.dataset.i].t); Lyrics.lastUserScroll = 0; }
});

function qItemHtml(e, qi, current) {
  if (e.id.startsWith('ia:')) {
    const t = S.online.get(e.id);
    if (!t) return '';
    return `<div class="q-item${current ? ' current' : ''}" data-qi="${qi}" draggable="${!current}"><div class="cv" style="background-image:url('${esc(t.cover)}')"></div><div class="meta"><div class="t ell">${esc(t.title)}</div><div class="a ell">${esc(t.artist)} · Архив</div></div>${current ? '' : `<button class="icon-btn small rm" data-rm title="Убрать из очереди">${icon('close')}</button>`}</div>`;
  }
  if (e.id.startsWith('r:')) {
    const st = S.stations.get(e.id);
    return `<div class="q-item${current ? ' current' : ''}" data-qi="${qi}"><div class="cv">${icon('radio')}</div><div class="meta"><div class="t ell">${esc(st?.name)}</div><div class="a ell">Интернет-радио</div></div></div>`;
  }
  const t = S.tracks.get(e.id);
  if (!t) return '';
  return `<div class="q-item${current ? ' current' : ''}" data-qi="${qi}" draggable="${!current}"><div class="cv" style="${bg(t.cover)}">${t.cover ? '' : icon('music')}</div><div class="meta"><div class="t ell">${esc(t.title)}</div><div class="a ell">${esc(artistOf(t))}</div></div>${current ? '' : `<button class="icon-btn small rm" data-rm title="Убрать из очереди">${icon('close')}</button>`}</div>`;
}

function renderQueuePanel() {
  if (S.panel !== 'queue') return;
  const body = $('#panel-body');
  const q = Player.queue;
  if (!q.length) return (body.innerHTML = `<div class="panel-empty">${icon('queue')}Очередь пуста.<br/>Включите альбом, плейлист или трек.</div>`);
  const cur = q[Player.index];
  const upcoming = q.slice(Player.index + 1, Player.index + 301);
  const rest = q.length - Player.index - 1;
  body.innerHTML = `
    <div class="q-section">Сейчас играет</div>
    ${cur ? qItemHtml(cur, Player.index, true) : ''}
    <div class="q-section">Далее · ${rest}${rest ? '<button id="q-clear">Очистить</button>' : ''}</div>
    ${upcoming.map((e, k) => qItemHtml(e, Player.index + 1 + k, false)).join('')}
    ${rest > 300 ? `<div class="q-section">…и ещё ${rest - 300}</div>` : ''}
    ${!rest ? '<div class="panel-empty" style="padding:20px">Дальше ничего нет</div>' : ''}`;
}
let qDragFrom = -1;
$('#panel-body').addEventListener('click', (e) => {
  if (S.panel !== 'queue') return;
  if (e.target.closest('#q-clear')) return Player.clearUpcoming();
  const it = e.target.closest('.q-item');
  if (!it) return;
  const qi = +it.dataset.qi;
  if (e.target.closest('[data-rm]')) return Player.removeAt(qi);
  if (qi !== Player.index) Player.jump(qi);
});
$('#panel-body').addEventListener('dragstart', (e) => {
  const it = e.target.closest('.q-item');
  if (!it) return;
  qDragFrom = +it.dataset.qi;
  it.classList.add('dragging');
  e.dataTransfer.setData('application/x-tembr-q', String(qDragFrom));
});
$('#panel-body').addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes('application/x-tembr-q')) return;
  const it = e.target.closest('.q-item');
  if (!it || +it.dataset.qi <= Player.index) return;
  e.preventDefault();
  $$('.q-item.drag-over').forEach((x) => x.classList.remove('drag-over'));
  it.classList.add('drag-over');
});
$('#panel-body').addEventListener('drop', (e) => {
  const it = e.target.closest('.q-item');
  if (!it || qDragFrom < 0) return;
  e.preventDefault();
  e.stopPropagation();
  Player.moveInQueue(qDragFrom, +it.dataset.qi);
  qDragFrom = -1;
});
$('#panel-body').addEventListener('dragend', () => { qDragFrom = -1; $$('.q-item').forEach((x) => x.classList.remove('dragging', 'drag-over')); });

// =====================================================================
//  Кнопки плеера
// =====================================================================
$('#btn-play').addEventListener('click', () => Player.toggle());
$('#btn-next').addEventListener('click', () => Player.next());
$('#btn-prev').addEventListener('click', () => Player.prev());
$('#btn-shuffle').addEventListener('click', () => Player.setShuffle(!S.settings.shuffle));
$('#btn-repeat').addEventListener('click', () => Player.cycleRepeat());
$('#btn-like').addEventListener('click', () => Player.current?.kind === 'track' && toggleLike(Player.current.id));
$('#btn-lyrics').addEventListener('click', () => setPanel('lyrics'));
$('#btn-queue').addEventListener('click', () => setPanel('queue'));
$('#btn-eq').addEventListener('click', openEq);
$('#btn-mini').addEventListener('click', () => window.api.mini(true));
$('#btn-panel').addEventListener('click', () => setPanel(S.panel ? null : S.panelTab || 'similar', false));
$('#np-play').addEventListener('click', () => Player.toggle());
$('#np-next').addEventListener('click', () => Player.next());
$('#np-prev').addEventListener('click', () => Player.prev());
$('#np-shuffle').addEventListener('click', () => Player.setShuffle(!S.settings.shuffle));
$('#np-repeat').addEventListener('click', () => Player.cycleRepeat());
$('#np-like').addEventListener('click', () => Player.current?.kind === 'track' && toggleLike(Player.current.id));
$('#np-cover').addEventListener('click', () => $('#now-cover').click());
bindSlider($('#np-seek'), (f) => { seeking = true; const d = audio.duration; if (isFinite(d)) $('#np-cur').textContent = fmtTime(f * d); }, (f) => { seeking = false; const d = audio.duration; if (isFinite(d)) Player.seek(f * d); });
$('#btn-mute').addEventListener('click', () => { audio.muted = !audio.muted; updateVolume(); });
$('#now-cover').addEventListener('click', () => {
  const c = Player.current;
  if (c?.kind === 'track' && !c.track.cover) return coverPicker([c.id], `${primaryArtist(c.track)} ${c.track.title}`, c.track.title);
  if (c?.kind === 'track' && albumKey(c.track)) navigate({ name: 'album', key: albumKey(c.track) });
  else if (c?.kind === 'radio') navigate({ name: 'radio' });
  else if (c?.kind === 'online') navigate({ name: 'archiveItem', key: c.track.iaId });
});
bindSlider($('#seek'), (f) => { seeking = true; const d = audio.duration; if (isFinite(d)) $('#time-cur').textContent = fmtTime(f * d); }, (f) => { seeking = false; const d = audio.duration; if (isFinite(d)) Player.seek(f * d); });
bindSlider($('#volume'), (f) => Player.setVolume(f), (f) => Player.setVolume(f));
$('#volume').addEventListener('wheel', (e) => { e.preventDefault(); Player.setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05)); }, { passive: false });

// =====================================================================
//  Горячие клавиши
// =====================================================================
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  if (e.ctrlKey && e.key.toLowerCase() === 'f' || e.ctrlKey && e.code === 'KeyF') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if ($('#modal-root').children.length) return;
  if (typing) return;
  const k = e.code;
  if (k === 'Space') { e.preventDefault(); Player.toggle(); }
  else if (e.ctrlKey && k === 'ArrowRight') { e.preventDefault(); Player.next(); }
  else if (e.ctrlKey && k === 'ArrowLeft') { e.preventDefault(); Player.prev(); }
  else if (e.ctrlKey && k === 'ArrowUp') { e.preventDefault(); Player.setVolume(audio.volume + 0.05); }
  else if (e.ctrlKey && k === 'ArrowDown') { e.preventDefault(); Player.setVolume(audio.volume - 0.05); }
  else if (k === 'ArrowRight' && !e.ctrlKey) { e.preventDefault(); Player.seek(audio.currentTime + 5); }
  else if (k === 'ArrowLeft' && !e.ctrlKey) { e.preventDefault(); Player.seek(audio.currentTime - 5); }
  else if (e.ctrlKey && k === 'KeyL') { e.preventDefault(); setPanel('lyrics'); }
  else if (e.ctrlKey && k === 'KeyQ') { e.preventDefault(); setPanel('queue'); }
  else if (e.ctrlKey && k === 'KeyE') { e.preventDefault(); openEq(); }
  else if (e.ctrlKey && k === 'KeyM') { e.preventDefault(); window.api.mini(true); }
  else if (e.ctrlKey && k === 'KeyP') { e.preventDefault(); $('#btn-panel').click(); }
  else if (e.ctrlKey && k === 'KeyA' && currentList) { e.preventDefault(); currentList.ids.forEach((id) => S.selected.add(id)); currentList.refresh(); }
  else if (e.ctrlKey) return;
  else if (k === 'KeyM') { audio.muted = !audio.muted; updateVolume(); }
  else if (k === 'KeyS') Player.setShuffle(!S.settings.shuffle);
  else if (k === 'KeyR') Player.cycleRepeat();
  else if (k === 'KeyL' && Player.current?.kind === 'track') toggleLike(Player.current.id);
  else if (k === 'Enter' && currentList && S.selected.size) { const sel = currentList.selectionIds(); Player.playList(currentList.ids, currentList.ids.indexOf(sel[0])); }
  else if (k === 'Escape') { S.selected.clear(); currentList?.refresh(); }
  else if (k === 'Backspace' || (e.altKey && k === 'ArrowLeft')) goBack();
});
document.addEventListener('mouseup', (e) => { if (e.button === 3) goBack(); });

// =====================================================================
//  Перетаскивание файлов из Проводника
// =====================================================================
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; dragDepth++; $('#drop-overlay').classList.remove('hidden'); });
document.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.add('hidden'); } });
document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  const paths = Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const before = S.folders.length;
  toast('Добавляю…');
  const r = await window.api.addPaths(paths);
  S.folders = r.folders;
  if (S.folders.length > before) toast('Папка добавлена и будет отслеживаться');
  if (r.ids.length) {
    await refreshTracksNow();
    Player.playList(r.ids, 0);
    toast(`Добавлено: ${tracksWord(r.ids.length)}`);
  }
});

// =====================================================================
//  Команды извне (мини-плеер, панель задач, трей)
// =====================================================================
window.api.onCommand(({ cmd, arg }) => {
  if (cmd === 'toggle') Player.toggle();
  else if (cmd === 'next') Player.next();
  else if (cmd === 'prev') Player.prev();
  else if (cmd === 'seek') Player.seek(arg);
  else if (cmd === 'like' && Player.current?.kind === 'track') toggleLike(Player.current.id);
  else if (cmd === 'shuffle') Player.setShuffle(!S.settings.shuffle);
  else if (cmd === 'volume') Player.setVolume(arg);
  Player.sendState(true);
});

// =====================================================================
//  Данные библиотеки
// =====================================================================
function setTracks(list) {
  S.tracks = new Map(list.map((t) => [t.id, t]));
  S.idx = null;
  if (Player.current?.kind === 'track') {
    const t = S.tracks.get(Player.current.id);
    if (t) { Player.current.track = t; updateNowPlaying(); }
  }
}
let pendingTracks = null;
let lastRender = 0;
const applyTracks = () => {
  if (!pendingTracks) return;
  setTracks(pendingTracks);
  pendingTracks = null;
  lastRender = Date.now();
  if (!['radio'].includes(S.view.name) && !$('#modal-root').children.length) render(true);
  renderNav();
  if (S.panel === 'queue') renderQueuePanel();
  if (S.panel === 'similar') renderSimilar();
};
const applyTracksSoon = debounce(applyTracks, 300);
window.api.onTracks((list) => {
  pendingTracks = list;
  if (Date.now() - lastRender > 2000) applyTracks(); else applyTracksSoon();
});
async function refreshTracksNow() {
  const d = await window.api.init();
  setTracks(d.tracks);
  render(true);
  renderNav();
}
window.api.onArtists((imgs) => {
  S.artistImages = imgs || {};
  S.idx = null;
  if (['artist', 'artists', 'home', 'search'].includes(S.view.name) || S.search) render(true);
});
window.api.onProgress((p) => {
  S.progress = p;
  const el = $('#scan-status');
  el.innerHTML = p.scanning ? `<div class="spinner"></div>Сканирую: ${p.done.toLocaleString('ru')} / ${p.total.toLocaleString('ru')}` : '';
});
window.api.onOpenFiles(async (ids) => {
  if (!ids.length) return;
  await refreshTracksNow();
  Player.playList(ids, 0);
});

// =====================================================================
//  Обновления
// =====================================================================
function updateText() {
  const u = S.update;
  switch (u.state) {
    case 'dev': return 'Автообновление работает только в установленной версии';
    case 'checking': return 'Проверяю…';
    case 'downloading': return `Скачиваю версию ${u.version || ''}… ${u.percent || 0}%`;
    case 'ready': return `Версия ${u.version} скачана и готова к установке`;
    case 'latest': return 'У вас последняя версия';
    case 'error': return 'Не удалось проверить обновления: ' + (u.message || '');
    default: return 'Проверяются автоматически при запуске';
  }
}
function applyUpdate(u) {
  const prev = S.update.state;
  S.update = u;
  const b = $('#update-btn');
  b.classList.toggle('hidden', u.state !== 'ready');
  if (u.state === 'ready') b.innerHTML = `${icon('refresh')}Обновить до ${esc(u.version)}`;
  if (u.state === 'ready' && prev !== 'ready') toast(`Скачана новая версия ${u.version}. Нажмите «Обновить» вверху — или она установится при выходе.`, 6000);
  const st = $('#upd-status');
  if (st) { if ((prev === 'ready') !== (u.state === 'ready')) render(true); else st.textContent = updateText(); }
}
$('#update-btn').addEventListener('click', () => window.api.updateInstall());
window.api.onUpdate(applyUpdate);

// =====================================================================
//  Запуск
// =====================================================================
(async function boot() {
  hydrateIcons();
  const d = await window.api.init();
  S.folders = d.folders;
  S.playlists = d.playlists || [];
  S.stats = d.stats || {};
  S.radioFavs = d.radioFavs || [];
  S.artistImages = d.artistImages || {};
  S.settings = d.settings;
  S.dataDir = d.dataDir;
  S.version = d.version;
  document.body.classList.add('platform-' + d.platform);
  for (const st of S.radioFavs) S.stations.set('r:' + st.id, st);
  setTracks(d.tracks);
  // Новый дизайн: один раз переключаем на светлую «стеклянную» тему, как на макете
  if ((S.settings.designV || 1) < 2) setSetting({ designV: 2, theme: 'light' });
  applyTheme();
  const p0 = S.settings.panel;
  S.panelTab = p0 && p0 !== 'closed' ? p0 : 'similar';
  S.panel = null;
  setPanel(p0 === 'closed' ? null : S.panelTab, false);
  audio.volume = S.settings.volume ?? 0.8;
  updateVolume();
  renderNav();
  render(false);
  updateNowPlaying();
  updateControls();
  applyUpdate(await window.api.updateGet());
  if (d.openFiles && d.openFiles.length) Player.playList(d.openFiles, 0);
  else Player.restore();
})();
