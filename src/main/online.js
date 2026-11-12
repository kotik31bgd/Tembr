// Онлайн-сервисы: тексты песен (LRCLIB), обложки (MusicBrainz + Cover Art Archive), интернет-радио (Radio Browser).
const { net } = require('electron');

const UA = 'TembrPlayer/1.0 (desktop music player)';

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
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

async function lyrics({ title, artist, album, duration }) {
  if (!title) return null;
  const t = cleanTitle(title);
  const a = (artist || '').split(/[,&;]| feat\.? | ft\.? /i)[0].trim();
  if (a) {
    const q = new URLSearchParams({ track_name: t, artist_name: a });
    if (album) q.set('album_name', album);
    if (duration) q.set('duration', Math.round(duration));
    let r = await getJson('https://lrclib.net/api/get?' + q);
    if (!r && album) {
      q.delete('album_name');
      r = await getJson('https://lrclib.net/api/get?' + q);
    }
    if (r && (r.syncedLyrics || r.plainLyrics || r.instrumental)) return pack(r);
  }
  const s = await getJson('https://lrclib.net/api/search?' + new URLSearchParams({ q: `${a} ${t}`.trim() }));
  if (Array.isArray(s) && s.length) {
    const best = s.find((x) => x.syncedLyrics) || s[0];
    return pack(best);
  }
  return null;
}

function pack(r) {
  return { synced: r.syncedLyrics || null, plain: r.plainLyrics || null, instrumental: !!r.instrumental, source: 'LRCLIB' };
}

// ---------- Обложки ----------
const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');

async function findCover({ artist, album, title }) {
  let releaseIds = [];
  if (album) {
    const q = `release:"${esc(album)}"` + (artist ? ` AND artist:"${esc(artist)}"` : '');
    const r = await getJson('https://musicbrainz.org/ws/2/release/?fmt=json&limit=5&query=' + encodeURIComponent(q));
    if (r && r.releases) releaseIds = r.releases.filter((x) => (x.score || 0) >= 80).map((x) => x.id);
  } else if (title && artist) {
    const q = `recording:"${esc(cleanTitle(title))}" AND artist:"${esc(artist)}"`;
    const r = await getJson('https://musicbrainz.org/ws/2/recording/?fmt=json&limit=3&query=' + encodeURIComponent(q));
    if (r && r.recordings) {
      for (const rec of r.recordings.filter((x) => (x.score || 0) >= 85)) {
        for (const rel of rec.releases || []) releaseIds.push(rel.id);
      }
    }
  }
  for (const id of releaseIds.slice(0, 4)) {
    try {
      const res = await net.fetch(`https://coverartarchive.org/release/${id}/front-500`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 1000) return { buf, format: res.headers.get('content-type') || 'image/jpeg' };
      }
    } catch {}
    await sleep(1100);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фоновая очередь поиска обложек (MusicBrainz разрешает ~1 запрос в секунду)
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
        if (t.cover || !(t.artist || t.albumArtist)) continue;
        const artist = t.albumArtist || t.artist;
        const key = (t.album ? `al:${artist}|${t.album}` : `tr:${artist}|${t.title}`).toLowerCase();
        if (!groups.has(key)) groups.set(key, { artist, album: t.album, title: t.title, ids: [] });
        groups.get(key).ids.push(t.id);
      }
      const lookup = this.lib.data.coverLookup;
      const WEEK = 7 * 24 * 3600 * 1000;
      for (const [key, g] of groups) {
        if (!this.lib.data.settings.autoCovers) break;
        const prev = lookup[key];
        if (prev && prev.none && Date.now() - prev.at < WEEK) continue;
        const res = await findCover(g);
        if (res) {
          this.lib.setOnlineCover(g.ids, res.buf, res.format);
          delete lookup[key];
        } else {
          lookup[key] = { none: true, at: Date.now() };
        }
        this.lib.save();
        await sleep(1100);
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

module.exports = { lyrics, CoverQueue, radioSearch, radioClick };
