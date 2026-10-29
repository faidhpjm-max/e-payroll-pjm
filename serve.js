// Server lokal yang meniru Vercel: "/" -> index_html.html, POST /api/rpc -> api/rpc.js.
// Jalankan: node serve.js  (lalu buka http://localhost:8766)
const http = require('http');
const fs = require('fs');
const path = require('path');
const rpc = require('./api/rpc');

http.createServer((req, res) => {
  if (req.url.startsWith('/api/rpc')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
      res.status = code => { res.statusCode = code; return res; };
      res.json = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      rpc(req, res);
    });
    return;
  }
  fs.readFile(path.join(__dirname, 'index_html.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end(String(err)); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(Number(process.env.PORT) || 8766, '127.0.0.1');
