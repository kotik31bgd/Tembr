// Онлайн-сервисы: тексты песен (LRCLIB, Genius), обложки (Deezer, Яндекс Музыка, Apple Music, Genius, MusicBrainz), интернет-радио (Radio Browser).
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

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function getText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }, signal: ctrl.signal });
    if (!res.ok) { if (res.status >= 500 || res.status === 429) netErrors++; return null; }
    return await res.text();
  } catch {
    netErrors++;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Genius ----------
async function geniusSearch(q) {
  const r = await getJson('https://genius.com/api/search/multi?per_page=5&q=' + encodeURIComponent(q));
  const out = [];
  const seen = new Set();
  for (const sec of (r && r.response && r.response.sections) || []) {
    for (const h of sec.hits || []) {
      const x = h.result;
      if (h.type !== 'song' || !x || seen.has(x.id)) continue;
      seen.add(x.id);
      out.push({
        id: x.id, title: x.title, artist: x.artist_names || (x.primary_artist && x.primary_artist.name) || '',
        url: x.url, image: x.song_art_image_url || x.header_image_url, thumb: x.song_art_image_thumbnail_url || x.song_art_image_url,
        instrumental: !!x.instrumental, source: 'Genius',
        artists: [x.primary_artist, ...(x.featured_artists || [])].filter((a) => a && a.image_url && !/default_avatar/.test(a.image_url)).map((a) => ({ name: a.name, image: a.image_url })),
      });
    }
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e];
  });
}
// Находит <div ...marker...>…</div> с учётом вложенных div: [начало тега, начало содержимого, конец содержимого, конец блока]
function divRanges(html, marker) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf(marker, i)) !== -1) {
    const open = html.lastIndexOf('<div', i);
    const start = html.indexOf('>', i) + 1;
    const re = /<\/?div\b[^>]*>/gi;
    re.lastIndex = start;
    let depth = 1, m, done = false;
    while ((m = re.exec(html))) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (!depth) { out.push([open, start, m.index, re.lastIndex]); i = re.lastIndex; done = true; break; }
    }
    if (!done) break;
  }
  return out;
}
function parseGeniusLyrics(html) {
  if (!html) return null;
  const parts = [];
  for (const [, a, b] of divRanges(html, 'data-lyrics-container="true"')) {
    let inner = html.slice(a, b);
    // служебные вставки внутри текста (заголовки, «N Contributors» и т.п.)
    for (const [o, , , e] of divRanges(inner, 'data-exclude-from-selection="true"').reverse()) inner = inner.slice(0, o) + inner.slice(e);
    parts.push(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
  }
  if (!parts.length) return null;
  const text = decodeEntities(parts.join('\n'))
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}
async function geniusLyrics(url) {
  if (!/^https:\/\/genius\.com\//.test(url || '')) return null;
  return parseGeniusLyrics(await getText(url));
}
async function geniusFind(t, artistFull) {
  const cands = await geniusSearch(`${artistFull} ${t}`);
  let best = null, bestScore = 0;
  for (const c of cands) {
    const ts = sim(t, c.title);
    const as = artistSim(artistFull, c.artist);
    if (ts < 0.85 || as < 0.75) continue;
    if (ts + as > bestScore) { best = c; bestScore = ts + as; }
  }
  return best;
}

// ---------- Яндекс Музыка (обложки; хорошо знает русскую музыку) ----------
async function yandexTracks(q, limit = 10) {
  const r = await getJson('https://api.music.yandex.net/search?type=track&page=0&text=' + encodeURIComponent(q));
  const items = (r && r.result && r.result.tracks && r.result.tracks.results) || [];
  return items.slice(0, limit).map((x) => {
    const uri = x.coverUri || (x.albums && x.albums[0] && x.albums[0].coverUri) || x.ogImage;
    const alb = (x.albums && x.albums[0]) || {};
    return {
      title: x.title, artist: (x.artists || []).map((a) => a.name).join(', '), album: alb.title, duration: (x.durationMs || 0) / 1000,
      image: uri ? 'https://' + uri.replace('%%', '600x600') : null, thumb: uri ? 'https://' + uri.replace('%%', '200x200') : null, source: 'Яндекс Музыка',
      artists: (x.artists || []).filter((a) => a.cover && a.cover.uri).map((a) => ({ name: a.name, image: 'https://' + a.cover.uri.replace('%%', '600x600') })),
    };
  }).filter((x) => x.image);
}

// ---------- Тексты песен ----------
function cleanTitle(s) {
  return (s || '')
    .replace(/\s*[\(\[][^\)\]]*(remaster|live|version|edit|mix|feat|ft\.|prod|official|video|audio|lyrics|hq|hd|explicit|clean)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(feat|ft|prod)\.?\s.+$/i, '')
    .trim();
}

async function lyrics(track) {
  const before = netErrors;
  const r = await lyricsInner(track);
  if (!r && netErrors > before) return { retry: true };
  return r;
}
// Название из LRCLIB бывает вида «Исполнитель — Песня»: отрезаем исполнителя
function stripArtistPrefix(name, artist) {
  const m = String(name || '').split(/\s+[—–-]\s+/);
  if (m.length >= 2 && artistSim(artist, m[0]) >= 0.75) return m.slice(1).join(' - ');
  return name;
}
async function lyricsInner({ title, artist, album, duration }) {
  if (!title) return null;
  const t = cleanTitle(title);
  const a = (artist || '').split(/\s*(?:,|&|;| feat\.? | ft\.? )\s*/i)[0].trim();
  const good = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);
  let fallback = null; // текст без таймингов — используем, только если синхронного так и не найдём
  if (a) {
    const variants = [];
    const base = { track_name: t, artist_name: a };
    if (album && duration) variants.push({ ...base, album_name: album, duration: Math.round(duration) });
    if (duration) variants.push({ ...base, duration: Math.round(duration) });
    variants.push(base);
    for (const v of variants) {
      const r = await getJson('https://lrclib.net/api/get?' + new URLSearchParams(v));
      if (r && (r.syncedLyrics || r.instrumental)) return pack(r);
      if (good(r) && !fallback) fallback = r;
    }
  }
  // Поиск с проверкой: исполнитель и название должны совпадать, длительность — быть близкой
  const seen = new Set();
  const cands = [];
  const matches = (x) => Math.max(sim(t, x.trackName), sim(t, stripArtistPrefix(x.trackName, a))) >= 0.85
    && (!a || Math.max(artistSim(a, x.artistName), artistSim(artist, x.artistName)) >= 0.75)
    && (!duration || !x.duration || Math.abs(duration - x.duration) <= 15);
  // Последний запрос — только исполнитель: так находятся треки, записанные другим алфавитом («aromat» / «аромат»)
  for (const q of [{ track_name: t, artist_name: a }, { q: `${a} ${t}`.trim() }, { q: `${artist || ''} ${t}`.trim() }, { track_name: t }, { q: a }]) {
    if (q.q === '') continue;
    if (!a && q.artist_name !== undefined) continue;
    const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams(q));
    for (const x of Array.isArray(list) ? list : []) if (!seen.has(x.id) && good(x)) { seen.add(x.id); cands.push(x); }
    if (cands.some((x) => x.syncedLyrics && matches(x))) break; // нужный трек с таймингами уже есть
  }
  let best = null, bestScore = 0;
  for (const x of cands) {
    const ts = Math.max(sim(t, x.trackName), sim(t, stripArtistPrefix(x.trackName, a)));
    const as = a ? Math.max(artistSim(a, x.artistName), artistSim(artist, x.artistName)) : 0.8;
    if (ts < 0.85 || as < 0.75) continue;
    let score = ts + as + (x.syncedLyrics ? 1 : 0);
    if (duration && x.duration) {
      const d = Math.abs(duration - x.duration);
      if (d > 15) continue;
      if (d < 3) score += 0.3;
    }
    if (score > bestScore) { best = x; bestScore = score; }
  }
  if (best && (best.syncedLyrics || !fallback)) return pack(best);
  if (fallback) return pack(fallback);
  // Последний шанс — Genius (текст без таймингов)
  const g = await geniusFind(t, artist || a);
  if (g) {
    const text = g.instrumental ? null : await geniusLyrics(g.url);
    if (text) return { synced: null, plain: text, instrumental: false, source: 'Genius' };
    if (g.instrumental) return { synced: null, plain: null, instrumental: true, source: 'Genius' };
  }
  return null;
}

// Ручной поиск текста: список вариантов
async function lyricsSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const [list, gen] = await Promise.all([getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q })), geniusSearch(q)]);
  const lr = (Array.isArray(list) ? list : []).filter((x) => x.syncedLyrics || x.plainLyrics).slice(0, 25).map((x) => ({
    id: x.id, title: x.trackName, artist: x.artistName, album: x.albumName, duration: x.duration,
    synced: x.syncedLyrics || null, plain: x.plainLyrics || null, source: 'LRCLIB',
  }));
  lr.sort((x, y) => (y.synced ? 1 : 0) - (x.synced ? 1 : 0));
  const gr = gen.filter((x) => !x.instrumental).slice(0, 8).map((x) => ({ id: 'g' + x.id, title: x.title, artist: x.artist, geniusUrl: x.url, source: 'Genius' }));
  return [...lr, ...gr];
}

function pack(r) {
  return { synced: r.syncedLyrics || null, plain: r.plainLyrics || null, instrumental: !!r.instrumental, source: 'LRCLIB' };
}

// ---------- Сравнение названий ----------
// Кириллица → латиница, чтобы «аромат» и «aromat» считались одним названием
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u' };
const translit = (s) => s.replace(/[а-яёіїєґў]/g, (c) => TRANSLIT[c] ?? c);
function norm(s) {
  return translit(String(s || '').toLowerCase())
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
    if (!res.ok) { if (res.status >= 500 || res.status === 429) netErrors++; return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1500) return null;
    return { buf, format: res.headers.get('content-type') || 'image/jpeg' };
  } catch { netErrors++; return null; }
}

// Кандидаты на обложку из Deezer
async function deezerTracks(q, limit = 10) {
  const r = await getJson(`https://api.deezer.com/search?limit=${limit}&q=${encodeURIComponent(q)}`);
  return (r && r.data || []).map((x) => ({
    title: x.title, artist: x.artist && x.artist.name, album: x.album && x.album.title, duration: x.duration,
    image: x.album && (x.album.cover_xl || x.album.cover_big), thumb: x.album && x.album.cover_medium, source: 'Deezer',
    artists: x.artist && x.artist.picture_xl && !x.artist.picture_xl.includes('d41d8cd98f00b204e9800998ecf8427e') ? [{ name: x.artist.name, image: x.artist.picture_xl }] : [],
  }));
}
async function deezerAlbums(q, limit = 10) {
  const r = await getJson(`https://api.deezer.com/search/album?limit=${limit}&q=${encodeURIComponent(q)}`);
  return (r && r.data || []).map((x) => ({
    title: x.title, album: x.title, artist: x.artist && x.artist.name,
    image: x.cover_xl || x.cover_big, thumb: x.cover_medium, source: 'Deezer',
  }));
}
async function itunes(q, entity = 'song', limit = 10, country = '') {
  const r = await getJson(`https://itunes.apple.com/search?media=music&entity=${entity}&limit=${limit}${country ? '&country=' + country : ''}&term=${encodeURIComponent(q)}`);
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
    attempts.push(async () => pickBest(await yandexTracks(`${artist} ${title}`), want, false));
    attempts.push(async () => pickBest(await itunes(`${artist} ${title}`), want, false));
    attempts.push(async () => pickBest(await itunes(`${artist} ${title}`, 'song', 10, 'RU'), want, false));
    attempts.push(async () => pickBest(await geniusSearch(`${artist} ${title}`), { ...want, duration: 0 }, false));
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
  const [a, b, c, y, g] = await Promise.all([deezerTracks(q, 12), deezerAlbums(q, 8), itunes(q, 'song', 10), yandexTracks(q, 10), geniusSearch(q)]);
  const seen = new Set();
  return [...y, ...b, ...a, ...c, ...g].filter((x) => x.image && !seen.has(x.image) && seen.add(x.image)).slice(0, 30);
}

// ---------- Фото исполнителей ----------
const DEEZER_EMPTY = 'd41d8cd98f00b204e9800998ecf8427e'; // так Deezer помечает «нет фото»
async function deezerArtists(q, limit = 10) {
  const r = await getJson(`https://api.deezer.com/search/artist?limit=${limit}&q=${encodeURIComponent(q)}`);
  return (r && r.data || []).filter((x) => x.picture_xl && !x.picture_xl.includes(DEEZER_EMPTY)).map((x) => ({
    title: x.name, artist: x.name, sub: x.nb_fan ? `${x.nb_fan.toLocaleString('ru')} поклонников` : '', image: x.picture_xl, thumb: x.picture_medium, source: 'Deezer',
  }));
}
async function yandexArtists(q, limit = 10) {
  const r = await getJson('https://api.music.yandex.net/search?type=artist&page=0&text=' + encodeURIComponent(q));
  const items = (r && r.result && r.result.artists && r.result.artists.results) || [];
  return items.slice(0, limit).map((x) => {
    const uri = (x.cover && x.cover.uri) || x.ogImage;
    return { title: x.name, artist: x.name, sub: (x.genres || []).slice(0, 2).join(', '), image: uri ? 'https://' + uri.replace('%%', '600x600') : null, thumb: uri ? 'https://' + uri.replace('%%', '200x200') : null, source: 'Яндекс Музыка' };
  }).filter((x) => x.image);
}
async function geniusArtists(q) {
  const r = await getJson('https://genius.com/api/search/multi?per_page=5&q=' + encodeURIComponent(q));
  const out = [];
  for (const sec of (r && r.response && r.response.sections) || []) {
    for (const h of sec.hits || []) {
      const x = h.result;
      if (h.type === 'artist' && x && x.image_url && !/default_avatar/.test(x.image_url)) out.push({ title: x.name, artist: x.name, image: x.image_url, thumb: x.image_url, source: 'Genius' });
    }
  }
  return out;
}
async function artistImageSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const [y, d, g] = await Promise.all([yandexArtists(q), deezerArtists(q), geniusArtists(q)]);
  const seen = new Set();
  return [...y, ...d, ...g].filter((x) => !seen.has(x.image) && seen.add(x.image)).slice(0, 30);
}
// Автоматически — только если у найденного исполнителя есть трек из библиотеки (иначе легко взять тёзку)
async function findArtistImage(name, titles = []) {
  const before = netErrors;
  for (const title of titles.slice(0, 3)) {
    for (const src of [deezerTracks, yandexTracks, geniusSearch]) {
      const list = await src(`${name} ${title}`);
      for (const c of list) {
        if (sim(title, c.title) < 0.85) continue;
        const a = (c.artists || []).find((x) => sim(name, x.name) >= 0.95);
        if (!a) continue;
        const img = await fetchImage(a.image);
        if (img) return img;
      }
    }
  }
  return netErrors > before ? { retry: true } : null;
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
      // Фото исполнителей
      const alookup = this.lib.data.artistLookup;
      for (const [key, { name, titles }] of this.lib.artistNames()) {
        if (!this.lib.data.settings.autoCovers) break;
        if (this.lib.data.artistImages[key]) continue;
        const prev = alookup[key];
        if (prev && prev.none && Date.now() - prev.at < WEEK) continue;
        if (name === 'Неизвестный исполнитель') continue;
        const res = await findArtistImage(name, titles);
        if (res && res.retry) { await sleep(700); continue; }
        if (res) { this.lib.setArtistImage(key, res.buf, res.format, 'auto'); delete alookup[key]; }
        else alookup[key] = { none: true, at: Date.now() };
        this.lib.save();
        await sleep(700);
      }
    } finally {
      this.running = false;
    }
  }
}

// ---------- Internet Archive (archive.org) ----------
// Только законные коллекции: Creative Commons, разрешённые записи концертов, общественное достояние
const IA_CATS = {
  free: 'collection:netlabels AND mediatype:audio AND licenseurl:*creativecommons*',
  live: 'collection:etree AND mediatype:etree',
  old: 'collection:78rpm AND year:[1890 TO 1923] AND NOT title:(192* OR 193*)', // с запасом: записи до 1926 г. в США — общественное достояние
  classic: 'musopen AND mediatype:audio',
};
const iaStr = (v) => (Array.isArray(v) ? v[0] : v) || '';
async function iaSearch({ category = 'free', query = '', page = 1, sort = 'downloads' }) {
  const base = IA_CATS[category] || IA_CATS.free;
  const clean = String(query || '').replace(/[()"\[\]{}:\\]/g, ' ').trim();
  const q = clean ? `(${base}) AND (${clean})` : base;
  const params = new URLSearchParams({ q, rows: '48', page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'year', 'downloads']) params.append('fl[]', f);
  params.append('sort[]', sort === 'new' ? 'addeddate desc' : 'downloads desc');
  const r = await getJson('https://archive.org/advancedsearch.php?' + params, 20000);
  if (!r || !r.response) return null;
  return {
    total: r.response.numFound || 0,
    items: (r.response.docs || []).map((d) => ({
      id: d.identifier, title: iaStr(d.title) || d.identifier, creator: iaStr(d.creator), year: d.year || '', downloads: d.downloads || 0,
      cover: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
    })),
  };
}
function iaLength(v) {
  if (v == null) return 0;
  const sv = String(v);
  if (sv.includes(':')) return sv.split(':').reduce((acc, x) => acc * 60 + (parseFloat(x) || 0), 0);
  return parseFloat(sv) || 0;
}
const IA_FORMATS = ['VBR MP3', 'MP3', '320Kbps MP3', '256Kbps MP3', '128Kbps MP3', '64Kbps MP3', 'Ogg Vorbis', 'Flac', '24bit Flac'];
async function iaItem(id) {
  const d = await getJson('https://archive.org/metadata/' + encodeURIComponent(id), 20000);
  if (!d || !d.metadata) return null;
  const m = d.metadata;
  const title = iaStr(m.title) || id;
  const creator = iaStr(m.creator);
  // Группируем файлы одного трека (mp3/ogg/flac) и берём самый удобный формат
  const groups = new Map();
  for (const f of d.files || []) {
    const fmtRank = IA_FORMATS.indexOf(f.format);
    if (fmtRank < 0) continue;
    const base = f.name.replace(/\.[^.\/]+$/, '').replace(/_(vbr|64kb|128kb)$/i, '');
    const g = groups.get(base) || { files: [], title: '', artist: '', track: 0, length: 0 };
    g.files.push({ f, rank: fmtRank });
    g.title ||= f.title || '';
    g.artist ||= f.artist || f.creator || '';
    g.track ||= parseInt(String(f.track || '').split('/')[0], 10) || 0;
    g.length ||= iaLength(f.length);
    groups.set(base, g);
  }
  const tracks = [];
  for (const [base, g] of groups) {
    const best = g.files.sort((a, b) => a.rank - b.rank)[0].f;
    const nice = base.split('/').pop().replace(/^\d{1,3}[\s._-]+/, '').replace(/[_]+/g, ' ').trim();
    tracks.push({
      id: `ia:${id}/${best.name}`, iaId: id, name: best.name,
      title: g.title || nice || best.name, artist: g.artist || creator || 'Неизвестный исполнитель', album: title,
      duration: g.length, trackNo: g.track, size: parseInt(best.size, 10) || 0, format: best.format,
      url: `https://archive.org/download/${encodeURIComponent(id)}/${best.name.split('/').map(encodeURIComponent).join('/')}`,
      cover: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    });
  }
  tracks.sort((a, b) => (a.trackNo || 999) - (b.trackNo || 999) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const desc = iaStr(m.description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    id, title, creator, year: ((iaStr(m.year) || iaStr(m.date).slice(0, 4)).replace(/^0+$/, '')), description: decodeEntities(desc).slice(0, 600),
    license: iaStr(m.licenseurl), cover: `https://archive.org/services/img/${encodeURIComponent(id)}`,
    page: `https://archive.org/details/${encodeURIComponent(id)}`, tracks: tracks.slice(0, 400),
  };
}
// Скачивание файла из архива (для «Сохранить в библиотеку»)
async function iaDownload(url, dest, onProgress) {
  if (!/^https:\/\/archive\.org\/download\//.test(url)) throw new Error('bad url');
  const res = await net.fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  const fs = require('fs');
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let done = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    onProgress && onProgress(done, total);
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  fs.renameSync(tmp, dest);
  return dest;
}

// ---------- SoundCloud (официальный API, ключи пользователя) ----------
// Документация: https://developers.soundcloud.com/docs/api/guide — поиск и воспроизведение внутри приложения разрешены,
// скачивание — нет. Адреса можно подменить переменными окружения для тестов.
const SC_API = process.env.TEMBR_SC_API || 'https://api.soundcloud.com';
const SC_AUTH = process.env.TEMBR_SC_AUTH || 'https://secure.soundcloud.com/oauth/token';
const scState = { token: null, exp: 0, key: '' };

async function scToken(creds, force = false) {
  if (!creds || !creds.clientId || !creds.clientSecret) throw Object.assign(new Error('Не указаны ключи SoundCloud'), { code: 'nokeys' });
  const key = creds.clientId + ':' + creds.clientSecret;
  if (!force && scState.token && scState.key === key && Date.now() < scState.exp - 60000) return scState.token;
  const res = await net.fetch(SC_AUTH, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(key).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8', 'User-Agent': UA },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw Object.assign(new Error(res.status === 401 || res.status === 400 ? 'SoundCloud не принял ключи — проверьте Client ID и Client Secret' : 'SoundCloud недоступен (' + res.status + ')'), { code: res.status === 401 || res.status === 400 ? 'badkeys' : 'net' });
  const j = await res.json();
  scState.token = j.access_token;
  scState.exp = Date.now() + (j.expires_in || 3600) * 1000;
  scState.key = key;
  return scState.token;
}
async function scGet(creds, pathOrUrl, retry = true) {
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : SC_API + pathOrUrl;
  const token = await scToken(creds);
  const res = await net.fetch(url, { headers: { Authorization: 'OAuth ' + token, Accept: 'application/json; charset=utf-8', 'User-Agent': UA } });
  if (res.status === 401 && retry) { scState.token = null; return scGet(creds, pathOrUrl, false); }
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error('Ошибка SoundCloud: ' + res.status), { code: 'net' });
  return res.json();
}
function scTrack(x) {
  if (!x || x.kind !== 'track') return null;
  const art = x.artwork_url || (x.user && x.user.avatar_url) || '';
  return {
    id: 'sc:' + x.id, scId: x.id, source: 'sc',
    title: x.title || 'Без названия', artist: (x.user && x.user.username) || (x.publisher_metadata && x.publisher_metadata.artist) || '',
    album: 'SoundCloud', duration: (x.duration || 0) / 1000, cover: art ? art.replace('-large.', '-t500x500.') : null,
    permalink: x.permalink_url || '', access: x.access || (x.streamable === false ? 'blocked' : 'playable'),
    genre: x.genre || '', plays: x.playback_count || 0,
  };
}
async function scSearch(creds, q, next) {
  const j = await scGet(creds, next || `/tracks?linked_partitioning=true&limit=40&q=${encodeURIComponent(q)}`);
  const list = j ? (Array.isArray(j) ? j : j.collection || []) : [];
  return { tracks: list.map(scTrack).filter((t) => t && t.access !== 'blocked'), next: (j && j.next_href) || null };
}
// Ссылка с сайта: трек, плейлист/альбом или профиль
async function scResolve(creds, link) {
  const j = await scGet(creds, '/resolve?url=' + encodeURIComponent(link));
  if (!j) return null;
  if (j.kind === 'track') return { kind: 'track', title: j.title, tracks: [scTrack(j)].filter(Boolean) };
  if (j.kind === 'playlist') {
    let tracks = (j.tracks || []).map(scTrack).filter(Boolean);
    if (!tracks.length && j.id) { const t = await scGet(creds, `/playlists/${j.id}/tracks?limit=200`); tracks = (Array.isArray(t) ? t : (t && t.collection) || []).map(scTrack).filter(Boolean); }
    return { kind: 'playlist', title: j.title, cover: j.artwork_url ? j.artwork_url.replace('-large.', '-t500x500.') : null, tracks: tracks.filter((t) => t.access !== 'blocked') };
  }
  if (j.kind === 'user') {
    const t = await scGet(creds, `/users/${j.id}/tracks?linked_partitioning=true&limit=100`);
    const list = t ? (Array.isArray(t) ? t : t.collection || []) : [];
    return { kind: 'user', title: j.username, cover: j.avatar_url ? j.avatar_url.replace('-large.', '-t500x500.') : null, tracks: list.map(scTrack).filter((x) => x && x.access !== 'blocked') };
  }
  return null;
}
// Адрес потока: API отвечает перенаправлением на временную ссылку, её и отдаём плееру
async function scStream(creds, scId) {
  const j = await scGet(creds, `/tracks/${encodeURIComponent(scId)}/streams`);
  const api = j && (j.http_mp3_128_url || j.preview_mp3_128_url);
  if (!api) return null;
  const token = await scToken(creds);
  const { net: enet } = require('electron');
  return new Promise((resolve) => {
    const req = enet.request({ url: api, redirect: 'manual' });
    req.setHeader('Authorization', 'OAuth ' + token);
    req.setHeader('User-Agent', UA);
    req.on('redirect', (_st, _m, location) => { resolve(location); req.abort(); });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { const u = JSON.parse(body).url; resolve(u || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
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

module.exports = { scToken, scSearch, scResolve, scStream, iaSearch, iaItem, iaDownload, artistImageSearch, findArtistImage, lyrics, lyricsSearch, geniusLyrics, parseGeniusLyrics, CoverQueue, findCover, coverSearch, fetchImage, radioSearch, radioClick, sim, artistSim };
