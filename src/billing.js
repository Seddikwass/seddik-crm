'use strict';
// Abonnements payants (essai, formules, paiement Konnect ou déclaratif) et console de la plateforme
const { HttpError } = require('../lib/http');
const { hashPassword } = require('../lib/security');
const { db, round3, platformSettings } = require('./db');
const { requireCompanyAny, requireSuper, subscription } = require('./auth');

const KONNECT_KEY = process.env.KONNECT_API_KEY || '';
const KONNECT_WALLET = process.env.KONNECT_WALLET_ID || '';
const KONNECT_BASE = (process.env.KONNECT_ENV || 'sandbox') === 'production'
  ? 'https://api.konnect.network/api/v2' : 'https://api.sandbox.konnect.network/api/v2';
const konnectEnabled = () => !!(KONNECT_KEY && KONNECT_WALLET);
const MANUAL_METHODS = { virement: 'Virement bancaire', d17: 'D17 (La Poste)', versement: 'Versement bancaire', especes: 'Espèces', cheque: 'Chèque' };

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

async function planPrice(code, period) {
  const plan = (await db.query('SELECT * FROM plans WHERE code = $1 AND active', [code])).rows[0];
  if (!plan) throw new HttpError(400, 'Formule introuvable.');
  const months = period === 'year' ? 12 : 1;
  const amount = round3(period === 'year' ? plan.price_year : plan.price_month);
  return { plan, months, amount };
}

async function activatePayment(c, paymentId, processedBy) {
  const p = (await c.query('SELECT * FROM subscription_payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
  if (!p) throw new HttpError(404, 'Paiement introuvable.');
  if (p.status === 'paid') return p;
  if (p.status !== 'pending') throw new HttpError(409, 'Ce paiement n\'est plus en attente.');
  await c.query(`UPDATE subscription_payments SET status = 'paid', processed_at = now(), processed_by = $2 WHERE id = $1`, [p.id, processedBy || null]);
  await c.query(
    `UPDATE companies SET plan_code = $2, status = 'active',
       paid_until = GREATEST(COALESCE(paid_until, now()), COALESCE(trial_ends_at, now()), now()) + ($3 || ' months')::interval
     WHERE id = $1`, [p.company_id, p.plan_code, String(p.months)]);
  return p;
}

async function konnectRequest(method, path, body) {
  const res = await fetch(KONNECT_BASE + path, {
    method,
    headers: { 'x-api-key': KONNECT_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { /* réponse non JSON */ }
  if (!res.ok) {
    console.error('Konnect', res.status, text.slice(0, 500));
    throw new HttpError(502, 'Le service de paiement Konnect a refusé la demande. Réessayez ou payez par virement.');
  }
  return data;
}

function register(app) {
  // ---------- Côté entreprise ----------
  app.get('/api/billing', requireCompanyAny, async (req) => {
    const plans = (await db.query('SELECT code, name, description, price_month, price_year, max_users, features FROM plans WHERE active ORDER BY sort')).rows;
    const payments = (await db.query('SELECT id, plan_code, months, amount, method, reference, status, note, created_at, processed_at FROM subscription_payments WHERE company_id = $1 ORDER BY id DESC LIMIT 50', [req.company.id])).rows;
    const s = await platformSettings();
    const users = (await db.query('SELECT count(*)::int AS n FROM users WHERE company_id = $1 AND active', [req.company.id])).rows[0].n;
    return {
      plans, payments, subscription: subscription(req.company), users,
      konnect: konnectEnabled(), methods: MANUAL_METHODS,
      payment_info: { bank_name: s.bank_name, bank_rib: s.bank_rib, bank_holder: s.bank_holder, d17_phone: s.d17_phone, note: s.payment_note,
        contact_phone: s.contact_phone, contact_whatsapp: s.contact_whatsapp, contact_email: s.contact_email },
    };
  });

  app.post('/api/billing/declare', requireCompanyAny, async (req) => {
    if (!['owner', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Réservé aux administrateurs de l\'entreprise.');
    const method = MANUAL_METHODS[req.body.method] ? req.body.method : null;
    if (!method) throw new HttpError(400, 'Choisissez un mode de paiement.');
    const reference = String(req.body.reference || '').trim();
    if (!reference) throw new HttpError(400, 'Indiquez la référence du paiement (n° de virement, de reçu D17, de chèque…).');
    const { plan, months, amount } = await planPrice(req.body.plan_code, req.body.period);
    const pending = (await db.query(`SELECT count(*)::int AS n FROM subscription_payments WHERE company_id = $1 AND status = 'pending'`, [req.company.id])).rows[0].n;
    if (pending >= 3) throw new HttpError(409, 'Vous avez déjà des paiements en attente de validation.');
    const { rows } = await db.query(
      `INSERT INTO subscription_payments (company_id, plan_code, months, amount, method, reference, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.company.id, plan.code, months, amount, method, reference, req.body.note || null]);
    return { id: rows[0].id };
  });

  app.post('/api/billing/konnect', requireCompanyAny, async (req) => {
    if (!['owner', 'admin'].includes(req.user.role)) throw new HttpError(403, 'Réservé aux administrateurs de l\'entreprise.');
    if (!konnectEnabled()) throw new HttpError(400, 'Le paiement en ligne n\'est pas encore activé : utilisez le virement ou D17.');
    const { plan, months, amount } = await planPrice(req.body.plan_code, req.body.period);
    const { rows } = await db.query(
      `INSERT INTO subscription_payments (company_id, plan_code, months, amount, method, note) VALUES ($1,$2,$3,$4,'konnect','Paiement en ligne') RETURNING id`,
      [req.company.id, plan.code, months, amount]);
    const id = rows[0].id;
    const [firstName, ...rest] = String(req.user.name || '').split(' ');
    const data = await konnectRequest('POST', '/payments/init-payment', {
      receiverWalletId: KONNECT_WALLET,
      token: 'TND',
      amount: Math.round(amount * 1000),
      type: 'immediate',
      description: `SEDDIK CRM – formule ${plan.name} (${months === 12 ? '12 mois' : '1 mois'}) – ${req.company.name}`.slice(0, 280),
      acceptedPaymentMethods: ['wallet', 'bank_card', 'e-DINAR'],
      lifespan: 60,
      checkoutForm: false,
      addPaymentFeesToAmount: false,
      firstName: firstName || undefined,
      lastName: rest.join(' ') || undefined,
      email: req.user.email,
      orderId: 'SEDDIK-' + id,
      webhook: appUrl(req) + '/api/billing/konnect/webhook',
      theme: 'light',
    });
    if (!data.payUrl || !data.paymentRef) throw new HttpError(502, 'Réponse inattendue du service de paiement.');
    await db.query('UPDATE subscription_payments SET provider_ref = $1, reference = $1 WHERE id = $2', [data.paymentRef, id]);
    return { payUrl: data.payUrl };
  });

  // Konnect appelle cette adresse (et y redirige le payeur) après le paiement
  app.get('/api/billing/konnect/webhook', async (req, res) => {
    const ref = String(req.query.payment_ref || req.query.paymentRef || '');
    const back = (state) => res.redirect('/#/parametres/abonnement?paiement=' + state);
    if (!ref || !konnectEnabled()) return back('inconnu');
    const p = (await db.query('SELECT * FROM subscription_payments WHERE provider_ref = $1', [ref])).rows[0];
    if (!p) return back('inconnu');
    if (p.status === 'paid') return back('ok');
    let data;
    try { data = await konnectRequest('GET', '/payments/' + encodeURIComponent(ref)); } catch (e) { return back('verification'); }
    // Le montant est fixé par nous à l'initialisation (type « immediate ») : le statut suffit
    const pay = data.payment || data;
    if (pay.status === 'completed') {
      await db.tx((c) => activatePayment(c, p.id, null));
      return back('ok');
    }
    if (pay.status === 'pending') return back('attente');
    await db.query(`UPDATE subscription_payments SET status = 'failed', processed_at = now() WHERE id = $1 AND status = 'pending'`, [p.id]);
    return back('echec');
  });

  // ---------- Console de la plateforme (super-administrateur) ----------
  app.get('/api/admin/overview', requireSuper, async () => {
    const companies = (await db.query('SELECT * FROM companies')).rows;
    const plans = new Map((await db.query('SELECT * FROM plans')).rows.map((p) => [p.code, p]));
    const stats = { total: companies.length, trial: 0, paying: 0, expired: 0, suspended: 0, mrr: 0 };
    for (const c of companies) {
      const s = subscription(c);
      if (s.access === 'suspended') stats.suspended++;
      else if (s.access === 'expired') stats.expired++;
      else if (s.is_trial) stats.trial++;
      else {
        stats.paying++;
        const p = plans.get(c.plan_code);
        if (p) stats.mrr += Number(p.price_month);
      }
    }
    stats.mrr = round3(stats.mrr);
    const rev = (await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE processed_at >= date_trunc('month', now())), 0) AS month,
              COALESCE(SUM(amount) FILTER (WHERE processed_at >= date_trunc('year', now())), 0) AS year,
              COALESCE(SUM(amount), 0) AS total
       FROM subscription_payments WHERE status = 'paid'`)).rows[0];
    const pending = (await db.query(`SELECT count(*)::int AS n FROM subscription_payments WHERE status = 'pending' AND method <> 'konnect'`)).rows[0].n;
    const signups = (await db.query(
      `SELECT to_char(created_at, 'YYYY-MM') AS month, count(*)::int AS n FROM companies
       WHERE created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1 ORDER BY 1`)).rows;
    const expiring = companies
      .map((c) => ({ id: c.id, name: c.name, sub: subscription(c) }))
      .filter((c) => c.sub.access === 'ok' && c.sub.days_left <= 7)
      .sort((a, b) => a.sub.days_left - b.sub.days_left).slice(0, 10);
    return { stats, revenue: { month: Number(rev.month), year: Number(rev.year), total: Number(rev.total) }, pending, signups, expiring };
  });

  app.get('/api/admin/companies', requireSuper, async (req) => {
    const params = [];
    let where = 'true';
    if (req.query.q) { params.push('%' + req.query.q + '%'); where = `(c.name ILIKE $1 OR c.email ILIKE $1 OR c.phone ILIKE $1 OR c.tax_id ILIKE $1)`; }
    const { rows } = await db.query(
      `SELECT c.*, (SELECT count(*)::int FROM users u WHERE u.company_id = c.id AND u.active) AS users,
              (SELECT max(last_login) FROM users u WHERE u.company_id = c.id) AS last_login,
              (SELECT count(*)::int FROM documents d WHERE d.company_id = c.id) AS documents,
              (SELECT json_build_object('name', u.name, 'email', u.email, 'phone', u.phone) FROM users u WHERE u.company_id = c.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner
       FROM companies c WHERE ${where} ORDER BY c.created_at DESC LIMIT 1000`, params);
    return rows.map((c) => ({ ...c, subscription: subscription(c) }));
  });

  app.get('/api/admin/companies/:id', requireSuper, async (req) => {
    const c = (await db.query('SELECT * FROM companies WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Entreprise introuvable.');
    const users = (await db.query('SELECT id, name, email, phone, role, active, last_login, created_at FROM users WHERE company_id = $1 ORDER BY id', [c.id])).rows;
    const payments = (await db.query('SELECT * FROM subscription_payments WHERE company_id = $1 ORDER BY id DESC', [c.id])).rows;
    const counts = (await db.query(
      `SELECT (SELECT count(*)::int FROM documents WHERE company_id = $1) AS documents,
              (SELECT count(*)::int FROM customers WHERE company_id = $1) AS customers,
              (SELECT count(*)::int FROM suppliers WHERE company_id = $1) AS suppliers,
              (SELECT count(*)::int FROM products WHERE company_id = $1) AS products,
              (SELECT count(*)::int FROM payments WHERE company_id = $1) AS payments`, [c.id])).rows[0];
    return { ...c, subscription: subscription(c), users, payments, counts };
  });

  // Suppression définitive d'une entreprise cliente et de toutes ses données
  app.post('/api/admin/companies/:id/delete', requireSuper, async (req) => {
    const c = (await db.query('SELECT id, name FROM companies WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Entreprise introuvable.');
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (norm(req.body.confirm) !== norm(c.name)) throw new HttpError(400, 'Pour confirmer, saisissez exactement le nom de l\'entreprise.');
    await db.tx(async (t) => {
      // Ordre explicite : des enfants vers les parents, pour ne heurter aucune contrainte
      const steps = [
        'DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE company_id = $1) OR document_id IN (SELECT id FROM documents WHERE company_id = $1)',
        'DELETE FROM reminders WHERE company_id = $1',
        'DELETE FROM stock_moves WHERE company_id = $1',
        'DELETE FROM document_lines WHERE document_id IN (SELECT id FROM documents WHERE company_id = $1)',
        'UPDATE documents SET source_id = NULL WHERE company_id = $1',
        'DELETE FROM documents WHERE company_id = $1',
        'DELETE FROM payments WHERE company_id = $1',
        'DELETE FROM entry_lines WHERE company_id = $1',
        'DELETE FROM entries WHERE company_id = $1',
        'DELETE FROM products WHERE company_id = $1',
        'DELETE FROM customers WHERE company_id = $1',
        'DELETE FROM suppliers WHERE company_id = $1',
        'DELETE FROM accounts WHERE company_id = $1',
        'DELETE FROM counters WHERE company_id = $1',
        'DELETE FROM subscription_payments WHERE company_id = $1',
        'DELETE FROM users WHERE company_id = $1',
        'DELETE FROM companies WHERE id = $1',
      ];
      for (const sql of steps) await t.query(sql, [c.id]);
    });
    console.log(`${new Date().toISOString()} Entreprise supprimée : #${c.id} « ${c.name} » par ${req.user.email}`);
    return { deleted: true, name: c.name };
  });

  app.put('/api/admin/companies/:id', requireSuper, async (req) => {
    const b = req.body;
    const c = (await db.query('SELECT * FROM companies WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Entreprise introuvable.');
    const status = ['trial', 'active', 'suspended'].includes(b.status) ? b.status : c.status;
    const plan = b.plan_code || c.plan_code;
    if (!(await db.query('SELECT 1 FROM plans WHERE code = $1', [plan])).rows.length) throw new HttpError(400, 'Formule inconnue.');
    await db.query(
      `UPDATE companies SET status = $2, plan_code = $3, paid_until = $4::timestamptz, trial_ends_at = $5::timestamptz WHERE id = $1`,
      [c.id, status, plan, b.paid_until === undefined ? c.paid_until : (b.paid_until || null), b.trial_ends_at === undefined ? c.trial_ends_at : (b.trial_ends_at || null)]);
    return { ok: true };
  });

  app.post('/api/admin/companies/:id/extend', requireSuper, async (req) => {
    const days = Math.round(Number(req.body.days) || 0);
    if (!days) throw new HttpError(400, 'Nombre de jours invalide.');
    await db.query(
      `UPDATE companies SET status = CASE WHEN status = 'suspended' THEN 'active' ELSE status END,
         paid_until = GREATEST(COALESCE(paid_until, now()), now()) + ($2 || ' days')::interval WHERE id = $1`, [req.params.id, String(days)]);
    return { ok: true };
  });

  app.put('/api/admin/users/:id/password', requireSuper, async (req) => {
    if (!req.body.password || String(req.body.password).length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum.');
    const r = await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND role <> 'superadmin'`, [hashPassword(req.body.password), req.params.id]);
    if (!r.rowCount) throw new HttpError(404, 'Utilisateur introuvable.');
    return { ok: true };
  });

  app.get('/api/admin/payments', requireSuper, async (req) => {
    const params = [];
    let where = 'true';
    if (req.query.status) { params.push(req.query.status); where = 'p.status = $1'; }
    const { rows } = await db.query(
      `SELECT p.*, c.name AS company_name FROM subscription_payments p JOIN companies c ON c.id = p.company_id
       WHERE ${where} ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 500`, params);
    return rows;
  });

  app.post('/api/admin/payments/:id/approve', requireSuper, async (req) => {
    await db.tx((c) => activatePayment(c, req.params.id, req.user.id));
    return { ok: true };
  });

  app.post('/api/admin/payments/:id/reject', requireSuper, async (req) => {
    const r = await db.query(
      `UPDATE subscription_payments SET status = 'rejected', processed_at = now(), processed_by = $2, note = concat_ws(' — ', note, $3::text)
       WHERE id = $1 AND status = 'pending'`, [req.params.id, req.user.id, req.body.note || null]);
    if (!r.rowCount) throw new HttpError(409, 'Ce paiement n\'est plus en attente.');
    return { ok: true };
  });

  app.get('/api/admin/plans', requireSuper, async () => (await db.query('SELECT * FROM plans ORDER BY sort')).rows);

  app.put('/api/admin/plans/:code', requireSuper, async (req) => {
    const b = req.body;
    const features = Array.isArray(b.features) ? b.features.map(String).filter(Boolean) : String(b.features || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const r = await db.query(
      `UPDATE plans SET name = $2, description = $3, price_month = $4, price_year = $5, max_users = $6, features = $7::jsonb, active = $8 WHERE code = $1`,
      [req.params.code, String(b.name || '').trim() || req.params.code, b.description || null, Number(b.price_month) || 0, Number(b.price_year) || 0,
        Math.max(1, Number(b.max_users) || 1), JSON.stringify(features), b.active !== false]);
    if (!r.rowCount) throw new HttpError(404, 'Formule introuvable.');
    return { ok: true };
  });

  app.get('/api/admin/settings', requireSuper, async () => ({ ...(await platformSettings()), konnect_enabled: konnectEnabled(), konnect_env: process.env.KONNECT_ENV || 'sandbox' }));

  app.put('/api/admin/settings', requireSuper, async (req) => {
    const current = await platformSettings();
    const allowed = Object.keys(current);
    const next = { ...current };
    for (const k of allowed) if (req.body[k] !== undefined) next[k] = k === 'trial_days' ? Math.max(0, Number(req.body[k]) || 0) : String(req.body[k]);
    await db.query(`INSERT INTO platform_settings (key, value) VALUES ('platform', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
    return { ok: true };
  });
}

module.exports = { register };
