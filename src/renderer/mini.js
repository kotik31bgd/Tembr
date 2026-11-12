'use strict';
/* global icon */
const $ = (s) => document.querySelector(s);
let st = { playing: false, position: 0, duration: 0, track: null };
let tickBase = { pos: 0, at: 0 };

$('#prev').innerHTML = icon('prev');
$('#next').innerHTML = icon('next');
$('#expand').innerHTML = icon('expand');

const send = (cmd, arg) => window.api.command(cmd, arg);
$('#prev').onclick = () => send('prev');
$('#next').onclick = () => send('next');
$('#play').onclick = () => send('toggle');
$('#like').onclick = () => send('like');
$('#expand').onclick = () => send('expand');
$('.m-cover').ondblclick = () => send('expand');
$('#bar').onclick = (e) => {
  if (!st.duration || st.live) return;
  const r = e.currentTarget.getBoundingClientRect();
  send('seek', ((e.clientX - r.left) / r.width) * st.duration);
};
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); send('toggle'); }
  if (e.code === 'Escape') send('expand');
});

function render() {
  const t = st.track;
  $('#title').textContent = t ? t.title : 'Ничего не играет';
  $('#artist').textContent = t ? t.artist : 'Tembr';
  const c = $('#cover');
  c.style.backgroundImage = t && t.cover ? `url('${t.cover.replace(/'/g, '%27')}')` : '';
  c.style.backgroundSize = st.live ? 'contain' : 'cover';
  c.innerHTML = t && t.cover ? '' : icon(st.live ? 'radio' : 'music');
  $('#blur').style.backgroundImage = c.style.backgroundImage;
  $('#play').innerHTML = icon(st.playing ? 'pause' : 'play');
  $('#like').innerHTML = icon(st.liked ? 'heartFill' : 'heart');
  $('#like').classList.toggle('on', !!st.liked);
  $('#like').style.visibility = t && !st.live ? 'visible' : 'hidden';
  document.title = t ? `${t.title} — ${t.artist}` : 'Tembr';
}

function tick() {
  let pos = tickBase.pos;
  if (st.playing) pos += (performance.now() - tickBase.at) / 1000;
  const f = st.duration && !st.live ? Math.min(1, pos / st.duration) : 0;
  $('#bar div').style.width = f * 100 + '%';
  requestAnimationFrame(tick);
}

window.api.onState((s) => {
  st = s;
  tickBase = { pos: s.position, at: performance.now() };
  render();
});
window.api.onSettings((s) => {
  document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
  const acc = (s.accent || '#7c5cff').toLowerCase() === '#ffffff' && s.theme === 'light' ? '#1c1f3b' : (s.accent || '#7c5cff');
  document.documentElement.style.setProperty('--accent', acc);
});
render();
requestAnimationFrame(tick);
