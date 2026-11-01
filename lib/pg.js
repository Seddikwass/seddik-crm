'use strict';
// Client PostgreSQL minimal (protocole v3) sans dépendance :
// authentification trust / cleartext / md5 / SCRAM-SHA-256, SSL optionnel,
// requêtes paramétrées (protocole étendu), pool de connexions et transactions.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstr = (s) => Buffer.from(String(s) + '\0', 'utf8');
function msg(type, body) {
  const b = Buffer.alloc(5 + body.length);
  b[0] = type.charCodeAt(0);
  b.writeInt32BE(body.length + 4, 1);
  body.copy(b, 5);
  return b;
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseConfig(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer';
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: decodeURIComponent((u.pathname || '/').slice(1)) || decodeURIComponent(u.username || 'postgres'),
    ssl: sslmode,
  };
}

function toParam(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    return '{' + v.map((x) => (x === null || x === undefined ? 'NULL'
      : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fromText(oid, s) {
  switch (oid) {
    case 16: return s === 't';
    case 20: case 21: case 23: case 26: return parseInt(s, 10);
    case 700: case 701: case 1700: return parseFloat(s);
    case 114: case 3802: return JSON.parse(s);
    case 1114: case 1184: {
      let t = s.replace(' ', 'T');
      if (/[+-]\d\d$/.test(t)) t += ':00';
      if (oid === 1114) t += 'Z';
      const d = new Date(t);
      return isNaN(d) ? s : d.toISOString();
    }
    default: return s; // texte, date (AAAA-MM-JJ), etc.
  }
}

function parseError(body) {
  const fields = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]);
    const end = body.indexOf(0, i + 1);
    fields[code] = body.toString('utf8', i + 1, end);
    i = end + 1;
  }
  const err = new Error(fields.M || 'Erreur PostgreSQL');
  err.code = fields.C; err.detail = fields.D; err.constraint = fields.n; err.severity = fields.S;
  return err;
}

class Connection {
  constructor(cfg, options = {}) {
    this.cfg = cfg; this.options = options;
    this.buf = Buffer.alloc(0); this.msgs = []; this.waiter = null;
    this.dead = false; this.err = null; this.lock = Promise.resolve();
  }

  _push(m) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(m); } else this.msgs.push(m);
  }
  _fail(e) {
    this.dead = true; this.err = this.err || e;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(this.err); }
  }
  _next() {
    if (this.msgs.length) return Promise.resolve(this.msgs.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    while (this.buf.length - off >= 5) {
      const len = this.buf.readInt32BE(off + 1);
      if (this.buf.length - off < 1 + len) break;
      const type = String.fromCharCode(this.buf[off]);
      const body = this.buf.subarray(off + 5, off + 1 + len);
      off += 1 + len;
      if (type === 'N' || type === 'A') continue; // notices / notifications
      this._push({ type, body: Buffer.from(body) });
    }
    this.buf = off ? this.buf.subarray(off) : this.buf;
  }
  _write(b) { this.sock.write(b); }

  async connect() {
    const { host, port, ssl } = this.cfg;
    let sock = await new Promise((resolve, reject) => {
      const s = net.connect(port, host);
      s.setNoDelay(true);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    if (ssl !== 'disable') {
      sock.write(Buffer.concat([int32(8), int32(80877103)]));
      const answer = await new Promise((resolve, reject) => {
        sock.once('data', (d) => resolve(String.fromCharCode(d[0])));
        sock.once('error', reject);
      });
      if (answer === 'S') {
        sock = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
          t.once('secureConnect', () => resolve(t));
          t.once('error', reject);
        });
      } else if (ssl === 'require') {
        throw new Error('Le serveur PostgreSQL refuse SSL');
      }
    }
    this.sock = sock;
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this._fail(e));
    sock.on('close', () => this._fail(new Error('Connexion PostgreSQL fermée')));

    const params = [cstr('user'), cstr(this.cfg.user), cstr('database'), cstr(this.cfg.database),
      cstr('client_encoding'), cstr('UTF8'), cstr('TimeZone'), cstr(process.env.APP_TZ || 'Africa/Tunis'), cstr('DateStyle'), cstr('ISO')];
    if (this.options.searchPath) params.push(cstr('options'), cstr('-c search_path=' + this.options.searchPath));
    const body = Buffer.concat([int32(196608), ...params, Buffer.from([0])]);
    this._write(Buffer.concat([int32(body.length + 4), body]));

    let scram = null;
    for (;;) {
      const m = await this._next();
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) { this._write(msg('p', cstr(this.cfg.password))); continue; }
        if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const inner = md5(this.cfg.password + this.cfg.user);
          const hash = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
          this._write(msg('p', cstr(hash)));
          continue;
        }
        if (code === 10) {
          const mechs = m.body.subarray(4).toString('utf8').split('\0').filter(Boolean);
          if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Méthode SASL non supportée : ' + mechs.join(','));
          const nonce = crypto.randomBytes(18).toString('base64');
          const firstBare = 'n=*,r=' + nonce;
          const first = Buffer.from('n,,' + firstBare);
          scram = { nonce, firstBare };
          this._write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first])));
          continue;
        }
        if (code === 11) {
          const serverFirst = m.body.subarray(4).toString('utf8');
          const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
          if (!attrs.r || !attrs.r.startsWith(scram.nonce)) throw new Error('SCRAM : nonce invalide');
          const salted = crypto.pbkdf2Sync(this.cfg.password, Buffer.from(attrs.s, 'base64'), parseInt(attrs.i, 10), 32, 'sha256');
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = sha256(clientKey);
          const finalNoProof = 'c=biws,r=' + attrs.r;
          const authMessage = scram.firstBare + ',' + serverFirst + ',' + finalNoProof;
          const sig = hmac(storedKey, authMessage);
          const proof = Buffer.alloc(clientKey.length);
          for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ sig[i];
          scram.serverSig = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
          this._write(msg('p', Buffer.from(finalNoProof + ',p=' + proof.toString('base64'))));
          continue;
        }
        if (code === 12) {
          const v = m.body.subarray(4).toString('utf8');
          if (!v.startsWith('v=') || v.slice(2) !== scram.serverSig) throw new Error('SCRAM : signature serveur invalide');
          continue;
        }
        throw new Error('Méthode d\'authentification PostgreSQL non supportée (' + code + ')');
      }
      if (m.type === 'E') throw parseError(m.body);
      if (m.type === 'Z') return this;
      // S (paramètres), K (clé) : ignorés
    }
  }

  query(text, params = []) {
    const run = () => this._query(text, params);
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }

  async _query(text, params) {
    if (this.dead) throw this.err || new Error('Connexion fermée');
    const out = [];
    if (!params.length && /;\s*\S/.test(text)) {
      // Plusieurs instructions : protocole simple
      this._write(msg('Q', cstr(text)));
    } else {
      out.push(msg('P', Buffer.concat([cstr(''), cstr(text), int16(0)])));
      const parts = [cstr(''), cstr(''), int16(0), int16(params.length)];
      for (const p of params) {
        const v = toParam(p);
        if (v === null) parts.push(int32(-1));
        else { const b = Buffer.from(v, 'utf8'); parts.push(int32(b.length), b); }
      }
      parts.push(int16(0));
      out.push(msg('B', Buffer.concat(parts)));
      out.push(msg('D', Buffer.concat([Buffer.from('P'), cstr('')])));
      out.push(msg('E', Buffer.concat([cstr(''), int32(0)])));
      out.push(msg('S', Buffer.alloc(0)));
      this._write(Buffer.concat(out));
    }
    let fields = [];
    const rows = [];
    let rowCount = 0;
    let error = null;
    for (;;) {
      const m = await this._next();
      switch (m.type) {
        case 'T': {
          const n = m.body.readInt16BE(0);
          let o = 2;
          fields = [];
          for (let i = 0; i < n; i++) {
            const end = m.body.indexOf(0, o);
            const name = m.body.toString('utf8', o, end);
            o = end + 1;
            const oid = m.body.readInt32BE(o + 6);
            o += 18;
            fields.push({ name, oid });
          }
          break;
        }
        case 'D': {
          const n = m.body.readInt16BE(0);
          let o = 2;
          const row = {};
          for (let i = 0; i < n; i++) {
            const len = m.body.readInt32BE(o); o += 4;
            if (len === -1) { row[fields[i].name] = null; continue; }
            row[fields[i].name] = fromText(fields[i].oid, m.body.toString('utf8', o, o + len));
            o += len;
          }
          rows.push(row);
          break;
        }
        case 'C': {
          const tag = m.body.toString('utf8', 0, m.body.length - 1);
          const num = parseInt(tag.split(' ').pop(), 10);
          if (!isNaN(num)) rowCount = num;
          break;
        }
        case 'E': error = parseError(m.body); break;
        case 'Z':
          if (error) throw error;
          return { rows, rowCount, fields };
        default: break; // 1, 2, n, I, S, s
      }
    }
  }

  end() {
    this.dead = true;
    try { this._write(msg('X', Buffer.alloc(0))); this.sock.end(); } catch (e) { /* ignoré */ }
  }
}

class Pool {
  constructor(url, { max = 5, searchPath } = {}) {
    this.cfg = parseConfig(url); this.max = max; this.searchPath = searchPath;
    this.idle = []; this.count = 0; this.waiting = [];
  }
  async _create() {
    this.count++;
    try {
      const c = new Connection(this.cfg, { searchPath: this.searchPath });
      await c.connect();
      return c;
    } catch (e) { this.count--; throw e; }
  }
  async acquire() {
    while (this.idle.length) {
      const c = this.idle.pop();
      if (!c.dead) return c;
      this.count--;
    }
    if (this.count < this.max) return this._create();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  release(c) {
    if (c.dead) {
      this.count--;
      if (this.waiting.length) { const w = this.waiting.shift(); this._create().then(w.resolve, w.reject); }
      return;
    }
    if (this.waiting.length) this.waiting.shift().resolve(c);
    else this.idle.push(c);
  }
  async query(text, params) {
    for (let attempt = 0; ; attempt++) {
      const c = await this.acquire();
      try {
        const r = await c.query(text, params);
        this.release(c);
        return r;
      } catch (e) {
        this.release(c);
        // Connexion inactive coupée par le serveur : on réessaie une fois
        if (c.dead && !e.code && attempt === 0) continue;
        throw e;
      }
    }
  }
  async tx(fn) {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { if (!c.dead) await c.query('ROLLBACK'); } catch (e2) { /* ignoré */ }
      throw e;
    } finally {
      this.release(c);
    }
  }
}

module.exports = { Pool, Connection, parseConfig };
