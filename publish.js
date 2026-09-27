#!/usr/bin/env node
// Turns a studio export (<slug>.saymyname.json) into a published card under
// docs/, which GitHub Pages serves on the domain named in docs/CNAME:
//
//   docs/<slug>.m4a         the audio — link here and a click plays at once
//   docs/<slug>/index.html  the card page — link here for the preview card
//   docs/<slug>/card.png    what Slack, Teams, LinkedIn and WhatsApp show
//
// macOS only: afconvert does the AAC encode and Chrome renders the image.
//
//   node publish.js ~/Downloads/prantosh.saymyname.json
//
// serve.js calls publish() directly when Publish is pressed in the studio.

const fs = require('fs'), path = require('path'), os = require('os');
const {execFileSync, spawn} = require('child_process');

const DOCS = path.join(__dirname, 'docs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function die(msg){ throw new Error(msg); }

const esc = v => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function domain(){
  const f = path.join(DOCS, 'CNAME');
  if(!fs.existsSync(f)) die('no docs/CNAME — put your domain in it first, e.g. name.example.com');
  return fs.readFileSync(f, 'utf8').trim();
}

// Headless Chrome writes the screenshot and then, on some versions, never
// exits. Wait for the file to appear and settle, then stop it ourselves.
function screenshot(html, png, profile){
  return new Promise((resolve, reject) => {
    if(fs.existsSync(png)) fs.rmSync(png);
    const p = spawn(CHROME, [
      '--headless=new', '--hide-scrollbars', '--window-size=1200,630',
      '--virtual-time-budget=4000', `--user-data-dir=${profile}`,
      `--screenshot=${png}`, 'file://' + html
    ], {stdio: 'ignore'});
    let last = -1, waited = 0;
    const t = setInterval(() => {
      waited += 250;
      const size = fs.existsSync(png) ? fs.statSync(png).size : 0;
      const done = size > 0 && size === last;
      last = size;
      if(done || waited > 20000){
        clearInterval(t); p.kill('SIGKILL');
        done ? resolve() : reject(new Error('Chrome did not produce the preview image'));
      }
    }, 250);
    p.on('error', e => { clearInterval(t); reject(e); });
  });
}

async function publish(job){
  const slug = String(job.slug || '').toLowerCase();
  if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) die('bad slug in the file: ' + job.slug);
  if(!job.name) die('the file has no name in it');
  if(!job.audio) die('the file has no audio in it');

  const base = 'https://' + domain();

  const name = job.name, phon = job.phonetic || '';
  const pageUrl = `${base}/${slug}/`, audioUrl = `${base}/${slug}.m4a`, imgUrl = `${base}/${slug}/card.png`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saymyname-'));
  const outDir = path.join(DOCS, slug);
  fs.mkdirSync(outDir, {recursive: true});

  // ---- audio: WAV in, AAC out. Mono at 64 kbps keeps a name to ~20 KB, and
  // .m4a plays in every current browser, where WebM does not play in Safari.
  const wav = path.join(tmp, 'in.wav');
  const wavBytes = Buffer.from(job.audio, 'base64');
  fs.writeFileSync(wav, wavBytes);
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', '-c', '1', wav, path.join(DOCS, slug + '.m4a')]);

  const bars = peaks(wavBytes, 48);
  const seconds = wavSeconds(wavBytes);

  // ---- the card page and the preview image --------------------------------
  fs.writeFileSync(path.join(outDir, 'index.html'),
    cardPage({name, phon, slug, pageUrl, audioUrl, imgUrl, bars, seconds, host: domain()}));
  const ogHtml = path.join(tmp, 'og.html');
  fs.writeFileSync(ogHtml, ogImage({name, phon, bars, host: domain()}));

  const png = path.join(outDir, 'card.png');
  try{ await screenshot(ogHtml, png, path.join(tmp, 'chrome')); }
  finally{
    // Chrome may still be closing and writing to its profile; retry, and
    // never fail a publish over a leftover temp folder.
    try{ fs.rmSync(tmp, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}); }catch(e){}
  }

  return {
    slug, name, phonetic: phon, page: pageUrl, audio: audioUrl,
    audioKB: Math.round(fs.statSync(path.join(DOCS, slug + '.m4a')).size / 1024),
    signature: `<a href="${audioUrl}" title="${esc('Hear how to say ' + name)}" style="text-decoration:none">🔊</a>`,
    files: [`docs/${slug}.m4a`, `docs/${slug}`]
  };
}

// ---- measuring the recording ----------------------------------------------

// The PCM samples of a 16-bit mono WAV, found by walking the chunks rather
// than assuming the data starts at byte 44.
function pcm(buf){
  let o = 12, fmt = null;
  while(o + 8 <= buf.length){
    const id = buf.toString('ascii', o, o+4), size = buf.readUInt32LE(o+4);
    if(id === 'fmt ') fmt = {channels: buf.readUInt16LE(o+10), rate: buf.readUInt32LE(o+12), bits: buf.readUInt16LE(o+22)};
    if(id === 'data'){
      if(!fmt || fmt.bits !== 16) die('expected 16-bit WAV audio');
      const n = Math.floor(Math.min(size, buf.length-o-8) / 2 / fmt.channels);
      const out = new Float32Array(n);
      for(let i=0;i<n;i++) out[i] = buf.readInt16LE(o + 8 + i*2*fmt.channels) / 32768;
      return {samples: out, rate: fmt.rate};
    }
    o += 8 + size + (size & 1);
  }
  die('no audio data in the WAV');
}

function wavSeconds(buf){ const {samples, rate} = pcm(buf); return samples.length / rate; }

// Bar heights for the waveform, 0–1. The same treatment the studio uses:
// loudness (RMS) per bar, room tone subtracted so silence draws flat, the
// scale set by the 98th percentile so one pop cannot flatten everything, and a
// gentle curve so quiet consonants — the "-sh" of a name — still show.
function peaks(buf, n){
  const {samples} = pcm(buf);
  const raw = [];
  for(let i=0;i<n;i++){
    const s = Math.floor(i*samples.length/n), e = Math.max(s+1, Math.floor((i+1)*samples.length/n));
    let q = 0; for(let j=s;j<e;j++) q += samples[j]*samples[j];
    raw.push(Math.sqrt(q/(e-s)));
  }
  const sorted = [...raw].sort((a,b)=>a-b), at = f => sorted[Math.min(n-1, Math.floor(n*f))];
  const floor = at(0.2), ceil = at(0.98);
  const gate = floor < ceil*0.5 ? floor*1.6 : 0, span = Math.max(1e-6, ceil-gate);
  return raw.map(v => +Math.max(0.06, Math.pow(Math.min(1, Math.max(0, v-gate)/span), 0.65)).toFixed(3));
}

// ---- pages -----------------------------------------------------------------

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;1,6..72,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';

// A voice message, not a web page: the real waveform of the recording beside
// a play button, filling in as it plays. Tapping the wave plays from there.
function cardPage({name, phon, slug, pageUrl, audioUrl, imgUrl, bars, seconds, host}){
  const title = `How to say ${name}`;
  const summary = phon ? `${name} — said “${phon}”. Tap to hear it.` : `Tap to hear how ${name} says it.`;
  const W = bars.length*6, H = 44;
  const rects = bars.map((v,i) => {
    const h = Math.max(3, v*H);
    return `<rect x="${i*6+1}" y="${((H-h)/2).toFixed(1)}" width="3.4" height="${h.toFixed(1)}" rx="1.7"/>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(summary)}">
<meta name="theme-color" content="#EDF1F6">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Say My Name">
<meta property="og:title" content="${esc('🔊 ' + name + (phon ? ' — ' + phon : ''))}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(imgUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:audio" content="${esc(audioUrl)}">
<meta property="og:audio:type" content="audio/mp4">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%2314203A'/%3E%3Cpath d='M12 9.5v13l10-6.5z' fill='%23fff'/%3E%3C/svg%3E">
${FONTS}
<style>
  :root{
    --paper:#EDF1F6;--paper-2:#E2E9F2;--ink:#14203A;--ink-soft:#6C7B94;--line:#D5DDE8;
    --card:#FFFFFF;--well:#F4F7FA;--accent:#2E9C87;--accent-soft:#D8EFEA;--bar:#B9C5D6;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --paper:#0D1422;--paper-2:#111B2E;--ink:#E8EDF5;--ink-soft:#8E9BB2;--line:#223049;
      --card:#151F33;--well:#1B263D;--accent:#4FC3AA;--accent-soft:#17362F;--bar:#3A4A66;
    }
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    min-height:100vh;display:flex;flex-direction:column;align-items:center;
    background:radial-gradient(1100px 600px at 50% -10%, var(--paper-2), var(--paper) 60%) fixed, var(--paper);
    color:var(--ink);padding:20px 16px 28px;
    font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
  }
  .top{width:100%;max-width:460px;display:flex;justify-content:space-between;align-items:center}
  .brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;
         font-family:Newsreader,Georgia,serif;font-size:17px}
  .brand i{width:22px;height:22px;border-radius:50%;background:var(--ink);display:grid;place-items:center}
  .brand i::after{content:"";border-left:7px solid var(--card);border-top:4.5px solid transparent;border-bottom:4.5px solid transparent;margin-left:2px}
  main{flex:1;display:flex;align-items:center;width:100%;max-width:460px}
  .card{
    width:100%;background:var(--card);border:1px solid var(--line);border-radius:24px;
    padding:34px 26px 24px;box-shadow:0 1px 0 rgba(20,32,58,.03),0 24px 60px -32px rgba(20,32,58,.35);
  }
  .eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft)}
  h1{font-family:Newsreader,Georgia,serif;font-weight:400;font-size:clamp(34px,9vw,46px);line-height:1.06;
     letter-spacing:-0.022em;margin:10px 0 0;word-break:break-word}
  .phon{display:inline-flex;align-items:center;gap:8px;margin-top:14px;padding:6px 12px 6px 10px;
        border-radius:999px;background:var(--accent-soft);color:var(--ink);font-size:15.5px}
  .phon b{font-weight:600;letter-spacing:.02em}
  .phon span{font-size:12px;color:var(--ink-soft)}

  .player{margin-top:26px;display:flex;align-items:center;gap:14px;padding:12px 16px 12px 12px;
          background:var(--well);border:1px solid var(--line);border-radius:18px}
  .play{flex:none;width:58px;height:58px;border-radius:50%;border:none;cursor:pointer;
        background:var(--ink);color:var(--card);display:grid;place-items:center;position:relative;
        transition:transform .08s ease, background .15s}
  .play:active{transform:scale(.95)}
  .play:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
  .play svg{width:24px;height:24px}
  .play .pause{display:none}
  .play.on{background:var(--accent)}
  .play.on .tri{display:none} .play.on .pause{display:block}
  .play.nudge::before{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--accent);
        animation:ring 1.6s ease-out infinite}
  @keyframes ring{from{opacity:.9;transform:scale(.92)}to{opacity:0;transform:scale(1.25)}}
  @media (prefers-reduced-motion:reduce){.play.nudge::before{animation:none;opacity:.7}}
  .wave{flex:1;min-width:0;cursor:pointer}
  .wave svg{display:block;width:100%;height:44px}
  .wave .base rect{fill:var(--bar)}
  .wave .done rect{fill:var(--accent)}
  .time{flex:none;font-size:13px;color:var(--ink-soft);font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
  .hint{font-size:13px;color:var(--ink-soft);margin:12px 2px 0;min-height:1.3em}

  .actions{display:flex;gap:10px;margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
  .actions button,.actions a{
    flex:1;display:flex;align-items:center;justify-content:center;gap:8px;
    font:500 14px Inter,sans-serif;color:var(--ink);background:transparent;text-decoration:none;
    border:1px solid var(--line);border-radius:12px;padding:11px 12px;cursor:pointer;
  }
  .actions button:hover,.actions a:hover{background:var(--well)}
  .actions svg{width:16px;height:16px}
  footer{font-size:12.5px;color:var(--ink-soft);text-align:center;max-width:460px;line-height:1.5}
  footer a{color:inherit}
</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><i></i>Say My Name</a>
</header>

<main>
  <article class="card">
    <div class="eyebrow">How to say</div>
    <h1>${esc(name)}</h1>
    ${phon ? `<div class="phon"><span>say</span><b>${esc(phon)}</b></div>` : ''}

    <div class="player">
      <button class="play" id="play" aria-label="Play how ${esc(name)} is said">
        <svg class="tri" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>
        <svg class="pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>
      </button>
      <div class="wave" id="wave" role="slider" aria-label="Position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs><clipPath id="cp"><rect id="cpr" x="0" y="0" width="0" height="${H}"/></clipPath></defs>
          <g class="base">${rects}</g>
          <g class="done" clip-path="url(#cp)">${rects}</g>
        </svg>
      </div>
      <div class="time" id="time">${seconds.toFixed(1)}s</div>
    </div>
    <p class="hint" id="hint">In their own voice. Tap play.</p>

    <div class="actions">
      <button id="copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg><span>Copy link</span></button>
      <a href="${esc(audioUrl)}" download="${esc(slug)}.m4a"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg><span>Audio file</span></a>
    </div>
  </article>
</main>

<footer>A name said the way its owner says it. <a href="/">${esc(host)}</a></footer>

<audio id="a" src="../${esc(slug)}.m4a" preload="auto"></audio>
<script>
(function(){
  const a = document.getElementById('a'), btn = document.getElementById('play'),
        wave = document.getElementById('wave'), clip = document.getElementById('cpr'),
        time = document.getElementById('time'), hint = document.getElementById('hint');
  const W = ${W}, TOTAL = ${seconds.toFixed(3)};
  let raf = 0;

  const dur = () => (isFinite(a.duration) && a.duration > 0) ? a.duration : TOTAL;
  function draw(){
    const f = Math.min(1, a.currentTime / dur());
    clip.setAttribute('width', (f*W).toFixed(1));
    wave.setAttribute('aria-valuenow', Math.round(f*100));
    time.textContent = a.paused && f === 0 ? dur().toFixed(1)+'s' : a.currentTime.toFixed(1)+'s';
    if(!a.paused) raf = requestAnimationFrame(draw);
  }
  function play(from){
    if(from != null) a.currentTime = from;
    else if(a.ended || a.currentTime >= dur() - 0.02) a.currentTime = 0;
    return a.play();
  }

  btn.addEventListener('click', () => {
    btn.classList.remove('nudge');
    if(!a.paused){ a.pause(); return; }
    play().catch(() => { hint.textContent = 'This browser would not play it. Try the audio file below.'; });
  });
  wave.addEventListener('click', e => {
    const r = wave.getBoundingClientRect();
    btn.classList.remove('nudge');
    play(Math.max(0, Math.min(1, (e.clientX - r.left)/r.width)) * dur()).catch(()=>{});
  });

  a.addEventListener('play', () => { btn.classList.add('on'); btn.setAttribute('aria-label','Pause'); hint.textContent = 'Playing…'; cancelAnimationFrame(raf); draw(); });
  a.addEventListener('pause', () => { btn.classList.remove('on'); btn.setAttribute('aria-label','Play'); draw(); });
  a.addEventListener('ended', () => { hint.textContent = 'Tap to hear it again.'; a.currentTime = 0; draw(); });
  a.addEventListener('seeked', draw);

  document.getElementById('copy').addEventListener('click', async () => {
    const url = location.href.split('#')[0];
    try{
      if(navigator.share && matchMedia('(pointer:coarse)').matches){ await navigator.share({title: document.title, url}); return; }
      await navigator.clipboard.writeText(url); hint.textContent = 'Link copied.';
    }catch(e){ hint.textContent = url; }
  });

  // Most browsers refuse sound on a page nobody has tapped yet. When one
  // allows it, play at once; otherwise draw the eye to the button.
  play().catch(() => btn.classList.add('nudge'));
})();
</script>
</body>
</html>
`;
}

// The preview Slack, Teams, LinkedIn and WhatsApp show: it should teach the
// pronunciation even to someone who never clicks.
function ogImage({name, phon, bars, host}){
  const rects = bars.map((v,i) => {
    const h = Math.max(6, v*96);
    return `<rect x="${i*13}" y="${((96-h)/2).toFixed(1)}" width="7" height="${h.toFixed(1)}" rx="3.5"/>`;
  }).join('');
  const size = name.length > 22 ? 78 : name.length > 14 ? 96 : 116;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${FONTS}
<style>
  html,body{margin:0;width:1200px;height:630px;overflow:hidden}
  body{background:radial-gradient(900px 500px at 50% -20%, #E2E9F2, #EDF1F6 65%);font-family:Inter,sans-serif;color:#14203A;
       display:flex;align-items:center;justify-content:center}
  .c{width:1090px;height:520px;background:#fff;border:2px solid #D5DDE8;border-radius:40px;box-sizing:border-box;
     padding:64px 84px;position:relative;box-shadow:0 30px 70px -40px rgba(20,32,58,.45)}
  .e{font-size:22px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#6C7B94}
  .n{font-family:Newsreader,Georgia,serif;font-size:${size}px;line-height:1.02;letter-spacing:-0.025em;margin-top:14px}
  .p{display:inline-block;margin-top:22px;padding:10px 24px;border-radius:999px;background:#D8EFEA;font-size:36px;font-weight:600}
  .row{position:absolute;left:84px;right:84px;bottom:60px;display:flex;align-items:center;gap:30px}
  .b{width:96px;height:96px;border-radius:50%;background:#14203A;display:grid;place-items:center;flex:none}
  .b::after{content:"";border-left:34px solid #fff;border-top:21px solid transparent;border-bottom:21px solid transparent;margin-left:10px}
  svg{flex:1;height:96px} svg rect{fill:#2E9C87}
  .d{position:absolute;right:84px;top:64px;font-size:24px;color:#6C7B94}
</style></head><body><div class="c">
  <div class="e">How to say</div>
  <div class="d">${esc(host)}</div>
  <div class="n">${esc(name)}</div>
  ${phon ? `<div class="p">${esc(phon)}</div>` : ''}
  <div class="row"><div class="b"></div><svg viewBox="0 0 ${bars.length*13} 96" preserveAspectRatio="none">${rects}</svg></div>
</div></body></html>`;
}

module.exports = {publish, domain};

if(require.main === module){
  const src = process.argv[2];
  if(!src){ console.error('usage: node publish.js <file>.saymyname.json'); process.exit(1); }
  publish(JSON.parse(fs.readFileSync(src, 'utf8'))).then(r => {
    console.log(`✓ Published ${r.name}${r.phonetic ? ' (' + r.phonetic + ')' : ''}

  Card page   ${r.page}
  Audio       ${r.audio}   (${r.audioKB} KB)

  Signature   ${r.signature}

Go live:  git add docs && git commit -m "Publish ${r.slug}" && git push`);
  }, e => { console.error('✗ ' + e.message); process.exit(1); });
}
