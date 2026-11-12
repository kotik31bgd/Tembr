const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, Tray, nativeImage, shell, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { Library, isAudio } = require('./library');
const online = require('./online');
const { autoUpdater } = require('electron-updater');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  { scheme: 'tmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.tembr.player');

let lib, coverQueue, mainWin, miniWin, tray;
let quitting = false;
let playerState = { playing: false, track: null, position: 0, duration: 0 };

const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && isAudio(a) && fs.existsSync(a));
}

// ---------- Протокол tmedia:// для локальных файлов (с поддержкой перемотки) ----------
function registerMediaProtocol() {
  protocol.handle('tmedia', async (req) => {
    try {
      const u = new URL(req.url);
      const p = decodeURIComponent(u.pathname.slice(1));
      if (!lib.isAllowed(p)) return new Response('forbidden', { status: 403 });
      const stat = await fs.promises.stat(p);
      const size = stat.size;
      const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
      const range = req.headers.get('range');
      const m = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : size - 1;
        if (!m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
        end = Math.min(end, size - 1);
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        const stream = fs.createReadStream(p, { start, end });
        return new Response(Readable.toWeb(stream), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(p)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  });
}

// Радиостанции обычно не отдают CORS-заголовки, а без них эквалайзер (Web Audio) глушит звук.
function allowCorsForMedia() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (details.resourceType === 'media' && /^https?:/.test(details.url)) {
      const h = { ...details.responseHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('access-control-allow-')) delete h[k];
      h['Access-Control-Allow-Origin'] = ['*'];
      cb({ responseHeaders: h });
    } else cb({});
  });
}

// ---------- Окна ----------
function themeColors() {
  const dark = lib.data.settings.theme !== 'light';
  return { bg: dark ? '#0b0b0c' : '#e9e6f3', symbol: dark ? '#e8e8ea' : '#202030' };
}

function createMainWindow() {
  const s = lib.data.settings.window || {};
  const c = themeColors();
  mainWin = new BrowserWindow({
    width: s.width || 1280,
    height: s.height || 800,
    x: s.x, y: s.y,
    minWidth: 900,
    minHeight: 580,
    show: false,
    backgroundColor: c.bg,
    title: 'Tembr',
    icon: path.join(ASSETS, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: c.symbol, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (s.maximized) mainWin.maximize();
  mainWin.removeMenu();
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());

  const saveBounds = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const maximized = mainWin.isMaximized();
    const b = maximized ? (lib.data.settings.window || {}) : mainWin.getBounds();
    lib.data.settings.window = { ...b, maximized };
    lib.save();
  };
  mainWin.on('resize', saveBounds);
  mainWin.on('move', saveBounds);
  mainWin.on('close', (e) => {
    if (!quitting && lib.data.settings.closeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; if (!quitting) app.quit(); });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  updateThumbar();
}

function createMiniWindow() {
  if (miniWin && !miniWin.isDestroyed()) return miniWin;
  const s = lib.data.settings.mini || {};
  const wa = screen.getPrimaryDisplay().workArea;
  miniWin = new BrowserWindow({
    width: 380,
    height: 120,
    x: s.x ?? wa.x + wa.width - 400,
    y: s.y ?? wa.y + wa.height - 140,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Tembr — мини-плеер',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  miniWin.loadFile(path.join(RENDERER, 'mini.html'));
  miniWin.on('moved', () => {
    const [x, y] = miniWin.getPosition();
    lib.data.settings.mini = { x, y };
    lib.save();
  });
  miniWin.on('closed', () => { miniWin = null; });
  return miniWin;
}

function toggleMini(force) {
  const showMini = force ?? !(miniWin && miniWin.isVisible());
  if (showMini) {
    const w = createMiniWindow();
    const reveal = () => { w.show(); w.webContents.send('player:state', playerState); sendSettings(w); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal); else reveal();
    mainWin?.hide();
  } else {
    miniWin?.hide();
    showMain();
  }
}

function showMain() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function sendSettings(w) {
  w.webContents.send('settings', { theme: lib.data.settings.theme, accent: lib.data.settings.accent });
}

// ---------- Кнопки на панели задач Windows и трей ----------
let tbIcons = null;
function icon(name) {
  const p = path.join(ASSETS, name);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

function updateThumbar() {
  if (process.platform !== 'win32' || !mainWin) return;
  tbIcons ||= { prev: icon('tb-prev.png'), play: icon('tb-play.png'), pause: icon('tb-pause.png'), next: icon('tb-next.png') };
  mainWin.setThumbarButtons([
    { tooltip: 'Предыдущий', icon: tbIcons.prev, click: () => sendCmd('prev') },
    { tooltip: playerState.playing ? 'Пауза' : 'Играть', icon: playerState.playing ? tbIcons.pause : tbIcons.play, click: () => sendCmd('toggle') },
    { tooltip: 'Следующий', icon: tbIcons.next, click: () => sendCmd('next') },
  ]);
}

function createTray() {
  tray = new Tray(icon(process.platform === 'win32' ? 'icon-32.png' : 'icon.png'));
  tray.setToolTip('Tembr');
  tray.on('click', () => (miniWin && miniWin.isVisible() ? miniWin.focus() : showMain()));
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const t = playerState.track;
  tray.setToolTip(t ? `${t.title}${t.artist ? ' — ' + t.artist : ''}`.slice(0, 120) : 'Tembr');
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(t ? [{ label: `${t.title}`.slice(0, 60), enabled: false }, { type: 'separator' }] : []),
    { label: playerState.playing ? 'Пауза' : 'Играть', click: () => sendCmd('toggle') },
    { label: 'Следующий', click: () => sendCmd('next') },
    { label: 'Предыдущий', click: () => sendCmd('prev') },
    { type: 'separator' },
    { label: 'Показать Tembr', click: () => toggleMini(false) },
    { label: 'Мини-плеер', click: () => toggleMini(true) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function sendCmd(cmd, arg) {
  mainWin?.webContents.send('player:command', { cmd, arg });
}

function broadcast(channel, payload) {
  mainWin?.webContents.send(channel, payload);
}

// ---------- IPC ----------
function setupIpc() {
  ipcMain.handle('lib:init', () => ({
    tracks: lib.tracksList(),
    folders: lib.data.folders,
    playlists: lib.data.playlists,
    stats: lib.data.stats,
    radioFavs: lib.data.radioFavs,
    artistImages: lib.data.artistImages,
    settings: lib.data.settings,
    dataDir: lib.dataDir,
    platform: process.platform,
    version: app.getVersion(),
    openFiles: pendingOpen.splice(0),
  }));

  ipcMain.handle('lib:addFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Выберите папку с музыкой', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return lib.data.folders;
    for (const f of r.filePaths) lib.addFolder(f).then(() => coverQueue.run());
    return lib.data.folders;
  });
  ipcMain.handle('lib:addFiles', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Добавить файлы', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Аудио', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'webm', 'aiff'] }],
    });
    if (r.canceled) return [];
    const ids = await lib.addPaths(r.filePaths);
    coverQueue.run();
    return ids;
  });
  ipcMain.handle('lib:removeFolder', (_e, f) => { lib.removeFolder(f); return lib.data.folders; });
  ipcMain.handle('lib:addPaths', async (_e, paths) => {
    const ids = await lib.addPaths(paths);
    coverQueue.run();
    return { ids, folders: lib.data.folders };
  });
  ipcMain.handle('lib:rescan', async () => { await lib.rescanAll(); coverQueue.run(); return true; });

  ipcMain.on('store:set', (_e, key, value) => {
    if (!['playlists', 'stats', 'radioFavs'].includes(key)) return;
    lib.data[key] = value;
    lib.save();
  });
  ipcMain.on('settings:set', (_e, patch) => {
    const before = { ...lib.data.settings };
    Object.assign(lib.data.settings, patch);
    lib.save();
    if (patch.theme && patch.theme !== before.theme && mainWin) {
      const c = themeColors();
      try { mainWin.setTitleBarOverlay({ color: '#00000000', symbolColor: c.symbol, height: 44 }); } catch {}
      mainWin.setBackgroundColor(c.bg);
    }
    if ((patch.theme || patch.accent) && miniWin) sendSettings(miniWin);
    if (patch.autoCovers && !before.autoCovers) coverQueue.run();
  });

  const lyricsKey = (t) => `${t.artist}|${t.title}`.toLowerCase();
  ipcMain.handle('lyrics:get', async (_e, t) => {
    const ov = t.id && lib.data.lyricsOverride[t.id];
    if (ov) return { ...ov, source: ov.source || 'вручную', manual: true };
    const key = lyricsKey(t);
    const cache = lib.data.lyricsCache;
    if (cache[key] && (cache[key].synced || cache[key].plain || cache[key].instrumental)) return cache[key];
    if (cache[key] && cache[key].none && Date.now() - cache[key].at < 3 * 24 * 3600 * 1000) return null;
    const r = await online.lyrics(t);
    if (r && r.retry) return r; // нет сети — не запоминаем
    cache[key] = r || { none: true, at: Date.now() };
    lib.save();
    return r;
  });
  ipcMain.handle('lyrics:search', (_e, q) => online.lyricsSearch(q));
  ipcMain.handle('lyrics:genius', (_e, url) => online.geniusLyrics(url));
  // Сохранить текст для конкретного трека (из поиска или вставленный вручную); null — убрать
  ipcMain.handle('lyrics:set', (_e, id, data) => {
    if (data && (data.synced || data.plain)) lib.data.lyricsOverride[id] = { synced: data.synced || null, plain: data.plain || null, source: data.source || 'вручную' };
    else delete lib.data.lyricsOverride[id];
    lib.save();
    return true;
  });

  // ---------- Обложки вручную ----------
  ipcMain.handle('cover:search', (_e, q) => online.coverSearch(q));
  ipcMain.handle('cover:apply', async (_e, ids, url) => {
    const img = /^https:/.test(url) ? await online.fetchImage(url) : null;
    if (!img) return false;
    lib.setTrackCover(ids, img.buf, img.format, 'manual');
    return true;
  });
  ipcMain.handle('cover:file', async (_e, ids) => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Выберите картинку для обложки', properties: ['openFile'], filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    const buf = await fs.promises.readFile(r.filePaths[0]);
    lib.setTrackCover(ids, buf, path.extname(r.filePaths[0]), 'manual');
    return true;
  });
  // ---------- Фото исполнителей ----------
  ipcMain.handle('artist:search', (_e, q) => online.artistImageSearch(q));
  ipcMain.handle('artist:apply', async (_e, key, url) => {
    const img = /^https:/.test(url) ? await online.fetchImage(url) : null;
    if (!img) return false;
    lib.setArtistImage(key, img.buf, img.format, 'manual');
    return true;
  });
  ipcMain.handle('artist:file', async (_e, key) => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Выберите фото исполнителя', properties: ['openFile'], filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    lib.setArtistImage(key, await fs.promises.readFile(r.filePaths[0]), path.extname(r.filePaths[0]), 'manual');
    return true;
  });
  ipcMain.handle('artist:reset', (_e, key, auto) => {
    lib.resetArtistImage(key, !!auto);
    if (auto) coverQueue.run();
    return true;
  });
  ipcMain.handle('cover:reset', (_e, ids, auto) => {
    lib.resetCover(ids, !!auto);
    if (auto) coverQueue.run();
    return true;
  });

  ipcMain.handle('radio:search', (_e, q) => online.radioSearch(q));
  ipcMain.on('radio:click', (_e, id) => online.radioClick(id));

  ipcMain.on('shell:showItem', (_e, p) => shell.showItemInFolder(p));
  ipcMain.on('shell:openPath', (_e, p) => shell.openPath(p));
  ipcMain.on('shell:openExternal', (_e, url) => /^https?:/.test(url) && shell.openExternal(url));
  ipcMain.handle('cache:clear', () => {
    lib.data.lyricsCache = {};
    lib.data.coverLookup = {};
    lib.save();
    coverQueue.run();
    return true;
  });

  // Состояние плеера: главное окно → мини-плеер, трей, панель задач
  ipcMain.on('player:state', (_e, st) => {
    const playingChanged = st.playing !== playerState.playing;
    const trackChanged = (st.track && st.track.id) !== (playerState.track && playerState.track.id);
    playerState = st;
    if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('player:state', st);
    if (playingChanged || trackChanged) { updateThumbar(); updateTray(); }
    if (mainWin && trackChanged) mainWin.setTitle(st.track ? `${st.track.title}${st.track.artist ? ' — ' + st.track.artist : ''} · Tembr` : 'Tembr');
  });
  ipcMain.on('player:command', (_e, c) => {
    if (c.cmd === 'expand') return toggleMini(false);
    if (c.cmd === 'closeMini') return toggleMini(false);
    sendCmd(c.cmd, c.arg);
  });
  ipcMain.on('win:mini', (_e, on) => toggleMini(on));
  ipcMain.on('app:quit', () => { quitting = true; app.quit(); });
}

// ---------- Автообновление (через GitHub Releases) ----------
let updateState = { state: app.isPackaged ? 'idle' : 'dev' };
function setUpdate(st) {
  updateState = st;
  broadcast('update', st);
}
function setupUpdater() {
  ipcMain.handle('update:get', () => updateState);
  ipcMain.handle('update:check', () => {
    if (!app.isPackaged) return updateState;
    setUpdate({ state: 'checking' });
    autoUpdater.checkForUpdates().catch((e) => setUpdate({ state: 'error', message: String(e.message || e) }));
    return updateState;
  });
  ipcMain.on('update:install', () => {
    if (updateState.state !== 'ready') return;
    quitting = true;
    lib?.close();
    autoUpdater.quitAndInstall(true, true);
  });
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', message: String((e && e.message) || e).slice(0, 200) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 3 * 3600 * 1000);
}

// ---------- Запуск ----------
const pendingOpen = [];

app.on('second-instance', async (_e, argv) => {
  const files = filesFromArgv(argv);
  if (files.length && lib) {
    const ids = await lib.addPaths(files);
    broadcast('open-files', ids);
  }
  if (miniWin && miniWin.isVisible()) miniWin.focus(); else showMain();
});

app.whenReady().then(async () => {
  lib = new Library(app.getPath('userData'));
  coverQueue = new online.CoverQueue(lib);
  registerMediaProtocol();
  allowCorsForMedia();
  setupIpc();
  setupUpdater();

  const files = filesFromArgv(process.argv);
  if (files.length) pendingOpen.push(...(await lib.addPaths(files)));

  // Первый запуск: предложим стандартную папку «Музыка»
  if (!lib.data.settings.initialized) {
    lib.data.settings.initialized = true;
    const music = app.getPath('music');
    if (music && fs.existsSync(music) && !lib.data.folders.length) lib.data.folders.push(music);
    lib.save();
  }

  createMainWindow();
  createTray();

  lib.on('tracks', () => broadcast('lib:tracks', lib.tracksList()));
  lib.on('artists', () => broadcast('lib:artists', lib.data.artistImages));
  lib.on('progress', (p) => broadcast('lib:progress', p));
  lib.on('scanned', () => coverQueue.run());

  lib.restartWatcher();
  // Досканируем папки при старте: подхватим всё, что появилось, пока плеер был закрыт
  setTimeout(() => lib.rescanAll().then(() => coverQueue.run()), 1500);
});

app.on('before-quit', () => { quitting = true; lib?.close(); });
app.on('window-all-closed', () => app.quit());
