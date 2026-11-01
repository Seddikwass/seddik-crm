'use strict';
// Mini-framework HTTP sans dépendance : routes, JSON, cookies, fichiers statiques.
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.woff2': 'font/woff2',
};

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Données trop volumineuses')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class App {
  constructor() { this.routes = []; this.staticDir = null; }

  add(method, pattern, handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, h); }
  post(p, ...h) { this.add('POST', p, h); }
  put(p, ...h) { this.add('PUT', p, h); }
  delete(p, ...h) { this.add('DELETE', p, h); }
  static(dir) { this.staticDir = dir; }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    req.path = decodeURIComponent(url.pathname);
    req.query = Object.fromEntries(url.searchParams);
    req.cookies = parseCookies(req.headers.cookie);
    res.json = (data, status = 200) => {
      if (res.writableEnded) return;
      const body = JSON.stringify(data);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    };
    res.redirect = (location) => { res.writeHead(302, { Location: location }); res.end(); };
    res.setCookie = (name, value, opts = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
      if (opts.maxAge !== undefined) parts.push('Max-Age=' + opts.maxAge);
      if (opts.secure) parts.push('Secure');
      const prev = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
    };

    try {
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(req.path);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
          const raw = await readBody(req);
          try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { throw new HttpError(400, 'JSON invalide'); }
        } else req.body = {};
        let result;
        for (const h of r.handlers) {
          result = await h(req, res);
          if (res.writableEnded) return;
        }
        if (result === undefined) result = { ok: true };
        return res.json(result);
      }
      if (req.path.startsWith('/api/')) throw new HttpError(404, 'Ressource introuvable');
      if (req.method === 'GET' || req.method === 'HEAD') return this.serveStatic(req, res);
      throw new HttpError(405, 'Méthode non autorisée');
    } catch (e) {
      let status = e.status || 500;
      let message = e.message;
      if (e.code === '23505') { status = 409; message = 'Cet enregistrement existe déjà (code ou numéro en double).'; }
      else if (e.code === '23503') { status = 409; message = 'Impossible : cet élément est utilisé ailleurs.'; }
      else if (e.code === '22P02' || e.code === '22007' || e.code === '22008') { status = 400; message = 'Valeur invalide dans le formulaire.'; }
      if (status >= 500) { console.error(new Date().toISOString(), req.method, req.path, e); message = 'Erreur interne du serveur'; }
      res.json(Object.assign({ error: message }, e.extra || {}), status);
    }
  }

  serveStatic(req, res) {
    const root = this.staticDir;
    let file = path.normalize(path.join(root, req.path));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) file = path.join(file, 'index.html');
      else if (err) file = path.join(root, 'index.html'); // application monopage
      fs.readFile(file, (e2, data) => {
        if (e2) { res.writeHead(404); return res.end('Introuvable'); }
        const ext = path.extname(file);
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
        headers['Cache-Control'] = 'no-cache';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    });
  }
}

module.exports = { App, HttpError };
