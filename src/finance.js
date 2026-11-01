'use strict';
// Règlements, recouvrement (balance âgée, relances) et stocks
const { HttpError } = require('../lib/http');
const { db, round3, nextNumber, localToday, DEFAULT_PREFIXES } = require('./db');
const { requireCompany } = require('./auth');
const { postPayment } = require('./ledger');

const METHODS = ['especes', 'cheque', 'virement', 'traite', 'carte', 'd17', 'autre'];
const today = localToday;
const num = (v) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

function register(app) {
  // ---------- Règlements ----------
  app.get('/api/payments', requireCompany, async (req) => {
    const q = req.query;
    const side = q.side === 'out' ? 'out' : 'in';
    const col = side === 'in' ? 'customer_id' : 'supplier_id';
    const table = side === 'in' ? 'customers' : 'suppliers';
    const params = [req.company.id, side];
    let where = 'p.company_id = $1 AND p.side = $2';
    if (q.partner_id) { params.push(q.partner_id); where += ` AND p.${col} = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` AND p.date >= $${params.length}::date`; }
    if (q.to) { params.push(q.to); where += ` AND p.date <= $${params.length}::date`; }
    if (q.method) { params.push(q.method); where += ` AND p.method = $${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND p.status = $${params.length}`; }
    if (q.portfolio) where += ` AND p.method IN ('cheque','traite') AND p.status = 'valide' AND p.due_date >= current_date`;
    if (q.q) { params.push('%' + q.q + '%'); where += ` AND (p.number ILIKE $${params.length} OR p.reference ILIKE $${params.length} OR t.name ILIKE $${params.length})`; }
    const { rows } = await db.query(
      `SELECT p.*, p.${col} AS partner_id, t.name AS partner_name,
              COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS allocated
       FROM payments p LEFT JOIN ${table} t ON t.id = p.${col}
       WHERE ${where} ORDER BY p.date DESC, p.id DESC LIMIT 2000`, params);
    return rows;
  });

  app.get('/api/payments/:id', requireCompany, async (req) => {
    const { rows } = await db.query('SELECT * FROM payments WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Règlement introuvable.');
    const col = p.side === 'in' ? 'customer_id' : 'supplier_id';
    const partner = (await db.query(`SELECT id, code, name, phone, email FROM ${p.side === 'in' ? 'customers' : 'suppliers'} WHERE id = $1`, [p[col]])).rows[0];
    const allocations = (await db.query(
      `SELECT a.amount, d.id AS document_id, d.number, d.type, d.date, d.total_ttc FROM payment_allocations a JOIN documents d ON d.id = a.document_id WHERE a.payment_id = $1`, [p.id])).rows;
    return { ...p, partner, allocations };
  });

  app.get('/api/open-items', requireCompany, async (req) => {
    const side = req.query.side === 'purchase' ? 'purchase' : 'sale';
    const col = side === 'sale' ? 'customer_id' : 'supplier_id';
    const { rows } = await db.query(
      `SELECT id, type, number, date, due_date, total_ttc, paid, total_ttc - paid AS open_amount
       FROM documents WHERE company_id = $1 AND side = $2 AND ${col} = $3 AND type = 'facture' AND status = 'valide' AND total_ttc - paid > 0.0005
       ORDER BY COALESCE(due_date, date), id`, [req.company.id, side, req.query.partner_id || 0]);
    return rows;
  });

  app.post('/api/payments', requireCompany, async (req) => {
    const b = req.body;
    const side = b.side === 'out' ? 'out' : 'in';
    const docSide = side === 'in' ? 'sale' : 'purchase';
    const col = side === 'in' ? 'customer_id' : 'supplier_id';
    const table = side === 'in' ? 'customers' : 'suppliers';
    const amount = round3(num(b.amount));
    const withholding = round3(num(b.withholding));
    if (amount <= 0) throw new HttpError(400, 'Le montant doit être supérieur à zéro.');
    if (withholding < 0) throw new HttpError(400, 'Retenue à la source invalide.');
    const method = METHODS.includes(b.method) ? b.method : 'especes';
    const date = b.date || today();
    const total = round3(amount + withholding);
    return db.tx(async (c) => {
      const pt = (await c.query(`SELECT id, name FROM ${table} WHERE company_id = $1 AND id = $2`, [req.company.id, b.partner_id || 0])).rows[0];
      if (!pt) throw new HttpError(400, side === 'in' ? 'Choisissez un client.' : 'Choisissez un fournisseur.');
      const open = (await c.query(
        `SELECT id, number, total_ttc - paid AS open_amount FROM documents
         WHERE company_id = $1 AND side = $2 AND ${col} = $3 AND type = 'facture' AND status = 'valide' AND total_ttc - paid > 0.0005
         ORDER BY COALESCE(due_date, date), id FOR UPDATE`, [req.company.id, docSide, pt.id])).rows;
      let allocations = [];
      if (Array.isArray(b.allocations) && b.allocations.length) {
        for (const a of b.allocations) {
          const amt = round3(num(a.amount));
          if (amt <= 0) continue;
          const d = open.find((o) => o.id === Number(a.document_id));
          if (!d) throw new HttpError(400, 'Une facture sélectionnée n\'est plus ouverte.');
          if (amt > round3(d.open_amount) + 0.0005) throw new HttpError(400, `Le montant affecté à ${d.number} dépasse son reste à payer.`);
          allocations.push({ document_id: d.id, amount: amt });
        }
      } else if (b.auto !== false) {
        let left = total;
        for (const d of open) {
          if (left <= 0) break;
          const amt = round3(Math.min(left, Number(d.open_amount)));
          allocations.push({ document_id: d.id, amount: amt });
          left = round3(left - amt);
        }
      }
      const allocated = round3(allocations.reduce((s, a) => s + a.amount, 0));
      if (allocated > total + 0.0005) throw new HttpError(400, 'Les affectations dépassent le montant du règlement.');
      const prefixKey = side === 'in' ? 'reglement_in' : 'reglement_out';
      const number = await nextNumber(c, req.company.id, 'PAY-' + side, (req.company.prefixes || {})[prefixKey] || DEFAULT_PREFIXES[prefixKey], date);
      const { rows } = await c.query(
        `INSERT INTO payments (company_id, side, ${col}, number, date, amount, withholding, method, reference, bank, due_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [req.company.id, side, pt.id, number, date, amount, withholding, method, b.reference || null, b.bank || null, b.due_date || null, b.note || null, req.user.id]);
      const p = rows[0];
      for (const a of allocations) {
        await c.query('INSERT INTO payment_allocations (payment_id, document_id, amount) VALUES ($1,$2,$3)', [p.id, a.document_id, a.amount]);
        await c.query('UPDATE documents SET paid = paid + $1 WHERE id = $2', [a.amount, a.document_id]);
      }
      await postPayment(c, req.company, p, pt.name);
      return { id: p.id, number, allocated, unallocated: round3(total - allocated) };
    });
  });

  app.post('/api/payments/:id/cancel', requireCompany, async (req) => {
    const reason = req.body.reason === 'impaye' ? 'impaye' : 'annule';
    return db.tx(async (c) => {
      const p = (await c.query('SELECT * FROM payments WHERE company_id = $1 AND id = $2 FOR UPDATE', [req.company.id, req.params.id])).rows[0];
      if (!p) throw new HttpError(404, 'Règlement introuvable.');
      if (p.status !== 'valide') throw new HttpError(409, 'Ce règlement est déjà annulé ou impayé.');
      const allocs = (await c.query('SELECT * FROM payment_allocations WHERE payment_id = $1', [p.id])).rows;
      for (const a of allocs) await c.query('UPDATE documents SET paid = GREATEST(0, paid - $1) WHERE id = $2', [a.amount, a.document_id]);
      await c.query('DELETE FROM payment_allocations WHERE payment_id = $1', [p.id]);
      await c.query('UPDATE payments SET status = $1, note = concat_ws(\' — \', note, $2::text) WHERE id = $3', [reason, req.body.note || null, p.id]);
      const col = p.side === 'in' ? 'customer_id' : 'supplier_id';
      const pt = (await c.query(`SELECT name FROM ${p.side === 'in' ? 'customers' : 'suppliers'} WHERE id = $1`, [p[col]])).rows[0];
      p.status = reason;
      await postPayment(c, req.company, p, pt ? pt.name : '', true);
      return { ok: true };
    });
  });

  // ---------- Recouvrement ----------
  async function aging(companyId, side) {
    const col = side === 'sale' ? 'customer_id' : 'supplier_id';
    const pside = side === 'sale' ? 'in' : 'out';
    const table = side === 'sale' ? 'customers' : 'suppliers';
    const docs = (await db.query(
      `SELECT ${col} AS pid, type, total_ttc - paid AS open, current_date - COALESCE(due_date, date) AS days, due_date
       FROM documents WHERE company_id = $1 AND side = $2 AND type IN ('facture','avoir') AND status = 'valide' AND total_ttc - paid > 0.0005`,
      [companyId, side])).rows;
    const credits = (await db.query(
      `SELECT p.${col} AS pid, (p.amount + p.withholding) - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS left
       FROM payments p WHERE p.company_id = $1 AND p.side = $2 AND p.status = 'valide'`, [companyId, pside])).rows;
    const partners = (await db.query(`SELECT id, code, name, phone, whatsapp, email, credit_limit FROM ${table} WHERE company_id = $1`, [companyId])).rows;
    const map = new Map();
    const get = (pid) => {
      if (!map.has(pid)) map.set(pid, { not_due: 0, d30: 0, d60: 0, d90: 0, d90p: 0, credits: 0, total: 0, oldest_days: 0, count: 0 });
      return map.get(pid);
    };
    for (const d of docs) {
      const r = get(d.pid);
      const open = Number(d.open);
      if (d.type === 'avoir') { r.credits -= open; continue; }
      r.count++;
      const days = Number(d.days);
      if (days <= 0) r.not_due += open;
      else if (days <= 30) r.d30 += open;
      else if (days <= 60) r.d60 += open;
      else if (days <= 90) r.d90 += open;
      else r.d90p += open;
      if (days > r.oldest_days) r.oldest_days = days;
    }
    for (const p of credits) { if (Number(p.left) > 0.0005) get(p.pid).credits -= Number(p.left); }
    const rows = [];
    for (const pt of partners) {
      const r = map.get(pt.id);
      if (!r) continue;
      for (const k of ['not_due', 'd30', 'd60', 'd90', 'd90p', 'credits']) r[k] = round3(r[k]);
      r.overdue = round3(r.d30 + r.d60 + r.d90 + r.d90p);
      r.total = round3(r.not_due + r.overdue + r.credits);
      if (Math.abs(r.total) < 0.0005 && !r.count) continue;
      rows.push({ ...pt, ...r });
    }
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }

  app.get('/api/recovery/aging', requireCompany, async (req) => {
    const side = req.query.side === 'purchase' ? 'purchase' : 'sale';
    const rows = await aging(req.company.id, side);
    if (side === 'sale') {
      const last = (await db.query(
        `SELECT DISTINCT ON (customer_id) customer_id, date, channel, level, next_date, promise_date, promise_amount
         FROM reminders WHERE company_id = $1 ORDER BY customer_id, date DESC, id DESC`, [req.company.id])).rows;
      const lm = new Map(last.map((l) => [l.customer_id, l]));
      rows.forEach((r) => { r.last_reminder = lm.get(r.id) || null; });
    }
    const totals = rows.reduce((t, r) => {
      for (const k of ['not_due', 'd30', 'd60', 'd90', 'd90p', 'credits', 'overdue', 'total']) t[k] = round3((t[k] || 0) + r[k]);
      return t;
    }, {});
    return { rows, totals };
  });

  app.get('/api/recovery/overview', requireCompany, async (req) => {
    const rows = await aging(req.company.id, 'sale');
    const total = round3(rows.reduce((s, r) => s + r.total, 0));
    const overdue = round3(rows.reduce((s, r) => s + r.overdue, 0));
    const ca90 = (await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'avoir' THEN -total_ttc ELSE total_ttc END), 0) AS v FROM documents
       WHERE company_id = $1 AND side = 'sale' AND type IN ('facture','avoir') AND status = 'valide' AND date > current_date - 90`, [req.company.id])).rows[0].v;
    const todo = (await db.query(`SELECT count(*)::int AS n FROM reminders WHERE company_id = $1 AND NOT done AND next_date <= current_date`, [req.company.id])).rows[0].n;
    const promises = (await db.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(promise_amount), 0) AS amount FROM reminders WHERE company_id = $1 AND NOT done AND promise_date IS NOT NULL`, [req.company.id])).rows[0];
    const collected = (await db.query(
      `SELECT COALESCE(SUM(amount + withholding), 0) AS v FROM payments WHERE company_id = $1 AND side = 'in' AND status = 'valide' AND date >= date_trunc('month', current_date)`, [req.company.id])).rows[0].v;
    return {
      total, overdue, overdue_rate: total > 0 ? round3(overdue / total * 100) : 0,
      dso: Number(ca90) > 0 ? Math.round(total / Number(ca90) * 90) : null,
      todo, promises, collected_month: Number(collected),
      over_limit: rows.filter((r) => Number(r.credit_limit) > 0 && r.total > Number(r.credit_limit)).length,
    };
  });

  app.get('/api/reminders', requireCompany, async (req) => {
    const params = [req.company.id];
    let where = 'r.company_id = $1';
    if (req.query.customer_id) { params.push(req.query.customer_id); where += ` AND r.customer_id = $${params.length}`; }
    if (req.query.todo) where += ' AND NOT r.done AND (r.next_date <= current_date OR r.promise_date <= current_date)';
    if (req.query.open) where += ' AND NOT r.done';
    const { rows } = await db.query(
      `SELECT r.*, c.name AS customer_name, c.phone, c.whatsapp, c.email, d.number AS document_number, u.name AS user_name
       FROM reminders r JOIN customers c ON c.id = r.customer_id LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN users u ON u.id = r.created_by
       WHERE ${where} ORDER BY ${req.query.todo ? 'COALESCE(r.next_date, r.promise_date)' : 'r.date DESC, r.id DESC'} LIMIT 1000`, params);
    return rows;
  });

  app.post('/api/reminders', requireCompany, async (req) => {
    const b = req.body;
    const cust = (await db.query('SELECT id FROM customers WHERE company_id = $1 AND id = $2', [req.company.id, b.customer_id || 0])).rows[0];
    if (!cust) throw new HttpError(400, 'Client introuvable.');
    const channels = ['telephone', 'email', 'whatsapp', 'sms', 'courrier', 'visite'];
    // Les relances précédentes du client sont considérées comme traitées
    await db.query('UPDATE reminders SET done = true WHERE company_id = $1 AND customer_id = $2 AND NOT done', [req.company.id, cust.id]);
    const { rows } = await db.query(
      `INSERT INTO reminders (company_id, customer_id, document_id, date, channel, level, note, promise_date, promise_amount, next_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.company.id, cust.id, b.document_id || null, b.date || today(), channels.includes(b.channel) ? b.channel : 'telephone',
        Math.min(3, Math.max(1, Number(b.level) || 1)), b.note || null, b.promise_date || null,
        b.promise_amount ? num(b.promise_amount) : null, b.next_date || null, req.user.id]);
    return { id: rows[0].id };
  });

  app.put('/api/reminders/:id', requireCompany, async (req) => {
    await db.query('UPDATE reminders SET done = $1 WHERE company_id = $2 AND id = $3', [!!req.body.done, req.company.id, req.params.id]);
    return { ok: true };
  });
  app.delete('/api/reminders/:id', requireCompany, async (req) => {
    await db.query('DELETE FROM reminders WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
    return { ok: true };
  });

  // ---------- Stocks ----------
  app.get('/api/stock/moves', requireCompany, async (req) => {
    const params = [req.company.id];
    let where = 'm.company_id = $1';
    if (req.query.product_id) { params.push(req.query.product_id); where += ` AND m.product_id = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); where += ` AND m.date >= $${params.length}::date`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND m.date <= $${params.length}::date`; }
    const { rows } = await db.query(
      `SELECT m.*, p.code AS product_code, p.name AS product_name, p.unit FROM stock_moves m JOIN products p ON p.id = m.product_id
       WHERE ${where} ORDER BY m.date DESC, m.id DESC LIMIT 2000`, params);
    return rows;
  });

  app.post('/api/stock/adjust', requireCompany, async (req) => {
    return db.tx(async (c) => {
      const p = (await c.query(`SELECT * FROM products WHERE company_id = $1 AND id = $2 FOR UPDATE`, [req.company.id, req.body.product_id || 0])).rows[0];
      if (!p) throw new HttpError(404, 'Article introuvable.');
      if (p.kind !== 'stock') throw new HttpError(400, 'Un service n\'a pas de stock.');
      const counted = num(req.body.counted);
      const delta = round3(counted - Number(p.stock));
      if (!delta) return { ok: true, delta: 0 };
      await c.query('UPDATE products SET stock = $1 WHERE id = $2', [counted, p.id]);
      await c.query(`INSERT INTO stock_moves (company_id, product_id, date, qty, unit_cost, kind, ref, note) VALUES ($1,$2,$3,$4,$5,'inventaire','Inventaire',$6)`,
        [req.company.id, p.id, req.body.date || today(), delta, p.avg_cost, req.body.note || null]);
      return { ok: true, delta };
    });
  });

  app.get('/api/stock/summary', requireCompany, async (req) => {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN stock > 0 THEN stock * avg_cost ELSE 0 END), 0) AS value,
              count(*) FILTER (WHERE stock <= min_stock) ::int AS alerts,
              count(*) FILTER (WHERE stock < 0)::int AS negatives,
              count(*)::int AS items
       FROM products WHERE company_id = $1 AND active AND kind = 'stock'`, [req.company.id]);
    return rows[0];
  });
}

module.exports = { register };
