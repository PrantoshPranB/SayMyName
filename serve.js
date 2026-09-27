#!/usr/bin/env node
// The studio's local server. Serves the files in this folder, and makes the
// Publish button real while there is no hosted backend:
//
//   GET  /api/config   → {domain}          the domain in docs/CNAME
//   POST /api/publish  → {page, audio, …}  builds the card with publish.js,
//                                          then commits and pushes docs/
//
// GitHub Pages rebuilds on the push, so a card is live about a minute later.
// Listens on localhost only: the publish endpoint pushes to your repo.

const http = require('http'), fs = require('fs'), path = require('path');
const {execFileSync} = require('child_process');
const {publish, domain} = require('./publish');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8000;
const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.m4a':'audio/mp4', '.wav':'audio/wav', '.webm':'audio/webm'
};

function send(res, code, body, type){
  res.writeHead(code, {'Content-Type': type || 'application/json', 'Cache-Control': 'no-store'});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit){
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if(size > limit){ reject(new Error('recording too large')); req.destroy(); }
      else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function git(...args){ return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim(); }

// One publish at a time, so two clicks cannot interleave commits.
let publishing = Promise.resolve();

async function handlePublish(req, res){
  const job = JSON.parse(await readBody(req, 20*1024*1024));
  const run = publishing.then(async () => {
    const r = await publish(job);
    git('add', '--', ...r.files);
    // Re-publishing identical audio changes nothing; commit only if it did.
    const staged = git('diff', '--cached', '--name-only', '--', ...r.files);
    if(staged){
      git('commit', '-m', `Publish ${r.slug}`, '--', ...r.files);
      git('push');
    }
    return {...r, pushed: !!staged};
  });
  publishing = run.catch(() => {});
  send(res, 200, await run);
}

http.createServer(async (req, res) => {
  try{
    const url = new URL(req.url, 'http://localhost');

    if(url.pathname === '/api/config' && req.method === 'GET')
      return send(res, 200, {domain: domain()});
    if(url.pathname === '/api/publish' && req.method === 'POST')
      return await handlePublish(req, res);

    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if(!file.startsWith(ROOT + path.sep) && file !== ROOT) return send(res, 403, 'Forbidden', 'text/plain');
    if(fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if(!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  }catch(e){
    console.error('✗', e.message);
    const msg = /git/.test(e.message) && /push/.test(e.message)
      ? 'The card was built but the push to GitHub failed: ' + e.message.split('\n').slice(-3).join(' ')
      : e.message;
    send(res, 500, {error: msg});
  }
}).listen(PORT, '127.0.0.1', () => console.log(`→ http://localhost:${PORT}`));
