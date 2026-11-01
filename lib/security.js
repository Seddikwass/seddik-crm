'use strict';
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-a-changer-en-production';
if (!process.env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET non défini : utilisez une valeur secrète en production.');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) { return false; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signToken(payload, ttlSeconds = 7 * 24 * 3600) {
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch (e) { return null; }
}

// Limiteur de tentatives (connexion, inscription)
const attempts = new Map();
function rateLimit(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, start: now };
  if (now - rec.start > windowMs) { rec.n = 0; rec.start = now; }
  rec.n++;
  attempts.set(key, rec);
  if (attempts.size > 5000) attempts.clear();
  return rec.n <= max;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, rateLimit };
