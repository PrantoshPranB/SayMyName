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
  fs.writeFileSync(wav, Buffer.from(job.audio, 'base64'));
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', '-c', '1', wav, path.join(DOCS, slug + '.m4a')]);

  // ---- the card page ------------------------------------------------------
  const title = `How to say ${name}`;
  const summary = phon ? `${name} — said “${phon}”. Tap to hear it.` : `Tap to hear how ${name} says it.`;

  fs.writeFileSync(path.join(outDir, 'index.html'), `<!DOCTYPE html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(summary)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc('🔊 ' + name + (phon ? ' — ' + phon : ''))}">
  <meta property="og:description" content="${esc(summary)}">
  <meta property="og:url" content="${esc(pageUrl)}">
  <meta property="og:image" content="${esc(imgUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:audio" content="${esc(audioUrl)}">
  <meta property="og:audio:type" content="audio/mp4">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,300;6..72,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--paper:#EDF1F6;--ink:#14203A;--ink-soft:#6C7B94;--line:#CFD8E4;--live:#2E9C87;--card:#fff}
    @media (prefers-color-scheme:dark){
      :root{--paper:#0F1626;--ink:#E8EDF5;--ink-soft:#8E9BB2;--line:#26324A;--live:#4FC3AA;--card:#172036}
    }
    *{box-sizing:border-box}
    html,body{margin:0}
    body{
      min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:var(--paper);color:var(--ink);padding:24px 16px;
      font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    .card{
      background:var(--card);border:1px solid var(--line);border-radius:18px;
      width:100%;max-width:420px;padding:34px 28px 26px;text-align:center;
    }
    h1{font-family:Newsreader,Georgia,serif;font-weight:400;font-size:40px;line-height:1.1;
       letter-spacing:-0.02em;margin:0;word-break:break-word}
    .phon{color:var(--ink-soft);font-size:17px;margin-top:10px;min-height:1em}
    button{
      margin:28px auto 0;width:96px;height:96px;border-radius:50%;
      border:none;background:var(--ink);color:var(--paper);cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      transition:transform .08s, background .15s;
    }
    button:active{transform:scale(.96)}
    button:focus-visible{outline:3px solid var(--live);outline-offset:4px}
    button.on{background:var(--live)}
    button svg{width:38px;height:38px}
    .hint{font-size:13px;color:var(--ink-soft);margin-top:14px;min-height:1.3em}
    .foot{font-size:12px;color:var(--ink-soft);margin-top:26px}
    .foot a{color:inherit}
  </style>
  </head>
  <body>
  <main class="card">
    <h1>${esc(name)}</h1>
    <div class="phon">${esc(phon)}</div>
    <button id="play" aria-label="Play how ${esc(name)} is said">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>
    </button>
    <div class="hint" id="hint">Tap to hear it</div>
    <p class="foot"><a href="${esc(audioUrl)}">Audio file</a></p>
  </main>
  <audio id="a" src="../${slug}.m4a" preload="auto"></audio>
  <script>
    const a = document.getElementById('a'), b = document.getElementById('play'), h = document.getElementById('hint');
    const play = () => { a.currentTime = 0; return a.play(); };
    b.addEventListener('click', () => { play().catch(() => { h.textContent = 'Could not play — try the audio file link.'; }); });
    a.addEventListener('play', () => { b.classList.add('on'); h.textContent = 'Playing…'; });
    a.addEventListener('ended', () => { b.classList.remove('on'); h.textContent = 'Tap to hear it again'; });
    // Browsers usually refuse sound on a page nobody has tapped yet; when one
    // allows it, play straight away, and otherwise the button is the way in.
    play().catch(() => {});
  </script>
  </body>
  </html>
  `);

  // ---- the preview image, rendered by headless Chrome ---------------------
  const ogHtml = path.join(tmp, 'og.html');
  fs.writeFileSync(ogHtml, `<!DOCTYPE html><html><head><meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400&family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    html,body{margin:0;width:1200px;height:630px;overflow:hidden}
    body{background:#EDF1F6;font-family:Inter,sans-serif;color:#14203A;display:flex;align-items:center;justify-content:center}
    .c{width:1080px;height:510px;background:#fff;border:2px solid #CFD8E4;border-radius:36px;
       display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box;position:relative}
    .n{font-family:Newsreader,Georgia,serif;font-size:${name.length > 18 ? 84 : 112}px;line-height:1.05;letter-spacing:-0.02em}
    .p{font-size:48px;color:#6C7B94;margin-top:22px}
    .t{position:absolute;left:90px;bottom:54px;font-size:30px;color:#2E9C87;font-weight:500}
    .d{position:absolute;right:90px;bottom:54px;font-size:26px;color:#6C7B94}
  </style></head><body><div class="c">
    <div class="n">${esc(name)}</div>
    <div class="p">${esc(phon ? '“' + phon + '”' : '')}</div>
    <div class="t">🔊 Tap to hear it</div>
    <div class="d">${esc(base.replace('https://', ''))}</div>
  </div></body></html>`);

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
