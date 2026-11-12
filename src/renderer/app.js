'use strict';
/* global icon, hydrateIcons */

// =====================================================================
//  Утилиты
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (p) => 'tmedia://file/' + encodeURIComponent(p).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const bg = (p) => (p ? `background-image:url('${fileUrl(p)}')` : '');
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
  settings: {},
  dataDir: '',
  version: '',
  view: { name: 'tracks' },
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
    for (const name of new Set([primaryArtist(t), t.albumArtist].filter(Boolean))) {
      const nk = name.toLowerCase();
      if (!artists.has(nk)) artists.set(nk, { key: nk, name, cover: null, ids: [] });
      const ar = artists.get(nk);
      ar.ids.push(t.id);
      if (!ar.cover && t.cover) ar.cover = t.cover;
    }
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
      node.connect(this.ctx.destination);
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
    ids = ids.filter((id) => S.tracks.has(id) || id.startsWith('r:'));
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
    const q = Player.queue.filter((e) => !e.id.startsWith('r:'));
    const cur = Player.queue[Player.index];
    if (!cur || cur.id.startsWith('r:')) return;
    const start = Math.max(0, q.indexOf(cur) - 200);
    const slice = q.slice(start, start + 1000);
    setSetting({
      lastTrack: {
        ids: slice.map((e) => e.id),
        index: slice.indexOf(cur),
        base: S.settings.shuffle ? Player.base.filter((e) => !e.id.startsWith('r:')).slice(0, 1000).map((e) => e.id) : null,
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
  const meta = c.kind === 'track'
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
function updateNowPlaying() {
  const c = Player.current;
  const cover = $('#now-cover');
  const like = $('#btn-like');
  if (!c) {
    $('#now-title').textContent = 'Ничего не играет';
    $('#now-artist').textContent = 'Выберите трек';
    cover.style.backgroundImage = '';
    cover.innerHTML = icon('music');
    like.classList.add('hidden');
    return;
  }
  if (c.kind === 'track') {
    const t = c.track;
    $('#now-title').textContent = t.title;
    $('#now-title').title = t.title;
    $('#now-artist').innerHTML = `<span class="link" data-artist="${esc(primaryArtist(t).toLowerCase())}">${esc(artistOf(t))}</span>${t.album ? ` · <span class="link" data-album="${esc(albumKey(t))}">${esc(t.album)}</span>` : ''}`;
    cover.style.backgroundImage = t.cover ? `url('${fileUrl(t.cover)}')` : '';
    cover.innerHTML = t.cover ? '' : icon('music');
    like.classList.remove('hidden');
    const liked = isLiked(t.id);
    like.classList.toggle('on', liked);
    like.innerHTML = icon(liked ? 'heartFill' : 'heart');
  } else {
    const st = c.station;
    $('#now-title').textContent = st.name;
    $('#now-artist').innerHTML = `<span class="live">LIVE</span> ${esc([st.country, st.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · '))}`;
    cover.style.backgroundImage = st.favicon ? `url('${st.favicon.replace(/'/g, '%27')}')` : '';
    cover.style.backgroundSize = st.favicon ? 'contain' : '';
    cover.innerHTML = st.favicon ? '' : icon('radio');
    like.classList.add('hidden');
  }
  if (c.kind === 'track') cover.style.backgroundSize = '';
  updateMediaSession();
  updateControls();
  updateProgress();
}

function updateControls() {
  const playing = !audio.paused;
  $('#btn-play').innerHTML = icon(playing ? 'pause' : 'play');
  document.body.classList.toggle('paused', !playing);
  $('#btn-shuffle').classList.toggle('active', !!S.settings.shuffle);
  const r = S.settings.repeat;
  $('#btn-repeat').classList.toggle('active', r !== 'off');
  $('#btn-repeat').innerHTML = icon(r === 'one' ? 'repeatOne' : 'repeat');
  const live = Player.current?.kind === 'radio';
  $('#seek').classList.toggle('disabled', live || !Player.current);
  $('#btn-lyrics').classList.toggle('active', S.panel === 'lyrics');
  $('#btn-queue').classList.toggle('active', S.panel === 'queue');
  $('#btn-eq').classList.toggle('active', !!S.settings.eq.enabled);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

let seeking = false;
function updateProgress() {
  const live = Player.current?.kind === 'radio';
  const d = audio.duration;
  const cur = audio.currentTime || 0;
  $('#time-cur').textContent = fmtTime(cur);
  $('#time-dur').textContent = live ? '∞' : fmtTime(isFinite(d) ? d : Player.current?.track?.duration || 0);
  if (!seeking) setSlider($('#seek'), live ? 0 : isFinite(d) && d > 0 ? cur / d : 0);
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
    this.el.innerHTML = `<div class="thead"><div style="text-align:center">#</div>${h('title', 'Название')}${h('artist', 'Исполнитель')}<div class="c-album">${h('album', 'Альбом')}</div><div></div><div style="text-align:right">${h('duration', '⏱')}</div></div><div class="tbody"></div>`;
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
        <div class="c-title"><div class="cv" style="${bg(t.cover)}">${t.cover ? '' : icon('music')}</div><div class="meta"><span class="t ell" title="${esc(t.title)}">${esc(t.title)}</span></div></div>
        <div class="ell"><span class="link" data-artist="${esc(primaryArtist(t).toLowerCase())}">${esc(artistOf(t))}</span></div>
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
  if (ids.length === 1) {
    items.push('-');
    if (albumKey(t)) items.push({ label: 'Перейти к альбому', icon: 'album', action: () => navigate({ name: 'album', key: albumKey(t) }) });
    items.push({ label: 'Перейти к исполнителю', icon: 'artist', action: () => navigate({ name: 'artist', key: primaryArtist(t).toLowerCase() }) });
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
function renderNav() {
  const nav = $('#nav');
  nav.innerHTML = `
    <div class="nav-title">Библиотека</div>
    ${navItem({ name: 'tracks' }, 'music', 'Все треки')}
    ${navItem({ name: 'albums' }, 'album', 'Альбомы')}
    ${navItem({ name: 'artists' }, 'artist', 'Исполнители')}
    <div class="nav-title">Онлайн</div>
    ${navItem({ name: 'radio' }, 'radio', 'Радио')}
    <div class="nav-title">Подборки</div>
    ${navItem({ name: 'liked' }, 'heart', 'Любимые', likedIds().length || null)}
    ${navItem({ name: 'recent' }, 'sparkle', 'Недавно добавленные')}
    ${navItem({ name: 'top' }, 'fire', 'Часто слушаю')}
    ${navItem({ name: 'history' }, 'clock', 'Недавно играли')}
    <div class="nav-title">Плейлисты <button id="nav-new-pl" title="Новый плейлист">${icon('add')}</button></div>
    ${S.playlists.map((p) => navItem({ name: 'playlist', id: p.id }, 'playlist', p.name, p.ids.filter((id) => S.tracks.has(id)).length)).join('')}
    ${S.playlists.length ? '' : '<div style="padding:4px 12px;color:var(--text-3);font-size:12px;line-height:1.5">Создайте плейлист кнопкой «+» или перетащите сюда треки</div>'}
  `;
  $('.sidebar-bottom .nav-item').classList.toggle('active', S.view.name === 'settings');
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
$('.sidebar-bottom').addEventListener('click', (e) => { if (e.target.closest('[data-view="settings"]')) navigate({ name: 'settings' }); });

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
  if (S.search.trim() && !['settings', 'radio'].includes(v.name)) renderSearch(view);
  else {
    const fn = VIEWS[v.name] || VIEWS.tracks;
    fn(view, v);
  }
  if (keepScroll) view.scrollTop = scroll;
  else view.scrollTop = 0;
  currentList?.refresh();
}

function head({ kicker, title, sub, art, artClass = '', artIcon = 'music', actions = '', compact = false }) {
  return `<div class="view-head${compact ? ' compact' : ''}">
    ${art !== false ? `<div class="art ${artClass}" style="${art ? bg(art) : ''}">${art ? '' : icon(artIcon)}</div>` : ''}
    <div class="info">
      ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
      <h1 title="${esc(title)}">${esc(title)}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div></div>`;
}
const playActions = (extra = '') => `<button class="btn primary round" data-act="play">${icon('play')}Слушать</button><button class="btn round" data-act="shuffle">${icon('shuffle')}Перемешать</button>${extra}`;
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

const VIEWS = {
  tracks(view) {
    const ids = sortedTracks(Array.from(S.tracks.keys()), 'default');
    if (!ids.length) return emptyLibrary(view);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Библиотека', title: 'Все треки', sub: summary(ids), art: false, compact: true, actions: playActions(`<button class="btn round" id="h-add">${icon('folder')}Добавить папку</button>`) }));
    bindPlayActions(view, ids);
    $('#h-add').addEventListener('click', addFolder);
    currentList = new TrackList(view, ids);
  },

  albums(view) {
    const albums = Array.from(index().albums.values()).sort((a, b) => cmp(a.artist, b.artist) || (a.year || 0) - (b.year || 0) || cmp(a.name, b.name));
    if (!S.tracks.size) return emptyLibrary(view);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Библиотека', title: 'Альбомы', sub: plural(albums.length, 'альбом', 'альбома', 'альбомов'), art: false, compact: true }));
    view.appendChild(albumGrid(albums));
  },

  artists(view) {
    const artists = Array.from(index().artists.values()).sort((a, b) => cmp(a.name, b.name));
    if (!S.tracks.size) return emptyLibrary(view);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Библиотека', title: 'Исполнители', sub: plural(artists.length, 'исполнитель', 'исполнителя', 'исполнителей'), art: false, compact: true }));
    view.appendChild(artistGrid(artists));
  },

  album(view, v) {
    const a = index().albums.get(v.key);
    if (!a) return (view.innerHTML = '<div class="empty"><h2>Альбом не найден</h2></div>');
    const ids = sortedTracks(a.ids, 'album');
    view.insertAdjacentHTML('beforeend', head({
      kicker: 'Альбом', title: a.name, art: a.cover, artIcon: 'album',
      sub: `<span class="link" data-artist="${esc(a.artist.toLowerCase())}">${esc(a.artist)}</span>${a.year ? ' · ' + a.year : ''} · ${summary(ids)}`,
      actions: playActions(),
    }));
    bindPlayActions(view, ids);
    currentList = new TrackList(view, ids, { noAlbum: true, trackNumbers: true });
  },

  artist(view, v) {
    const ar = index().artists.get(v.key);
    if (!ar) return (view.innerHTML = '<div class="empty"><h2>Исполнитель не найден</h2></div>');
    const ids = sortedTracks(ar.ids, 'default');
    const albums = Array.from(index().albums.values()).filter((a) => a.ids.some((id) => ar.ids.includes(id))).sort((a, b) => (b.year || 0) - (a.year || 0));
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Исполнитель', title: ar.name, art: ar.cover, artClass: 'round', artIcon: 'artist', sub: `${summary(ids)}${albums.length ? ' · ' + plural(albums.length, 'альбом', 'альбома', 'альбомов') : ''}`, actions: playActions() }));
    bindPlayActions(view, ids);
    if (albums.length) {
      view.insertAdjacentHTML('beforeend', '<div class="section-title">Альбомы</div>');
      view.appendChild(albumGrid(albums, true));
      view.insertAdjacentHTML('beforeend', '<div class="section-title">Все треки</div>');
    }
    currentList = new TrackList(view, ids);
  },

  liked(view) {
    const ids = likedIds();
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Подборка', title: 'Любимые', sub: ids.length ? summary(ids) : 'Нажмите ♡ у трека, чтобы добавить его сюда', art: null, artClass: 'grad-2', artIcon: 'heartFill', actions: ids.length ? playActions() : '' }));
    bindPlayActions(view, ids);
    if (ids.length) currentList = new TrackList(view, ids);
  },

  recent(view) {
    const ids = sortedTracks(Array.from(S.tracks.keys()), 'added').slice(0, 300);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Подборка', title: 'Недавно добавленные', sub: ids.length ? `Последние ${tracksWord(ids.length)}, которые появились в библиотеке` : 'Пока пусто', art: null, artClass: 'grad-3', artIcon: 'sparkle', actions: ids.length ? playActions() : '' }));
    bindPlayActions(view, ids);
    if (ids.length) currentList = new TrackList(view, ids, { noSort: true });
  },

  top(view) {
    const ids = Object.entries(S.stats).filter(([id, s]) => s.plays > 0 && S.tracks.has(id)).sort((a, b) => b[1].plays - a[1].plays || b[1].last - a[1].last).slice(0, 100).map(([id]) => id);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Подборка', title: 'Часто слушаю', sub: ids.length ? `${tracksWord(ids.length)}, которые вы слушаете чаще всего` : 'Слушайте музыку — здесь соберутся ваши хиты', art: null, artClass: 'grad-4', artIcon: 'fire', actions: ids.length ? playActions() : '' }));
    bindPlayActions(view, ids);
    if (ids.length) currentList = new TrackList(view, ids);
  },

  history(view) {
    const ids = Object.entries(S.stats).filter(([id, s]) => s.last && S.tracks.has(id)).sort((a, b) => b[1].last - a[1].last).slice(0, 200).map(([id]) => id);
    view.insertAdjacentHTML('beforeend', head({ kicker: 'Подборка', title: 'Недавно играли', sub: ids.length ? tracksWord(ids.length) : 'История прослушивания пока пуста', art: null, artClass: 'grad-5', artIcon: 'clock', actions: ids.length ? playActions() : '' }));
    bindPlayActions(view, ids);
    if (ids.length) currentList = new TrackList(view, ids);
  },

  playlist(view, v) {
    const p = S.playlists.find((x) => x.id === v.id);
    if (!p) return navigate({ name: 'tracks' }, true);
    const ids = p.ids.filter((id) => S.tracks.has(id));
    const covers = [...new Set(ids.map((id) => S.tracks.get(id).cover).filter(Boolean))].slice(0, 4);
    view.insertAdjacentHTML('beforeend', head({
      kicker: 'Плейлист', title: p.name, art: covers[0] || null, artClass: covers.length ? '' : 'grad-1', artIcon: 'playlist',
      sub: ids.length ? summary(ids) : 'Плейлист пуст — добавьте треки через правый клик или перетащите их на плейлист в меню слева',
      actions: (ids.length ? playActions() : '') + `<button class="icon-btn" id="pl-rename" title="Переименовать">${icon('edit')}</button><button class="icon-btn" id="pl-del" title="Удалить плейлист">${icon('trash')}</button>`,
    }));
    if (covers.length >= 4) {
      const art = view.querySelector('.view-head .art');
      art.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;overflow:hidden;';
      art.innerHTML = covers.map((c) => `<div style="${bg(c)};background-size:cover;background-position:center"></div>`).join('');
    }
    bindPlayActions(view, ids);
    $('#pl-rename').addEventListener('click', () => renamePlaylist(p));
    $('#pl-del').addEventListener('click', () => deletePlaylist(p));
    if (ids.length) currentList = new TrackList(view, ids);
  },

  radio(view) { renderRadio(view); },
  settings(view) { renderSettings(view); },
};

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
  return g;
}

// ---------- Поиск ----------
function renderSearch(view) {
  const q = S.search.trim().toLowerCase();
  const words = q.split(/\s+/);
  const match = (s) => words.every((w) => s.includes(w));
  const ids = [];
  for (const t of S.tracks.values()) {
    const hay = `${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre}`.toLowerCase();
    if (match(hay)) ids.push(t.id);
  }
  const albums = Array.from(index().albums.values()).filter((a) => match(`${a.name} ${a.artist}`.toLowerCase())).slice(0, 12);
  const artists = Array.from(index().artists.values()).filter((a) => match(a.name.toLowerCase())).slice(0, 12);
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
  if (S.view.name === 'settings' || S.view.name === 'radio') {
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
//  Настройки
// =====================================================================
const ACCENTS = ['#7c5cff', '#2d7cf6', '#1db97a', '#ff5c8a', '#ff8a3d', '#e5484d', '#00b3c7', '#c084fc'];
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
      <div class="set-row"><div class="l"><b>Искать обложки автоматически</b><small>Если у трека нет обложки, Tembr найдёт её в MusicBrainz / Cover Art Archive</small></div>${sw('autoCovers', st.autoCovers)}</div>
      <div class="set-row"><div class="l"><b>Тексты песен</b><small>Загружаются из LRCLIB при открытии панели «Текст». Синхронные тексты подсвечиваются по ходу песни.</small></div></div>
      <div class="set-row"><div class="l"><b>Повторить поиск</b><small>Сбросить кэш ненайденных обложек и текстов и поискать заново</small></div><button class="btn" id="s-cache">Сбросить</button></div>
    </div>
    <div class="set-group">
      <h3>Оформление</h3>
      <div class="set-row"><div class="l"><b>Тема</b></div><div class="seg"><button data-theme="dark" class="${st.theme !== 'light' ? 'on' : ''}">Тёмная</button><button data-theme="light" class="${st.theme === 'light' ? 'on' : ''}">Светлая</button></div></div>
      <div class="set-row"><div class="l"><b>Акцентный цвет</b></div><div class="swatches">${ACCENTS.map((c) => `<button class="swatch${c === st.accent ? ' on' : ''}" data-accent="${c}" style="background:${c}"></button>`).join('')}</div></div>
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

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.style.setProperty('--accent', S.settings.accent || '#7c5cff');
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
function setPanel(name) {
  S.panel = S.panel === name ? null : name;
  $('#panel').classList.toggle('hidden', !S.panel);
  document.body.classList.toggle('has-panel', !!S.panel);
  $$('.panel-tabs [data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === S.panel));
  updateControls();
  if (S.panel === 'lyrics') Lyrics.render();
  if (S.panel === 'queue') renderQueuePanel();
  currentList?.refresh();
}
$('.panel-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-panel]');
  if (b && b.dataset.panel !== S.panel) setPanel(b.dataset.panel);
});
$('#panel-close').addEventListener('click', () => setPanel(S.panel));

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
      data = await window.api.lyrics({ title: t.title, artist: t.artist, album: t.album, duration: t.duration });
      if (!data && t.lyrics) data = /\[\d+:\d+/.test(t.lyrics) ? { synced: t.lyrics, source: 'теги файла' } : { plain: t.lyrics, source: 'теги файла' };
      data = data || { none: true };
      this.cache.set(t.id, data);
      if (Player.current?.id !== t.id || S.panel !== 'lyrics') return;
    }
    if (data.instrumental) return (body.innerHTML = `<div class="panel-empty">${icon('music')}Это инструментальная композиция ♪</div>`);
    if (data.synced) {
      this.lines = this.parseLrc(data.synced);
      body.innerHTML = `<div class="lyrics">${this.lines.map((l, i) => `<div class="line" data-i="${i}">${esc(l.text) || '♪'}</div>`).join('')}</div><div class="lyrics-src">Источник: ${esc(data.source || 'LRCLIB')}</div>`;
      this.tick(true);
      return;
    }
    if (data.plain) {
      body.innerHTML = `<div class="lyrics plain">${esc(data.plain)}</div><div class="lyrics-src">Источник: ${esc(data.source || 'LRCLIB')}</div>`;
      return;
    }
    body.innerHTML = `<div class="panel-empty">${icon('lyrics')}Текст для этой песни не найден.<br/><small style="color:var(--text-3)">Проверьте, что у трека указаны исполнитель и название.</small></div>`;
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
};
$('#panel-body').addEventListener('wheel', () => { Lyrics.lastUserScroll = Date.now(); }, { passive: true });
$('#panel-body').addEventListener('click', (e) => {
  const line = e.target.closest('.line');
  if (line && Lyrics.lines) { Player.seek(Lyrics.lines[+line.dataset.i].t); Lyrics.lastUserScroll = 0; }
});

function qItemHtml(e, qi, current) {
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
$('#btn-mute').addEventListener('click', () => { audio.muted = !audio.muted; updateVolume(); });
$('#now-cover').addEventListener('click', () => {
  const c = Player.current;
  if (c?.kind === 'track' && albumKey(c.track)) navigate({ name: 'album', key: albumKey(c.track) });
  else if (c?.kind === 'radio') navigate({ name: 'radio' });
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
  S.settings = d.settings;
  S.dataDir = d.dataDir;
  S.version = d.version;
  document.body.classList.add('platform-' + d.platform);
  for (const st of S.radioFavs) S.stations.set('r:' + st.id, st);
  setTracks(d.tracks);
  applyTheme();
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
