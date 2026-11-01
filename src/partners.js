'use strict';
const { HttpError } = require('../lib/http');
const { db, round3 } = require('./db');
const { requireCompany } = require('./auth');

const PARTNER_FIELDS = ['code', 'name', 'tax_id', 'address', 'city', 'phone', 'whatsapp', 'email', 'contact', 'terms', 'credit_limit', 'notes', 'active'];
const PRODUCT_FIELDS = ['code', 'name', 'family', 'unit', 'kind', 'sale_price', 'purchase_price', 'vat_rate', 'min_stock', 'active'];
const NUMERIC = new Set(['terms', 'credit_limit', 'sale_price', 'purchase_price', 'vat_rate', 'min_stock', 'stock']);

async function nextCode(c, companyId, key, prefix) {
  for (;;) {
    const { rows } = await c.query(
      `INSERT INTO counters (company_id, key, year, value) VALUES ($1, $2, 0, 1)
       ON CONFLICT (company_id, key, year) DO UPDATE SET value = counters.value + 1 RETURNING value`, [companyId, key]);
    const code = prefix + String(rows[0].value).padStart(4, '0');
    const table = key === 'code-customer' ? 'customers' : key === 'code-supplier' ? 'suppliers' : 'products';
    const ex = await c.query(`SELECT 1 FROM ${table} WHERE company_id = $1 AND code = $2`, [companyId, code]);
    if (!ex.rows.length) return code;
  }
}

function clean(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (typeof v === 'string') v = v.trim();
    if (NUMERIC.has(f)) v = v === '' || v === null ? 0 : Number(String(v).replace(/\s/g, '').replace(',', '.'));
    if (NUMERIC.has(f) && !isFinite(v)) throw new HttpError(400, `Valeur numérique invalide pour « ${f} ».`);
    if (v === '') v = null;
    out[f] = v;
  }
  return out;
}

// Solde ouvert par tiers (documents non soldés - règlements non affectés)
function balanceSql(side) {
  const col = side === 'sale' ? 'customer_id' : 'supplier_id';
  const pside = side === 'sale' ? 'in' : 'out';
  return `SELECT pid, SUM(due) AS balance FROM (
      SELECT ${col} AS pid, CASE WHEN type = 'avoir' THEN -(total_ttc - paid) ELSE (total_ttc - paid) END AS due
      FROM documents WHERE company_id = $1 AND side = '${side}' AND type IN ('facture','avoir') AND status = 'valide'
      UNION ALL
      SELECT p.${col}, -((p.amount + p.withholding) - COALESCE((SELECT SUM(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0))
      FROM payments p WHERE p.company_id = $1 AND p.side = '${pside}' AND p.status = 'valide'
    ) x GROUP BY pid`;
}

function partnerRoutes(app, entity) {
  const table = entity === 'customers' ? 'customers' : 'suppliers';
  const side = entity === 'customers' ? 'sale' : 'purchase';
  const col = entity === 'customers' ? 'customer_id' : 'supplier_id';
  const codeKey = entity === 'customers' ? 'code-customer' : 'code-supplier';
  const codePrefix = entity === 'customers' ? 'C' : 'F';

  app.get(`/api/${entity}`, requireCompany, async (req) => {
    const params = [req.company.id];
    let where = `t.company_id = $1`;
    if (req.query.q) { params.push('%' + req.query.q + '%'); where += ` AND (t.name ILIKE $${params.length} OR t.code ILIKE $${params.length} OR t.phone ILIKE $${params.length} OR t.city ILIKE $${params.length})`; }
    if (req.query.active !== 'all') where += ' AND t.active';
    const { rows } = await db.query(
      `SELECT t.*, COALESCE(b.balance, 0) AS balance FROM ${table} t LEFT JOIN (${balanceSql(side)}) b ON b.pid = t.id
       WHERE ${where} ORDER BY t.name LIMIT 2000`, params);
    return rows;
  });

  app.get(`/api/${entity}/:id`, requireCompany, async (req) => {
    const { rows } = await db.query(`SELECT t.*, COALESCE(b.balance, 0) AS balance FROM ${table} t LEFT JOIN (${balanceSql(side)}) b ON b.pid = t.id WHERE t.company_id = $1 AND t.id = $2`, [req.company.id, req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Fiche introuvable.');
    return rows[0];
  });

  app.post(`/api/${entity}`, requireCompany, async (req) => {
    const data = clean(req.body, PARTNER_FIELDS);
    if (!data.name) throw new HttpError(400, 'Le nom est obligatoire.');
    return db.tx(async (c) => {
      if (!data.code) data.code = await nextCode(c, req.company.id, codeKey, codePrefix);
      if (data.terms === undefined) data.terms = req.company.default_terms;
      const keys = Object.keys(data);
      const { rows } = await c.query(
        `INSERT INTO ${table} (company_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING *`,
        [req.company.id, ...keys.map((k) => data[k])]);
      return rows[0];
    });
  });

  app.put(`/api/${entity}/:id`, requireCompany, async (req) => {
    const data = clean(req.body, PARTNER_FIELDS);
    if (data.name === null) throw new HttpError(400, 'Le nom est obligatoire.');
    if (data.code === null) delete data.code;
    const keys = Object.keys(data);
    if (!keys.length) return { ok: true };
    const { rows } = await db.query(
      `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE company_id = $1 AND id = $2 RETURNING *`,
      [req.company.id, req.params.id, ...keys.map((k) => data[k])]);
    if (!rows[0]) throw new HttpError(404, 'Fiche introuvable.');
    return rows[0];
  });

  app.delete(`/api/${entity}/:id`, requireCompany, async (req) => {
    try {
      const r = await db.query(`DELETE FROM ${table} WHERE company_id = $1 AND id = $2`, [req.company.id, req.params.id]);
      if (!r.rowCount) throw new HttpError(404, 'Fiche introuvable.');
      return { deleted: true };
    } catch (e) {
      if (e.code !== '23503') throw e;
      await db.query(`UPDATE ${table} SET active = false WHERE company_id = $1 AND id = $2`, [req.company.id, req.params.id]);
      return { archived: true };
    }
  });

  // Relevé de compte
  app.get(`/api/${entity}/:id/statement`, requireCompany, async (req) => {
    const pside = side === 'sale' ? 'in' : 'out';
    const docs = await db.query(
      `SELECT id, type, number, date, due_date, total_ttc, paid FROM documents
       WHERE company_id = $1 AND ${col} = $2 AND side = '${side}' AND type IN ('facture','avoir') AND status = 'valide'`,
      [req.company.id, req.params.id]);
    const pays = await db.query(
      `SELECT id, number, date, amount, withholding, method, reference, status FROM payments
       WHERE company_id = $1 AND ${col} = $2 AND side = '${pside}' AND status IN ('valide','impaye')`,
      [req.company.id, req.params.id]);
    const lines = [];
    for (const d of docs.rows) {
      const isAvoir = d.type === 'avoir';
      lines.push({ date: d.date, kind: 'document', id: d.id, label: (isAvoir ? 'Avoir ' : 'Facture ') + d.number, due_date: d.due_date,
        debit: isAvoir ? 0 : d.total_ttc, credit: isAvoir ? d.total_ttc : 0, open: round3(d.total_ttc - d.paid) });
    }
    const methodLabel = { especes: 'Espèces', cheque: 'Chèque', virement: 'Virement', traite: 'Traite', carte: 'Carte', d17: 'D17', autre: 'Autre' };
    for (const p of pays.rows) {
      const total = round3(Number(p.amount) + Number(p.withholding));
      const label = `${side === 'sale' ? 'Règlement' : 'Paiement'} ${p.number || ''} – ${methodLabel[p.method] || p.method}${p.reference ? ' n° ' + p.reference : ''}`;
      lines.push({ date: p.date, kind: 'payment', id: p.id, label, debit: 0, credit: total });
      if (p.status === 'impaye') lines.push({ date: p.date, kind: 'payment', id: p.id, label: 'Impayé – ' + label, debit: total, credit: 0 });
    }
    // Pour un fournisseur, le sens est inversé (facture = crédit)
    if (side === 'purchase') lines.forEach((l) => { const d = l.debit; l.debit = l.credit; l.credit = d; });
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.kind === 'document' ? -1 : 1)));
    let bal = 0;
    for (const l of lines) { bal = round3(bal + Number(l.debit) - Number(l.credit)); l.balance = bal; }
    return { lines, balance: bal };
  });

  // Import en masse (CSV / Excel converti côté navigateur)
  app.post(`/api/import/${entity}`, requireCompany, async (req) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
    let created = 0; let updated = 0;
    const errors = [];
    await db.tx(async (c) => {
      for (let i = 0; i < rows.length; i++) {
        let data;
        try { data = clean(rows[i], PARTNER_FIELDS); } catch (e) { errors.push(`Ligne ${i + 2} : ${e.message}`); continue; }
        if (!data.name) { errors.push(`Ligne ${i + 2} : nom manquant`); continue; }
        if (!data.code) data.code = await nextCode(c, req.company.id, codeKey, codePrefix);
        if (data.terms === undefined) data.terms = req.company.default_terms;
        delete data.active;
        const keys = Object.keys(data);
        const r = await c.query(
          `INSERT INTO ${table} (company_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, j) => '$' + (j + 2)).join(', ')})
           ON CONFLICT (company_id, code) DO UPDATE SET ${keys.filter((k) => k !== 'code').map((k) => `${k} = EXCLUDED.${k}`).join(', ')}
           RETURNING (xmax = 0) AS inserted`, [req.company.id, ...keys.map((k) => data[k])]);
        if (r.rows[0].inserted) created++; else updated++;
      }
    });
    return { created, updated, errors: errors.slice(0, 50) };
  });
}

function register(app) {
  partnerRoutes(app, 'customers');
  partnerRoutes(app, 'suppliers');

  app.get('/api/products', requireCompany, async (req) => {
    const params = [req.company.id];
    let where = 'company_id = $1';
    if (req.query.q) { params.push('%' + req.query.q + '%'); where += ` AND (name ILIKE $2 OR code ILIKE $2 OR family ILIKE $2)`; }
    if (req.query.active !== 'all') where += ' AND active';
    if (req.query.alerts) where += ` AND kind = 'stock' AND stock <= min_stock`;
    const { rows } = await db.query(`SELECT * FROM products WHERE ${where} ORDER BY name LIMIT 5000`, params);
    return rows;
  });

  app.get('/api/products/:id', requireCompany, async (req) => {
    const { rows } = await db.query('SELECT * FROM products WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Article introuvable.');
    return rows[0];
  });

  app.post('/api/products', requireCompany, async (req) => {
    const data = clean(req.body, PRODUCT_FIELDS);
    if (!data.name) throw new HttpError(400, 'La désignation est obligatoire.');
    if (data.kind && !['stock', 'service'].includes(data.kind)) data.kind = 'stock';
    const initial = Number(String(req.body.stock || 0).replace(',', '.')) || 0;
    return db.tx(async (c) => {
      if (!data.code) data.code = await nextCode(c, req.company.id, 'code-product', 'A');
      data.avg_cost = data.purchase_price || 0;
      const keys = Object.keys(data);
      const { rows } = await c.query(
        `INSERT INTO products (company_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')}) RETURNING *`,
        [req.company.id, ...keys.map((k) => data[k])]);
      const p = rows[0];
      if (initial && p.kind === 'stock') {
        await c.query('UPDATE products SET stock = $1 WHERE id = $2', [initial, p.id]);
        await c.query(`INSERT INTO stock_moves (company_id, product_id, qty, unit_cost, kind, ref, note) VALUES ($1,$2,$3,$4,'initial','Stock initial',NULL)`,
          [req.company.id, p.id, initial, p.avg_cost]);
        p.stock = initial;
      }
      return p;
    });
  });

  app.put('/api/products/:id', requireCompany, async (req) => {
    const data = clean(req.body, PRODUCT_FIELDS);
    if (data.name === null) throw new HttpError(400, 'La désignation est obligatoire.');
    if (data.code === null) delete data.code;
    if (data.kind && !['stock', 'service'].includes(data.kind)) data.kind = 'stock';
    const keys = Object.keys(data);
    if (!keys.length) return { ok: true };
    const { rows } = await db.query(
      `UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE company_id = $1 AND id = $2 RETURNING *`,
      [req.company.id, req.params.id, ...keys.map((k) => data[k])]);
    if (!rows[0]) throw new HttpError(404, 'Article introuvable.');
    return rows[0];
  });

  app.delete('/api/products/:id', requireCompany, async (req) => {
    try {
      await db.tx(async (c) => {
        await c.query('DELETE FROM stock_moves WHERE company_id = $1 AND product_id = $2 AND kind = \'initial\'', [req.company.id, req.params.id]);
        const r = await c.query('DELETE FROM products WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
        if (!r.rowCount) throw new HttpError(404, 'Article introuvable.');
      });
      return { deleted: true };
    } catch (e) {
      if (e.code !== '23503') throw e;
      await db.query('UPDATE products SET active = false WHERE company_id = $1 AND id = $2', [req.company.id, req.params.id]);
      return { archived: true };
    }
  });

  app.post('/api/import/products', requireCompany, async (req) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
    let created = 0; let updated = 0;
    const errors = [];
    await db.tx(async (c) => {
      for (let i = 0; i < rows.length; i++) {
        let data;
        try { data = clean(rows[i], [...PRODUCT_FIELDS, 'stock']); } catch (e) { errors.push(`Ligne ${i + 2} : ${e.message}`); continue; }
        if (!data.name) { errors.push(`Ligne ${i + 2} : désignation manquante`); continue; }
        const stock = data.stock || 0;
        delete data.stock; delete data.active;
        if (data.kind) data.kind = /serv/i.test(data.kind) ? 'service' : 'stock';
        if (!data.code) data.code = await nextCode(c, req.company.id, 'code-product', 'A');
        const keys = Object.keys(data);
        const r = await c.query(
          `INSERT INTO products (company_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, j) => '$' + (j + 2)).join(', ')})
           ON CONFLICT (company_id, code) DO UPDATE SET ${keys.filter((k) => k !== 'code').map((k) => `${k} = EXCLUDED.${k}`).join(', ')}
           RETURNING id, (xmax = 0) AS inserted, kind, purchase_price`, [req.company.id, ...keys.map((k) => data[k])]);
        const p = r.rows[0];
        if (p.inserted) {
          created++;
          await c.query('UPDATE products SET avg_cost = purchase_price WHERE id = $1', [p.id]);
          if (stock && p.kind === 'stock') {
            await c.query('UPDATE products SET stock = $1 WHERE id = $2', [stock, p.id]);
            await c.query(`INSERT INTO stock_moves (company_id, product_id, qty, unit_cost, kind, ref) VALUES ($1,$2,$3,$4,'initial','Stock initial (import)')`,
              [req.company.id, p.id, stock, p.purchase_price]);
          }
        } else updated++;
      }
    });
    return { created, updated, errors: errors.slice(0, 50) };
  });
}

module.exports = { register, balanceSql };
