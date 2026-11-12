// Онлайн-сервисы: тексты песен (LRCLIB), обложки (MusicBrainz + Cover Art Archive), интернет-радио (Radio Browser).
const { net } = require('electron');

const UA = 'TembrPlayer/1.0 (desktop music player)';

// Счётчик сетевых ошибок: «не нашли» и «не смогли спросить» — разные вещи, второе нельзя кэшировать
let netErrors = 0;
async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) { if (res.status >= 500 || res.status === 429) netErrors++; return null; }
    return await res.json();
  } catch {
    netErrors++;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Тексты песен ----------
function cleanTitle(s) {
  return (s || '')
    .replace(/\s*[\(\[][^\)\]]*(remaster|live|version|edit|mix|feat|ft\.|official|video|audio|lyrics|hq|hd)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(feat|ft)\.?\s.+$/i, '')
    .trim();
}

async function lyrics(track) {
  const before = netErrors;
  const r = await lyricsInner(track);
  if (!r && netErrors > before) return { retry: true };
  return r;
}
async function lyricsInner({ title, artist, album, duration }) {
  if (!title) return null;
  const t = cleanTitle(title);
  const a = (artist || '').split(/\s*(?:,|&|;| feat\.? | ft\.? )\s*/i)[0].trim();
  const good = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);
  if (a) {
    const variants = [];
    const base = { track_name: t, artist_name: a };
    if (album && duration) variants.push({ ...base, album_name: album, duration: Math.round(duration) });
    if (duration) variants.push({ ...base, duration: Math.round(duration) });
    variants.push(base);
    for (const v of variants) {
      const r = await getJson('https://lrclib.net/api/get?' + new URLSearchParams(v));
      if (good(r)) return pack(r);
    }
  }
  // Поиск с проверкой: исполнитель и название должны совпадать, длительность — быть близкой
  const seen = new Set();
  const cands = [];
  for (const q of [{ track_name: t, artist_name: a }, { q: `${a} ${t}`.trim() }, { track_name: t }]) {
    if (!a && q.artist_name !== undefined) continue;
    const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams(q));
    for (const x of Array.isArray(list) ? list : []) if (!seen.has(x.id) && good(x)) { seen.add(x.id); cands.push(x); }
    if (cands.length >= 20) break;
  }
  let best = null, bestScore = 0;
  for (const x of cands) {
    const ts = sim(t, x.trackName);
    const as = a ? artistSim(a, x.artistName) : 0.8;
    if (ts < 0.85 || as < 0.75) continue;
    let score = ts + as + (x.syncedLyrics ? 0.3 : 0);
    if (duration && x.duration) {
      const d = Math.abs(duration - x.duration);
      if (d > 15) continue;
      if (d < 3) score += 0.3;
    }
    if (score > bestScore) { best = x; bestScore = score; }
  }
  return best ? pack(best) : null;
}

// Ручной поиск текста: список вариантов
async function lyricsSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q }));
  return (Array.isArray(list) ? list : []).filter((x) => x.syncedLyrics || x.plainLyrics).slice(0, 25).map((x) => ({
    id: x.id, title: x.trackName, artist: x.artistName, album: x.albumName, duration: x.duration,
    synced: x.syncedLyrics || null, plain: x.plainLyrics || null,
  }));
}

function pack(r) {
  return { synced: r.syncedLyrics || null, plain: r.plainLyrics || null, instrumental: !!r.instrumental, source: 'LRCLIB' };
}

// ---------- Сравнение названий ----------
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/\s(feat|ft|featuring|prod)\.?\s.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); }
  return out;
}
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ca = a.replace(/ /g, ''), cb = b.replace(/ /g, '');
  if (ca === cb) return 0.98;
  const [short, long] = ca.length < cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 4 && long.startsWith(short) && short.length / long.length > 0.6) return 0.9;
  const A = bigrams(ca), B = bigrams(cb);
  let inter = 0, total = 0;
  for (const [k, v] of A) { inter += Math.min(v, B.get(k) || 0); total += v; }
  for (const v of B.values()) total += v;
  return total ? (2 * inter) / total : 0;
}
// Исполнитель совпадает, если совпадает хотя бы один из перечисленных
function artistSim(a, b) {
  const split = (x) => String(x || '').split(/\s*(?:,|&|;|\/|\sx\s|\sfeat\.?\s|\sft\.?\s|\sи\s)\s*/i).filter(Boolean);
  let best = sim(a, b);
  for (const x of split(a)) for (const y of split(b)) best = Math.max(best, sim(x, y));
  return best;
}

// ---------- Обложки ----------
const COVER_OK = { title: 0.82, artist: 0.8 };

async function fetchImage(url) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1500) return null;
    return { buf, format: res.headers.get('content-type') || 'image/jpeg' };
  } catch { return null; }
}

// Кандидаты на обложку из Deezer
async function deezerTracks(q, limit = 10) {
  const r = await getJson(`https://api.deezer.com/search?limit=${limit}&q=${encodeURIComponent(q)}`);
  return (r && r.data || []).map((x) => ({
    title: x.title, artist: x.artist && x.artist.name, album: x.album && x.album.title, duration: x.duration,
    image: x.album && (x.album.cover_xl || x.album.cover_big), thumb: x.album && x.album.cover_medium, source: 'Deezer',
  }));
}
async function deezerAlbums(q, limit = 10) {
  const r = await getJson(`https://api.deezer.com/search/album?limit=${limit}&q=${encodeURIComponent(q)}`);
  return (r && r.data || []).map((x) => ({
    title: x.title, album: x.title, artist: x.artist && x.artist.name,
    image: x.cover_xl || x.cover_big, thumb: x.cover_medium, source: 'Deezer',
  }));
}
async function itunes(q, entity = 'song', limit = 10) {
  const r = await getJson(`https://itunes.apple.com/search?media=music&entity=${entity}&limit=${limit}&term=${encodeURIComponent(q)}`);
  return (r && r.results || []).filter((x) => x.artworkUrl100).map((x) => ({
    title: entity === 'album' ? x.collectionName : x.trackName, album: x.collectionName, artist: x.artistName,
    duration: x.trackTimeMillis ? x.trackTimeMillis / 1000 : 0,
    image: x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.'), thumb: x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/250x250bb.'), source: 'Apple Music',
  }));
}
async function musicbrainz({ artist, album, title }) {
  const out = [];
  if (album) {
    const q = `release:"${esc(album)}" AND artist:"${esc(artist)}"`;
    const r = await getJson('https://musicbrainz.org/ws/2/release/?fmt=json&limit=5&query=' + encodeURIComponent(q));
    for (const x of (r && r.releases) || []) out.push({ id: x.id, title: x.title, album: x.title, artist: (x['artist-credit'] || []).map((a) => a.name).join(', ') });
  } else {
    const q = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`;
    const r = await getJson('https://musicbrainz.org/ws/2/recording/?fmt=json&limit=5&query=' + encodeURIComponent(q));
    for (const x of (r && r.recordings) || []) {
      const rel = (x.releases || [])[0];
      if (rel) out.push({ id: rel.id, title: x.title, album: rel.title, artist: (x['artist-credit'] || []).map((a) => a.name).join(', '), duration: x.length ? x.length / 1000 : 0 });
    }
  }
  return out.map((x) => ({ ...x, image: `https://coverartarchive.org/release/${x.id}/front-500`, thumb: `https://coverartarchive.org/release/${x.id}/front-250`, source: 'MusicBrainz' }));
}

const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');

function pickBest(cands, want, byAlbum) {
  let best = null, bestScore = 0;
  for (const c of cands) {
    const a = artistSim(want.artist, c.artist);
    const t = byAlbum ? sim(want.album, c.album) : sim(want.title, c.title);
    if (a < COVER_OK.artist || t < COVER_OK.title) continue;
    let score = a + t;
    if (!byAlbum && want.duration && c.duration) {
      const d = Math.abs(want.duration - c.duration);
      if (d > 20) continue; // явно другая запись
      score += d < 4 ? 0.3 : 0;
    }
    if (!byAlbum && want.album && c.album) score += sim(want.album, c.album) * 0.2;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// Автоматический поиск: сначала по названию трека, для альбомов — по альбому. Берём только точные совпадения.
async function findCover(want0) {
  const before = netErrors;
  const r = await findCoverInner(want0);
  if (!r && netErrors > before) return { retry: true };
  return r;
}
async function findCoverInner({ artist, album, title, duration }) {
  if (!artist || (!title && !album)) return null;
  const want = { artist, album, title, duration };
  const attempts = [];
  if (album && album.toLowerCase() !== (title || '').toLowerCase()) {
    attempts.push(async () => pickBest(await deezerAlbums(`${artist} ${album}`), want, true));
  }
  if (title) {
    attempts.push(async () => pickBest(await deezerTracks(`artist:"${artist}" track:"${title}"`), want, false));
    attempts.push(async () => pickBest(await deezerTracks(`${artist} ${title}`), want, false));
    attempts.push(async () => pickBest(await itunes(`${artist} ${title}`), want, false));
  }
  if (album) attempts.push(async () => pickBest(await itunes(`${artist} ${album}`, 'album'), want, true));
  attempts.push(async () => pickBest(await musicbrainz(want), want, !!album && album !== title));
  for (const attempt of attempts) {
    const c = await attempt();
    if (c && c.image) {
      const img = await fetchImage(c.image);
      if (img) return img;
    }
  }
  return null;
}

// Ручной поиск: список вариантов для выбора пользователем
async function coverSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const [a, b, c] = await Promise.all([deezerTracks(q, 12), deezerAlbums(q, 8), itunes(q, 'song', 10)]);
  const seen = new Set();
  return [...b, ...a, ...c].filter((x) => x.image && !seen.has(x.image) && seen.add(x.image)).slice(0, 30);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фоновая очередь поиска обложек
class CoverQueue {
  constructor(library) {
    this.lib = library;
    this.running = false;
  }
  async run() {
    if (this.running || !this.lib.data.settings.autoCovers) return;
    this.running = true;
    try {
      const groups = new Map();
      for (const t of this.lib.tracksList()) {
        if (t.cover || !(t.artist || t.albumArtist) || t.noAutoCover) continue;
        const artist = t.albumArtist || t.artist;
        const isAlbum = t.album && norm(t.album) !== norm(t.title);
        const key = (isAlbum ? `al:${artist}|${t.album}` : `tr:${artist}|${t.title}`).toLowerCase();
        if (!groups.has(key)) groups.set(key, { artist, album: t.album, title: t.title, duration: t.duration, ids: [] });
        groups.get(key).ids.push(t.id);
      }
      const lookup = this.lib.data.coverLookup;
      const WEEK = 7 * 24 * 3600 * 1000;
      for (const [key, g] of groups) {
        if (!this.lib.data.settings.autoCovers) break;
        const prev = lookup[key];
        if (prev && prev.none && Date.now() - prev.at < WEEK) continue;
        const res = await findCover(g);
        if (res && res.retry) { await sleep(700); continue; } // нет сети — попробуем в следующий раз
        if (res) {
          this.lib.setTrackCover(g.ids, res.buf, res.format, 'online');
          delete lookup[key];
        } else {
          lookup[key] = { none: true, at: Date.now() };
        }
        this.lib.save();
        await sleep(700);
      }
    } finally {
      this.running = false;
    }
  }
}

// ---------- Интернет-радио ----------
const RADIO_HOSTS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'nl1.api.radio-browser.info', 'at1.api.radio-browser.info'];
let radioHost = null;

async function radioSearch({ name = '', tag = '', countrycode = '', limit = 60 }) {
  const q = new URLSearchParams({ limit: String(limit), hidebroken: 'true', order: 'clickcount', reverse: 'true' });
  if (name) q.set('name', name);
  if (tag) q.set('tag', tag);
  if (countrycode) q.set('countrycode', countrycode);
  const hosts = radioHost ? [radioHost, ...RADIO_HOSTS.filter((h) => h !== radioHost)] : RADIO_HOSTS;
  for (const h of hosts) {
    const r = await getJson(`https://${h}/json/stations/search?${q}`, 8000);
    if (Array.isArray(r)) {
      radioHost = h;
      return r.map((s) => ({
        id: s.stationuuid,
        name: (s.name || '').trim(),
        url: s.url_resolved || s.url,
        favicon: s.favicon || '',
        tags: (s.tags || '').split(',').filter(Boolean).slice(0, 4),
        country: s.country || '',
        countrycode: s.countrycode || '',
        bitrate: s.bitrate || 0,
        codec: s.codec || '',
        homepage: s.homepage || '',
      }));
    }
  }
  return null;
}

async function radioClick(id) {
  if (radioHost && id) getJson(`https://${radioHost}/json/url/${id}`, 5000);
}

module.exports = { lyrics, lyricsSearch, CoverQueue, findCover, coverSearch, fetchImage, radioSearch, radioClick, sim, artistSim };
