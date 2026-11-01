'use strict';
const { HttpError } = require('../lib/http');
const { hashPassword, verifyPassword, signToken, verifyToken, rateLimit } = require('../lib/security');
const { db, seedCompany, platformSettings, DEFAULT_PREFIXES, DEFAULT_ACCOUNTS_MAP } = require('./db');

const COOKIE = 'seddik_sid';
const ROLES = ['owner', 'admin', 'user', 'lecture'];

function subscription(company) {
  if (!company) return null;
  const trial = company.trial_ends_at ? Date.parse(company.trial_ends_at) : 0;
  const paid = company.paid_until ? Date.parse(company.paid_until) : 0;
  const until = Math.max(trial, paid);
  let access = until > Date.now() ? 'ok' : 'expired';
  if (company.status === 'suspended') access = 'suspended';
  const isTrial = paid <= Date.now() && trial > Date.now();
  return {
    status: company.status, access, plan_code: company.plan_code, is_trial: isTrial,
    trial_ends_at: company.trial_ends_at, paid_until: company.paid_until,
    ends_at: until ? new Date(until).toISOString() : null,
    days_left: until ? Math.max(0, Math.ceil((until - Date.now()) / 86400000)) : 0,
  };
}

const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

function setSession(req, res, userId) {
  res.setCookie(COOKIE, signToken({ uid: userId }), { maxAge: 7 * 24 * 3600, secure: isHttps(req) });
}

async function loadUser(req) {
  const data = verifyToken(req.cookies[COOKIE]);
  if (!data) return;
  const { rows } = await db.query('SELECT id, company_id, name, email, phone, role, active FROM users WHERE id = $1', [data.uid]);
  const user = rows[0];
  if (!user || !user.active) return;
  req.user = user;
  if (user.company_id) {
    const c = await db.query('SELECT * FROM companies WHERE id = $1', [user.company_id]);
    req.company = c.rows[0];
  }
}

// Middlewares
async function requireAuth(req) {
  await loadUser(req);
  if (!req.user) throw new HttpError(401, 'Veuillez vous connecter.');
}
async function requireCompany(req) {
  await requireAuth(req);
  if (!req.company) throw new HttpError(403, 'Espace réservé aux entreprises.');
  const sub = subscription(req.company);
  req.sub = sub;
  if (sub.access === 'suspended') throw new HttpError(403, 'Le compte de votre entreprise est suspendu. Contactez SEDDIK CRM.', { code: 'suspended' });
  if (req.method !== 'GET') {
    if (sub.access === 'expired') throw new HttpError(402, 'Votre abonnement a expiré : renouvelez-le dans Paramètres > Abonnement pour continuer à saisir.', { code: 'expired' });
    if (req.user.role === 'lecture') throw new HttpError(403, 'Votre profil est en lecture seule.');
  }
}
// Accès à l'abonnement même expiré
async function requireCompanyAny(req) {
  await requireAuth(req);
  if (!req.company) throw new HttpError(403, 'Espace réservé aux entreprises.');
  req.sub = subscription(req.company);
}
async function requireAdmin(req) {
  if (!req.user) await requireCompany(req);
  if (!['owner', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Réservé aux administrateurs de l\'entreprise.');
}
async function requireSuper(req) {
  await requireAuth(req);
  if (req.user.role !== 'superadmin') throw new HttpError(403, 'Réservé à l\'administrateur de la plateforme.');
}

function cleanEmail(e) {
  const email = String(e || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  return email;
}
function checkPassword(p) {
  if (!p || String(p).length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
}

function me(req) {
  return {
    user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, phone: req.user.phone } : null,
    company: req.company ? {
      id: req.company.id, name: req.company.name, currency: req.company.currency, timbre: req.company.timbre,
      default_terms: req.company.default_terms, plan_code: req.company.plan_code,
    } : null,
    subscription: req.company ? subscription(req.company) : null,
  };
}

function register(app) {
  app.get('/api/public/plans', async () => {
    const { rows } = await db.query('SELECT code, name, description, price_month, price_year, max_users, features FROM plans WHERE active ORDER BY sort');
    return rows;
  });
  app.get('/api/public/info', async () => {
    const s = await platformSettings();
    return { trial_days: s.trial_days, contact_phone: s.contact_phone, contact_whatsapp: s.contact_whatsapp, contact_email: s.contact_email };
  });

  app.post('/api/auth/signup', async (req, res) => {
    if (!rateLimit('signup:' + ip(req), 8, 60 * 60 * 1000)) throw new HttpError(429, 'Trop de tentatives, réessayez plus tard.');
    const b = req.body;
    const companyName = String(b.company_name || '').trim();
    const name = String(b.name || '').trim();
    if (!companyName || !name) throw new HttpError(400, 'Nom de l\'entreprise et nom complet obligatoires.');
    const email = cleanEmail(b.email);
    checkPassword(b.password);
    const s = await platformSettings();
    const ex = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (ex.rows.length) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
    const userId = await db.tx(async (c) => {
      const comp = await c.query(
        `INSERT INTO companies (name, phone, city, email, tax_id, plan_code, status, trial_ends_at, prefixes, accounts_map)
         VALUES ($1,$2,$3,$4,$5,'pro','trial', now() + ($6 || ' days')::interval, $7::jsonb, $8::jsonb) RETURNING id`,
        [companyName, b.phone || null, b.city || null, email, b.tax_id || null, String(Number(s.trial_days) || 14),
          JSON.stringify(DEFAULT_PREFIXES), JSON.stringify(DEFAULT_ACCOUNTS_MAP)]);
      const companyId = comp.rows[0].id;
      await seedCompany(c, companyId);
      const u = await c.query(`INSERT INTO users (company_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,'owner') RETURNING id`,
        [companyId, name, email, b.phone || null, hashPassword(b.password)]);
      return u.rows[0].id;
    });
    setSession(req, res, userId);
    req.cookies[COOKIE] = signToken({ uid: userId });
    await loadUser(req);
    return me(req);
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!rateLimit('login:' + ip(req) + ':' + email, 10)) throw new HttpError(429, 'Trop de tentatives, réessayez dans 15 minutes.');
    const { rows } = await db.query('SELECT id, password_hash, active FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (!u || !verifyPassword(req.body.password || '', u.password_hash)) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
    if (!u.active) throw new HttpError(403, 'Ce compte utilisateur est désactivé.');
    await db.query('UPDATE users SET last_login = now() WHERE id = $1', [u.id]);
    setSession(req, res, u.id);
    req.cookies[COOKIE] = signToken({ uid: u.id });
    await loadUser(req);
    return me(req);
  });

  app.post('/api/auth/logout', async (req, res) => {
    res.setCookie(COOKIE, '', { maxAge: 0, secure: isHttps(req) });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    await loadUser(req);
    return me(req);
  });

  app.post('/api/auth/password', requireAuth, async (req) => {
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!verifyPassword(req.body.current || '', rows[0].password_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect.');
    checkPassword(req.body.next);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(req.body.next), req.user.id]);
    return { ok: true };
  });

  app.put('/api/auth/profile', requireAuth, async (req) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Nom obligatoire.');
    await db.query('UPDATE users SET name = $1, phone = $2 WHERE id = $3', [name, req.body.phone || null, req.user.id]);
    return { ok: true };
  });

  // Paramètres de l'entreprise
  app.get('/api/company', requireCompanyAny, async (req) => ({ ...req.company, subscription: req.sub }));

  const COMPANY_FIELDS = ['name', 'legal_form', 'tax_id', 'rc', 'address', 'city', 'phone', 'email', 'website', 'bank_name', 'rib', 'invoice_footer', 'timbre', 'default_terms'];
  app.put('/api/company', requireCompany, requireAdmin, async (req) => {
    const b = req.body;
    if (!String(b.name || '').trim()) throw new HttpError(400, 'Le nom de l\'entreprise est obligatoire.');
    const sets = [];
    const vals = [];
    const casts = { timbre: (n) => `COALESCE($${n}::numeric, 0)`, default_terms: (n) => `COALESCE($${n}::int, 30)` };
    for (const f of COMPANY_FIELDS) {
      if (b[f] === undefined) continue;
      vals.push(b[f] === '' ? null : b[f]);
      sets.push(`${f} = ${casts[f] ? casts[f](vals.length) : '$' + vals.length}`);
    }
    if (b.prefixes) { vals.push(JSON.stringify({ ...DEFAULT_PREFIXES, ...b.prefixes })); sets.push(`prefixes = $${vals.length}::jsonb`); }
    if (b.accounts_map) { vals.push(JSON.stringify({ ...DEFAULT_ACCOUNTS_MAP, ...b.accounts_map })); sets.push(`accounts_map = $${vals.length}::jsonb`); }
    if (!sets.length) return { ok: true };
    vals.push(req.company.id);
    await db.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    return { ok: true };
  });

  // Utilisateurs de l'entreprise
  app.get('/api/users', requireCompanyAny, async (req) => {
    const { rows } = await db.query('SELECT id, name, email, phone, role, active, last_login, created_at FROM users WHERE company_id = $1 ORDER BY id', [req.company.id]);
    const plan = await db.query('SELECT max_users FROM plans WHERE code = $1', [req.company.plan_code]);
    return { users: rows, max_users: plan.rows[0] ? plan.rows[0].max_users : 1 };
  });

  app.post('/api/users', requireCompany, requireAdmin, async (req) => {
    const b = req.body;
    const email = cleanEmail(b.email);
    checkPassword(b.password);
    const role = ROLES.includes(b.role) && b.role !== 'owner' ? b.role : 'user';
    if (!String(b.name || '').trim()) throw new HttpError(400, 'Nom obligatoire.');
    const plan = await db.query('SELECT max_users, name FROM plans WHERE code = $1', [req.company.plan_code]);
    const count = await db.query('SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND active', [req.company.id]);
    const max = plan.rows[0] ? plan.rows[0].max_users : 1;
    if (count.rows[0].n >= max) throw new HttpError(403, `Votre formule ${plan.rows[0] ? plan.rows[0].name : ''} est limitée à ${max} utilisateur(s). Passez à une formule supérieure dans Abonnement.`);
    const { rows } = await db.query(`INSERT INTO users (company_id, name, email, phone, password_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.company.id, String(b.name).trim(), email, b.phone || null, hashPassword(b.password), role]);
    return { id: rows[0].id };
  });

  app.put('/api/users/:id', requireCompany, requireAdmin, async (req) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND company_id = $2', [req.params.id, req.company.id]);
    const u = rows[0];
    if (!u) throw new HttpError(404, 'Utilisateur introuvable.');
    const b = req.body;
    let role = u.role;
    let active = u.active;
    if (u.role !== 'owner') {
      if (ROLES.includes(b.role) && b.role !== 'owner') role = b.role;
      if (typeof b.active === 'boolean') active = b.active;
    }
    if (active && !u.active) {
      const plan = await db.query('SELECT max_users FROM plans WHERE code = $1', [req.company.plan_code]);
      const count = await db.query('SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND active', [req.company.id]);
      if (count.rows[0].n >= (plan.rows[0] ? plan.rows[0].max_users : 1)) throw new HttpError(403, 'Nombre maximum d\'utilisateurs atteint pour votre formule.');
    }
    await db.query('UPDATE users SET name = $1, phone = $2, role = $3, active = $4 WHERE id = $5',
      [String(b.name || u.name).trim(), b.phone === undefined ? u.phone : b.phone, role, active, u.id]);
    if (b.password) { checkPassword(b.password); await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(b.password), u.id]); }
    return { ok: true };
  });
}

module.exports = { register, requireAuth, requireCompany, requireCompanyAny, requireAdmin, requireSuper, subscription };
