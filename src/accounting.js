'use strict';
// Comptabilité, trésorerie et tableau de bord
const { HttpError } = require('../lib/http');
const { db, round3, localToday } = require('./db');
const { requireCompany } = require('./auth');
const { postEntry, accountsMap } = require('./ledger');

const JOURNALS = { VT: 'Ventes', AC: 'Achats', BQ: 'Banque', CA: 'Caisse', OD: 'Opérations diverses', AN: 'À-nouveaux' };
const num = (v) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };

function register(app) {
  // ---------- Plan comptable ----------
  app.get('/api/accounts', requireCompany, async (req) => {
    const { rows } = await db.query(
      `SELECT a.*, COALESCE(s.debit, 0) AS debit, COALESCE(s.credit, 0) AS credit FROM accounts a
       LEFT JOIN (SELECT account, SUM(debit) AS debit, SUM(credit) AS credit FROM entry_lines WHERE company_id = $1 GROUP BY account) s ON s.account = a.code
       WHERE a.company_id = $1 ORDER BY a.code`, [req.company.id]);
    return rows;
  });
  app.post('/api/accounts', requireCompany, async (req) => {
    const code = String(req.body.code || '').trim();
    const name = String(req.body.name || '').trim();
    if (!/^[0-9A-Za-z]{1,12}$/.test(code)) throw new HttpError(400, 'Numéro de compte invalide (chiffres uniquement, 12 caractères maximum).');
    if (!name) throw new HttpError(400, 'Intitulé obligatoire.');
    const { rows } = await db.query('INSERT INTO accounts (company_id, code, name) VALUES ($1,$2,$3) RETURNING *', [req.company.id, code, name]);
    return rows[0];
  });
  app.put('/api/accounts/:id', requireCompany, async (req) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Intitulé obligatoire.');
    await db.query('UPDATE accounts SET name = $1 WHERE company_id = $2 AND id = $3', [name, req.company.id, req.params.id]);
    return { ok: true };
  });
  app.delete('/api/accounts/:id', requireCompany, async (req) => {
    const a = (await db.query('SELECT code FROM accounts WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id])).rows[0];
    if (!a) throw new HttpError(404, 'Compte introuvable.');
    const used = (await db.query('SELECT 1 FROM entry_lines WHERE company_id = $1 AND account = $2 LIMIT 1', [req.company.id, a.code])).rows.length;
    if (used) throw new HttpError(409, 'Ce compte est mouvementé : il ne peut pas être supprimé.');
    await db.query('DELETE FROM accounts WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
    return { ok: true };
  });

  // ---------- Écritures ----------
  app.get('/api/entries', requireCompany, async (req) => {
    const q = req.query;
    const params = [req.company.id];
    let where = 'e.company_id = $1';
    if (q.journal) { params.push(q.journal); where += ` AND e.journal = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` AND e.date >= $${params.length}::date`; }
    if (q.to) { params.push(q.to); where += ` AND e.date <= $${params.length}::date`; }
    if (q.q) { params.push('%' + q.q + '%'); where += ` AND (e.label ILIKE $${params.length} OR e.number ILIKE $${params.length} OR e.ref ILIKE $${params.length})`; }
    const { rows } = await db.query(
      `SELECT e.*, (SELECT json_agg(json_build_object('account', l.account, 'label', l.label, 'debit', l.debit, 'credit', l.credit) ORDER BY l.id)
                    FROM entry_lines l WHERE l.entry_id = e.id) AS lines,
              (SELECT SUM(debit) FROM entry_lines l WHERE l.entry_id = e.id) AS total
       FROM entries e WHERE ${where} ORDER BY e.date DESC, e.id DESC LIMIT 1500`, params);
    return { journals: JOURNALS, entries: rows };
  });

  app.post('/api/entries', requireCompany, async (req) => {
    const b = req.body;
    const journal = JOURNALS[b.journal] ? b.journal : 'OD';
    const label = String(b.label || '').trim();
    if (!label) throw new HttpError(400, 'Libellé obligatoire.');
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({
      account: String(l.account || '').trim(), label: l.label || label, debit: round3(num(l.debit)), credit: round3(num(l.credit)),
    })).filter((l) => l.account && (l.debit || l.credit));
    if (lines.length < 2) throw new HttpError(400, 'Une écriture doit comporter au moins deux lignes.');
    const known = new Set((await db.query('SELECT code FROM accounts WHERE company_id = $1', [req.company.id])).rows.map((r) => r.code));
    const unknown = lines.filter((l) => !known.has(l.account)).map((l) => l.account);
    if (unknown.length) throw new HttpError(400, `Compte(s) absent(s) du plan comptable : ${[...new Set(unknown)].join(', ')}.`);
    const id = await db.tx((c) => postEntry(c, req.company.id, { journal, date: b.date || localToday(), label, ref: b.ref, source: 'manuel', lines }));
    return { id };
  });

  app.delete('/api/entries/:id', requireCompany, async (req) => {
    const e = (await db.query('SELECT source FROM entries WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id])).rows[0];
    if (!e) throw new HttpError(404, 'Écriture introuvable.');
    if (e.source !== 'manuel') throw new HttpError(409, 'Les écritures générées automatiquement ne peuvent pas être supprimées : annulez le document ou le règlement d\'origine.');
    await db.query('DELETE FROM entries WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
    return { ok: true };
  });

  // ---------- Grand livre ----------
  app.get('/api/ledger', requireCompany, async (req) => {
    const account = String(req.query.account || '').trim();
    if (!account) throw new HttpError(400, 'Indiquez un compte.');
    const from = req.query.from || '1900-01-01';
    const to = req.query.to || '2999-12-31';
    const params = [req.company.id, account + '%', from, to];
    const openParams = [req.company.id, account + '%', from];
    let extra = '';
    let openExtra = '';
    if (req.query.partner_id) {
      params.push(req.query.partner_id); extra = ' AND l.partner_id = $5';
      openParams.push(req.query.partner_id); openExtra = ' AND l.partner_id = $4';
    }
    const opening = (await db.query(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS v FROM entry_lines l JOIN entries e ON e.id = l.entry_id
       WHERE l.company_id = $1 AND l.account LIKE $2 AND e.date < $3::date ${openExtra}`, openParams)).rows[0].v;
    const { rows } = await db.query(
      `SELECT e.id AS entry_id, e.date, e.journal, e.number, e.ref, l.account, l.label, l.debit, l.credit
       FROM entry_lines l JOIN entries e ON e.id = l.entry_id
       WHERE l.company_id = $1 AND l.account LIKE $2 AND e.date >= $3::date AND e.date <= $4::date ${extra}
       ORDER BY e.date, e.id, l.id LIMIT 5000`, params);
    let bal = Number(opening);
    for (const r of rows) { bal = round3(bal + Number(r.debit) - Number(r.credit)); r.balance = bal; }
    const name = (await db.query('SELECT name FROM accounts WHERE company_id = $1 AND code = $2', [req.company.id, account])).rows[0];
    return { account, name: name ? name.name : null, opening: Number(opening), lines: rows, closing: bal };
  });

  // ---------- Balance générale ----------
  app.get('/api/trial-balance', requireCompany, async (req) => {
    const from = req.query.from || '1900-01-01';
    const to = req.query.to || '2999-12-31';
    const { rows } = await db.query(
      `SELECT l.account,
              SUM(CASE WHEN e.date < $2::date THEN l.debit - l.credit ELSE 0 END) AS opening,
              SUM(CASE WHEN e.date >= $2::date AND e.date <= $3::date THEN l.debit ELSE 0 END) AS debit,
              SUM(CASE WHEN e.date >= $2::date AND e.date <= $3::date THEN l.credit ELSE 0 END) AS credit
       FROM entry_lines l JOIN entries e ON e.id = l.entry_id
       WHERE l.company_id = $1 AND e.date <= $3::date GROUP BY l.account ORDER BY l.account`, [req.company.id, from, to]);
    const names = new Map((await db.query('SELECT code, name FROM accounts WHERE company_id = $1', [req.company.id])).rows.map((r) => [r.code, r.name]));
    const totals = { opening: 0, debit: 0, credit: 0, closing: 0 };
    const out = rows.map((r) => {
      const closing = round3(Number(r.opening) + Number(r.debit) - Number(r.credit));
      totals.debit = round3(totals.debit + Number(r.debit));
      totals.credit = round3(totals.credit + Number(r.credit));
      return { account: r.account, name: names.get(r.account) || '', opening: Number(r.opening), debit: Number(r.debit), credit: Number(r.credit), closing };
    });
    return { rows: out, totals };
  });

  // ---------- Aide à la déclaration de TVA ----------
  app.get('/api/vat', requireCompany, async (req) => {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const { rows } = await db.query(
      `SELECT to_char(d.date, 'MM') AS month, d.side, l.vat_rate,
              SUM(CASE WHEN d.type = 'avoir' THEN -l.total_ht ELSE l.total_ht END) AS base
       FROM document_lines l JOIN documents d ON d.id = l.document_id
       WHERE d.company_id = $1 AND d.type IN ('facture','avoir') AND d.status = 'valide' AND extract(year FROM d.date) = $2
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [req.company.id, year]);
    const timbres = (await db.query(
      `SELECT to_char(date, 'MM') AS month, SUM(timbre) AS t FROM documents
       WHERE company_id = $1 AND side = 'sale' AND type = 'facture' AND status = 'valide' AND extract(year FROM date) = $2 GROUP BY 1`, [req.company.id, year])).rows;
    const months = [];
    let carry = 0;
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const r = rows.filter((x) => x.month === mm);
      const sales = {}; const purchases = {};
      let collected = 0; let deductible = 0;
      for (const x of r) {
        const base = round3(x.base);
        const tva = round3(base * Number(x.vat_rate) / 100);
        const target = x.side === 'sale' ? sales : purchases;
        const k = String(Number(x.vat_rate));
        target[k] = { base: round3((target[k] ? target[k].base : 0) + base), tva: round3((target[k] ? target[k].tva : 0) + tva) };
        if (x.side === 'sale') collected += tva; else deductible += tva;
      }
      collected = round3(collected); deductible = round3(deductible);
      const t = timbres.find((x) => x.month === mm);
      const net = round3(collected - deductible - carry);
      const due = net > 0 ? net : 0;
      const nextCarry = net < 0 ? -net : 0;
      months.push({ month: m, sales, purchases, collected, deductible, carry_in: carry, due, carry_out: nextCarry, timbre: t ? Number(t.t) : 0 });
      carry = nextCarry;
    }
    return { year, months };
  });

  // ---------- Trésorerie ----------
  app.get('/api/treasury', requireCompany, async (req) => {
    const map = accountsMap(req.company);
    const bal = async (acc) => Number((await db.query(
      `SELECT COALESCE(SUM(debit - credit), 0) AS v FROM entry_lines WHERE company_id = $1 AND account LIKE $2`, [req.company.id, acc + '%'])).rows[0].v);
    const bank = await bal(map.banque);
    const cash = await bal(map.caisse);
    const receivables = (await db.query(
      `SELECT d.id, d.number, d.due_date, d.total_ttc - d.paid AS open, c.name AS partner_name FROM documents d JOIN customers c ON c.id = d.customer_id
       WHERE d.company_id = $1 AND d.side = 'sale' AND d.type = 'facture' AND d.status = 'valide' AND d.total_ttc - d.paid > 0.0005
         AND d.due_date <= current_date + 30 ORDER BY d.due_date LIMIT 200`, [req.company.id])).rows;
    const payables = (await db.query(
      `SELECT d.id, d.number, d.ext_ref, d.due_date, d.total_ttc - d.paid AS open, s.name AS partner_name FROM documents d JOIN suppliers s ON s.id = d.supplier_id
       WHERE d.company_id = $1 AND d.side = 'purchase' AND d.type = 'facture' AND d.status = 'valide' AND d.total_ttc - d.paid > 0.0005
         AND d.due_date <= current_date + 30 ORDER BY d.due_date LIMIT 200`, [req.company.id])).rows;
    const portfolio = (await db.query(
      `SELECT p.id, p.number, p.method, p.reference, p.bank, p.due_date, p.amount, c.name AS partner_name FROM payments p JOIN customers c ON c.id = p.customer_id
       WHERE p.company_id = $1 AND p.side = 'in' AND p.status = 'valide' AND p.method IN ('cheque','traite') AND p.due_date >= current_date
       ORDER BY p.due_date LIMIT 200`, [req.company.id])).rows;
    const flows = (await db.query(
      `SELECT to_char(date, 'YYYY-MM') AS month,
              SUM(CASE WHEN side = 'in' THEN amount ELSE 0 END) AS cash_in,
              SUM(CASE WHEN side = 'out' THEN amount ELSE 0 END) AS cash_out
       FROM payments WHERE company_id = $1 AND status = 'valide' AND date >= date_trunc('month', current_date) - interval '5 months'
       GROUP BY 1 ORDER BY 1`, [req.company.id])).rows;
    return { bank, cash, total: round3(bank + cash), receivables, payables, portfolio, flows };
  });

  // ---------- Tableau de bord ----------
  app.get('/api/dashboard', requireCompany, async (req) => {
    const cid = req.company.id;
    const map = accountsMap(req.company);
    const one = async (sql, p = [cid]) => (await db.query(sql, p)).rows[0];
    const salesSign = `CASE WHEN type = 'avoir' THEN -total_ht ELSE total_ht END`;
    const ca = await one(
      `SELECT COALESCE(SUM(${salesSign}) FILTER (WHERE date >= date_trunc('month', current_date)), 0) AS month,
              COALESCE(SUM(${salesSign}) FILTER (WHERE date >= date_trunc('month', current_date) - interval '1 month' AND date < date_trunc('month', current_date)), 0) AS prev_month,
              COALESCE(SUM(${salesSign}) FILTER (WHERE date >= date_trunc('year', current_date)), 0) AS year
       FROM documents WHERE company_id = $1 AND side = 'sale' AND type IN ('facture','avoir') AND status = 'valide'`);
    const series = (await db.query(
      `SELECT to_char(date, 'YYYY-MM') AS month, side, SUM(${salesSign}) AS ht FROM documents
       WHERE company_id = $1 AND type IN ('facture','avoir') AND status = 'valide' AND date >= date_trunc('month', current_date) - interval '11 months'
       GROUP BY 1, 2 ORDER BY 1`, [cid])).rows;
    const recv = await one(
      `SELECT COALESCE(SUM(total_ttc - paid), 0) AS total, COALESCE(SUM(total_ttc - paid) FILTER (WHERE due_date < current_date), 0) AS overdue,
              count(*) FILTER (WHERE due_date < current_date)::int AS overdue_count
       FROM documents WHERE company_id = $1 AND side = 'sale' AND type = 'facture' AND status = 'valide' AND total_ttc - paid > 0.0005`);
    const pay = await one(
      `SELECT COALESCE(SUM(total_ttc - paid), 0) AS total, COALESCE(SUM(total_ttc - paid) FILTER (WHERE due_date < current_date), 0) AS overdue
       FROM documents WHERE company_id = $1 AND side = 'purchase' AND type = 'facture' AND status = 'valide' AND total_ttc - paid > 0.0005`);
    const treasury = await one(
      `SELECT COALESCE(SUM(debit - credit), 0) AS v FROM entry_lines WHERE company_id = $1 AND (account LIKE $2 OR account LIKE $3)`,
      [cid, map.banque + '%', map.caisse + '%']);
    const stock = await one(
      `SELECT COALESCE(SUM(CASE WHEN stock > 0 THEN stock * avg_cost ELSE 0 END), 0) AS value, count(*) FILTER (WHERE stock <= min_stock)::int AS alerts
       FROM products WHERE company_id = $1 AND active AND kind = 'stock'`);
    const pipeline = await one(
      `SELECT count(*) FILTER (WHERE type = 'devis')::int AS quotes, COALESCE(SUM(total_ht) FILTER (WHERE type = 'devis'), 0) AS quotes_amount,
              count(*) FILTER (WHERE type = 'commande')::int AS orders, COALESCE(SUM(total_ht) FILTER (WHERE type = 'commande'), 0) AS orders_amount
       FROM documents WHERE company_id = $1 AND side = 'sale' AND status = 'valide' AND type IN ('devis','commande')`);
    const debtors = (await db.query(
      `SELECT c.id, c.name, SUM(d.total_ttc - d.paid) AS open, MAX(current_date - d.due_date) AS days
       FROM documents d JOIN customers c ON c.id = d.customer_id
       WHERE d.company_id = $1 AND d.side = 'sale' AND d.type = 'facture' AND d.status = 'valide' AND d.total_ttc - d.paid > 0.0005
       GROUP BY c.id, c.name ORDER BY open DESC LIMIT 5`, [cid])).rows;
    const todo = await one(`SELECT count(*)::int AS n FROM reminders WHERE company_id = $1 AND NOT done AND (next_date <= current_date OR promise_date <= current_date)`);
    const recent = (await db.query(
      `SELECT d.id, d.side, d.type, d.number, d.date, d.due_date, d.status, d.total_ttc, d.paid, COALESCE(c.name, s.name) AS partner_name
       FROM documents d LEFT JOIN customers c ON c.id = d.customer_id LEFT JOIN suppliers s ON s.id = d.supplier_id
       WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT 6`, [cid])).rows;
    return {
      ca: { month: Number(ca.month), prev_month: Number(ca.prev_month), year: Number(ca.year) },
      series, receivables: recv, payables: pay, treasury: Number(treasury.v), stock, pipeline, debtors, reminders_todo: todo.n, recent,
    };
  });
}

module.exports = { register };
