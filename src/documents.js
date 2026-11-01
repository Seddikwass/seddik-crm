'use strict';
const { HttpError } = require('../lib/http');
const { db, round3, nextNumber, localToday, DEFAULT_PREFIXES } = require('./db');
const { requireCompany } = require('./auth');
const { postInvoice } = require('./ledger');

const TYPES = {
  sale: ['devis', 'commande', 'livraison', 'facture', 'avoir'],
  purchase: ['commande', 'reception', 'facture', 'avoir'],
};
const TRANSFORMS = {
  sale: { devis: ['commande', 'livraison', 'facture'], commande: ['livraison', 'facture'], livraison: ['facture'], facture: ['avoir'] },
  purchase: { commande: ['reception', 'facture'], reception: ['facture'], facture: ['avoir'] },
};
const LABELS = {
  sale: { devis: 'Devis', commande: 'Commande client', livraison: 'Bon de livraison', facture: 'Facture', avoir: 'Avoir' },
  purchase: { commande: 'Commande fournisseur', reception: 'Bon de réception', facture: 'Facture fournisseur', avoir: 'Avoir fournisseur' },
};
const FISCAL = new Set(['facture', 'avoir']);

const prefixFor = (company, side, type) => {
  const key = side === 'sale' ? type : 'p_' + type;
  return (company.prefixes && company.prefixes[key]) || DEFAULT_PREFIXES[key] || type.slice(0, 2).toUpperCase();
};
const counterKey = (side, type) => (side === 'sale' ? 'S-' : 'P-') + type;
const partnerCol = (side) => (side === 'sale' ? 'customer_id' : 'supplier_id');
const partnerTable = (side) => (side === 'sale' ? 'customers' : 'suppliers');

function checkKind(side, type) {
  if (!TYPES[side] || !TYPES[side].includes(type)) throw new HttpError(400, 'Type de document invalide.');
}

const num = (v, d = 0) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : d;
};

function computeTotals(lines, timbre) {
  let ht = 0; let tva = 0;
  const out = lines.map((l, i) => {
    const qty = num(l.qty, 0);
    const price = num(l.unit_price, 0);
    const discount = Math.min(100, Math.max(0, num(l.discount, 0)));
    const rate = num(l.vat_rate, 0);
    const total = round3(qty * price * (1 - discount / 100));
    ht += total;
    tva += total * rate / 100;
    return { position: i, product_id: l.product_id ? Number(l.product_id) : null, description: String(l.description || '').slice(0, 2000), qty, unit_price: price, discount, vat_rate: rate, total_ht: total };
  });
  ht = round3(ht); tva = round3(tva);
  const t = round3(num(timbre, 0));
  return { lines: out, total_ht: ht, total_tva: tva, timbre: t, total_ttc: round3(ht + tva + t) };
}

async function loadDoc(c, companyId, id, lock = false) {
  const { rows } = await c.query(`SELECT * FROM documents WHERE company_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`, [companyId, id]);
  if (!rows[0]) throw new HttpError(404, 'Document introuvable.');
  return rows[0];
}

async function loadLines(c, docId) {
  const { rows } = await c.query(
    `SELECT l.*, p.code AS product_code, p.unit, p.kind AS product_kind FROM document_lines l
     LEFT JOIN products p ON p.id = l.product_id WHERE l.document_id = $1 ORDER BY l.position, l.id`, [docId]);
  return rows;
}

async function writeLines(c, companyId, docId, lines) {
  await c.query('DELETE FROM document_lines WHERE document_id = $1', [docId]);
  for (const l of lines) {
    if (l.product_id) {
      const p = await c.query('SELECT name FROM products WHERE company_id = $1 AND id = $2', [companyId, l.product_id]);
      if (!p.rows[0]) throw new HttpError(400, 'Article introuvable sur une ligne.');
      if (!l.description) l.description = p.rows[0].name;
    }
    if (!l.description && !l.product_id) continue;
    await c.query(
      `INSERT INTO document_lines (document_id, position, product_id, description, qty, unit_price, discount, vat_rate, total_ht)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docId, l.position, l.product_id, l.description, l.qty, l.unit_price, l.discount, l.vat_rate, l.total_ht]);
  }
}

// Le stock a-t-il déjà été mouvementé par un document parent (BL / réception) ?
async function stockAlreadyMoved(c, doc) {
  let srcId = doc.source_id;
  for (let i = 0; srcId && i < 6; i++) {
    const { rows } = await c.query('SELECT id, type, source_id, stock_done FROM documents WHERE id = $1', [srcId]);
    const s = rows[0];
    if (!s) return false;
    if ((s.type === 'livraison' || s.type === 'reception') && s.stock_done) return true;
    srcId = s.source_id;
  }
  return false;
}

async function moveStock(c, companyId, doc, lines, direction, kindLabel) {
  for (const l of lines) {
    if (!l.product_id || l.product_kind !== 'stock') continue;
    const qty = round3(Number(l.qty) * direction);
    if (!qty) continue;
    if (qty > 0 && doc.side === 'purchase') {
      const cost = round3(Number(l.unit_price) * (1 - Number(l.discount) / 100));
      await c.query(
        `UPDATE products SET
           avg_cost = CASE WHEN stock > 0 THEN round((stock * avg_cost + $2::numeric * $3::numeric) / (stock + $2::numeric), 3) ELSE $3::numeric END,
           purchase_price = $3::numeric, stock = stock + $2::numeric
         WHERE id = $1`, [l.product_id, qty, cost]);
      await c.query(`INSERT INTO stock_moves (company_id, product_id, date, qty, unit_cost, kind, ref, document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, l.product_id, doc.date, qty, cost, kindLabel, doc.number, doc.id]);
    } else {
      const p = await c.query('UPDATE products SET stock = stock + $2 WHERE id = $1 RETURNING avg_cost', [l.product_id, qty]);
      await c.query(`INSERT INTO stock_moves (company_id, product_id, date, qty, unit_cost, kind, ref, document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, l.product_id, doc.date, qty, p.rows[0] ? p.rows[0].avg_cost : 0, kindLabel, doc.number, doc.id]);
    }
  }
}

function register(app) {
  app.get('/api/documents', requireCompany, async (req) => {
    const q = req.query;
    const side = q.side === 'purchase' ? 'purchase' : 'sale';
    const col = partnerCol(side);
    const params = [req.company.id, side];
    let where = 'd.company_id = $1 AND d.side = $2';
    if (q.type) { params.push(q.type); where += ` AND d.type = $${params.length}`; }
    if (q.status) { params.push(q.status); where += ` AND d.status = $${params.length}`; }
    if (q.partner_id) { params.push(q.partner_id); where += ` AND d.${col} = $${params.length}`; }
    if (q.from) { params.push(q.from); where += ` AND d.date >= $${params.length}::date`; }
    if (q.to) { params.push(q.to); where += ` AND d.date <= $${params.length}::date`; }
    if (q.q) { params.push('%' + q.q + '%'); where += ` AND (d.number ILIKE $${params.length} OR t.name ILIKE $${params.length} OR d.ext_ref ILIKE $${params.length})`; }
    if (q.open) where += ` AND d.type IN ('facture','avoir') AND d.status = 'valide' AND d.total_ttc - d.paid > 0.0005`;
    if (q.overdue) where += ` AND d.due_date < current_date`;
    const { rows } = await db.query(
      `SELECT d.id, d.side, d.type, d.number, d.date, d.due_date, d.status, d.total_ht, d.total_tva, d.timbre, d.total_ttc, d.paid,
              d.ext_ref, d.${col} AS partner_id, t.name AS partner_name, t.code AS partner_code,
              CASE WHEN d.type IN ('facture','avoir') AND d.status = 'valide' THEN d.total_ttc - d.paid ELSE 0 END AS open_amount,
              CASE WHEN d.due_date IS NOT NULL THEN current_date - d.due_date ELSE NULL END AS days_late
       FROM documents d LEFT JOIN ${partnerTable(side)} t ON t.id = d.${col}
       WHERE ${where} ORDER BY d.date DESC, d.id DESC LIMIT 2000`, params);
    return rows;
  });

  app.get('/api/documents/:id', requireCompany, async (req) => {
    const doc = await loadDoc(db, req.company.id, req.params.id);
    const lines = await loadLines(db, doc.id);
    const col = partnerCol(doc.side);
    const partner = doc[col] ? (await db.query(`SELECT * FROM ${partnerTable(doc.side)} WHERE id = $1`, [doc[col]])).rows[0] : null;
    const children = (await db.query('SELECT id, type, number, status, date FROM documents WHERE source_id = $1 ORDER BY id', [doc.id])).rows;
    const source = doc.source_id ? (await db.query('SELECT id, type, number, status, date FROM documents WHERE id = $1', [doc.source_id])).rows[0] : null;
    const payments = (await db.query(
      `SELECT p.id, p.number, p.date, p.method, p.reference, p.status, a.amount FROM payment_allocations a
       JOIN payments p ON p.id = a.payment_id WHERE a.document_id = $1 ORDER BY p.date`, [doc.id])).rows;
    return {
      ...doc, partner_id: doc[col], partner, lines, children, source, payments,
      label: LABELS[doc.side][doc.type], transforms: doc.status === 'valide' ? (TRANSFORMS[doc.side][doc.type] || []) : [],
    };
  });

  async function save(req, existing) {
    const b = req.body;
    const side = existing ? existing.side : (b.side === 'purchase' ? 'purchase' : 'sale');
    const type = existing ? existing.type : b.type;
    checkKind(side, type);
    const col = partnerCol(side);
    const partnerId = Number(b.partner_id) || null;
    if (!partnerId) throw new HttpError(400, side === 'sale' ? 'Choisissez un client.' : 'Choisissez un fournisseur.');
    const pt = await db.query(`SELECT id FROM ${partnerTable(side)} WHERE company_id = $1 AND id = $2`, [req.company.id, partnerId]);
    if (!pt.rows[0]) throw new HttpError(400, 'Tiers introuvable.');
    const lines = Array.isArray(b.lines) ? b.lines : [];
    const timbre = type === 'facture' ? (b.timbre === undefined || b.timbre === null || b.timbre === '' ? req.company.timbre : b.timbre) : 0;
    const t = computeTotals(lines, timbre);
    const date = b.date || localToday();
    return db.tx(async (c) => {
      let id;
      if (existing) {
        const cur = await loadDoc(c, req.company.id, existing.id, true);
        if (cur.status !== 'brouillon') throw new HttpError(409, 'Seul un brouillon peut être modifié.');
        await c.query(
          `UPDATE documents SET date = $1, due_date = $2, ${col} = $3, notes = $4, ext_ref = $5, return_stock = $6,
             total_ht = $7, total_tva = $8, timbre = $9, total_ttc = $10 WHERE id = $11`,
          [date, b.due_date || null, partnerId, b.notes || null, b.ext_ref || null, !!b.return_stock, t.total_ht, t.total_tva, t.timbre, t.total_ttc, cur.id]);
        id = cur.id;
      } else {
        const number = FISCAL.has(type) ? null : await nextNumber(c, req.company.id, counterKey(side, type), prefixFor(req.company, side, type), date);
        const { rows } = await c.query(
          `INSERT INTO documents (company_id, side, type, number, date, due_date, ${col}, notes, ext_ref, return_stock, total_ht, total_tva, timbre, total_ttc, created_by, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
          [req.company.id, side, type, number, date, b.due_date || null, partnerId, b.notes || null, b.ext_ref || null, !!b.return_stock,
            t.total_ht, t.total_tva, t.timbre, t.total_ttc, req.user.id, null]);
        id = rows[0].id;
      }
      await writeLines(c, req.company.id, id, t.lines);
      return { id };
    });
  }

  app.post('/api/documents', requireCompany, (req) => save(req, null));
  app.put('/api/documents/:id', requireCompany, async (req) => save(req, await loadDoc(db, req.company.id, req.params.id)));

  app.delete('/api/documents/:id', requireCompany, async (req) => {
    const doc = await loadDoc(db, req.company.id, req.params.id);
    if (doc.status !== 'brouillon') throw new HttpError(409, 'Seul un brouillon peut être supprimé.');
    await db.query('UPDATE documents SET status = $1 WHERE id = $2 AND status = $3', ['valide', doc.source_id || 0, 'transforme']);
    await db.query('DELETE FROM documents WHERE id = $1', [doc.id]);
    return { deleted: true };
  });

  app.post('/api/documents/:id/validate', requireCompany, async (req) => {
    return db.tx(async (c) => {
      const doc = await loadDoc(c, req.company.id, req.params.id, true);
      if (doc.status !== 'brouillon') throw new HttpError(409, 'Ce document est déjà validé.');
      const lines = await loadLines(c, doc.id);
      if (!lines.length) throw new HttpError(400, 'Ajoutez au moins une ligne avant de valider.');
      const col = partnerCol(doc.side);
      const partner = (await c.query(`SELECT * FROM ${partnerTable(doc.side)} WHERE id = $1`, [doc[col]])).rows[0];
      if (FISCAL.has(doc.type) && !doc.number) {
        doc.number = await nextNumber(c, req.company.id, counterKey(doc.side, doc.type), prefixFor(req.company, doc.side, doc.type), doc.date);
      }
      if (doc.type === 'facture' && !doc.due_date) {
        const d = new Date(doc.date + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + Number(partner.terms || 0));
        doc.due_date = d.toISOString().slice(0, 10);
      }
      // Effets sur le stock
      let stockDone = false;
      if (doc.side === 'sale') {
        if (doc.type === 'livraison') { await moveStock(c, req.company.id, doc, lines, -1, 'livraison'); stockDone = true; }
        if (doc.type === 'facture' && !(await stockAlreadyMoved(c, doc))) { await moveStock(c, req.company.id, doc, lines, -1, 'vente'); stockDone = true; }
        if (doc.type === 'avoir' && doc.return_stock) { await moveStock(c, req.company.id, doc, lines, 1, 'retour client'); stockDone = true; }
      } else {
        if (doc.type === 'reception') { await moveStock(c, req.company.id, doc, lines, 1, 'réception'); stockDone = true; }
        if (doc.type === 'facture' && !(await stockAlreadyMoved(c, doc))) { await moveStock(c, req.company.id, doc, lines, 1, 'achat'); stockDone = true; }
        if (doc.type === 'avoir' && doc.return_stock) { await moveStock(c, req.company.id, doc, lines, -1, 'retour fournisseur'); stockDone = true; }
      }
      // Comptabilisation
      if (FISCAL.has(doc.type)) await postInvoice(c, req.company, doc, lines, partner.name);
      // Imputation d'un avoir sur sa facture d'origine
      let paid = 0;
      if (doc.type === 'avoir' && doc.source_id) {
        const src = (await c.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [doc.source_id])).rows[0];
        if (src && src.type === 'facture' && src.status === 'valide') {
          const apply = round3(Math.min(Number(doc.total_ttc), Number(src.total_ttc) - Number(src.paid)));
          if (apply > 0) {
            await c.query('UPDATE documents SET paid = paid + $1 WHERE id = $2', [apply, src.id]);
            paid = apply;
          }
        }
      }
      await c.query(`UPDATE documents SET status = 'valide', number = $1, due_date = $2, stock_done = $3, paid = $4, validated_at = now() WHERE id = $5`,
        [doc.number, doc.due_date, stockDone, paid, doc.id]);
      return { ok: true, number: doc.number };
    });
  });

  app.post('/api/documents/:id/transform', requireCompany, async (req) => {
    return db.tx(async (c) => {
      const src = await loadDoc(c, req.company.id, req.params.id, true);
      const to = req.body.to;
      const allowed = TRANSFORMS[src.side][src.type] || [];
      if (!allowed.includes(to)) throw new HttpError(400, 'Transformation impossible pour ce document.');
      if (src.status !== 'valide') throw new HttpError(409, 'Validez le document avant de le transformer.');
      const col = partnerCol(src.side);
      const today = localToday();
      const number = FISCAL.has(to) ? null : await nextNumber(c, req.company.id, counterKey(src.side, to), prefixFor(req.company, src.side, to), today);
      let timbre = 0;
      if (to === 'facture') timbre = src.side === 'sale' ? Number(req.company.timbre) : Number(req.company.timbre);
      const lines = await loadLines(c, src.id);
      const t = computeTotals(lines, timbre);
      const { rows } = await c.query(
        `INSERT INTO documents (company_id, side, type, number, date, ${col}, notes, ext_ref, total_ht, total_tva, timbre, total_ttc, created_by, source_id, return_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [req.company.id, src.side, to, number, today, src[col], src.notes, to === 'avoir' ? null : src.ext_ref,
          t.total_ht, t.total_tva, t.timbre, t.total_ttc, req.user.id, src.id, false]);
      await writeLines(c, req.company.id, rows[0].id, t.lines);
      if (to !== 'avoir') await c.query(`UPDATE documents SET status = 'transforme' WHERE id = $1`, [src.id]);
      return { id: rows[0].id };
    });
  });

  app.post('/api/documents/:id/duplicate', requireCompany, async (req) => {
    return db.tx(async (c) => {
      const src = await loadDoc(c, req.company.id, req.params.id);
      const col = partnerCol(src.side);
      const today = localToday();
      const number = FISCAL.has(src.type) ? null : await nextNumber(c, req.company.id, counterKey(src.side, src.type), prefixFor(req.company, src.side, src.type), today);
      const timbre = src.type === 'facture' ? Number(req.company.timbre) : 0;
      const t = computeTotals(await loadLines(c, src.id), timbre);
      const { rows } = await c.query(
        `INSERT INTO documents (company_id, side, type, number, date, ${col}, notes, total_ht, total_tva, timbre, total_ttc, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [req.company.id, src.side, src.type, number, today, src[col], src.notes, t.total_ht, t.total_tva, t.timbre, t.total_ttc, req.user.id]);
      await writeLines(c, req.company.id, rows[0].id, t.lines);
      return { id: rows[0].id };
    });
  });

  app.post('/api/documents/:id/cancel', requireCompany, async (req) => {
    return db.tx(async (c) => {
      const doc = await loadDoc(c, req.company.id, req.params.id, true);
      if (FISCAL.has(doc.type) && doc.status !== 'brouillon') throw new HttpError(409, 'Une facture ou un avoir validé ne peut pas être annulé : établissez un avoir.');
      if (doc.status === 'transforme') throw new HttpError(409, 'Ce document a été transformé : annulez d\'abord le document suivant.');
      if (doc.status === 'annule') return { ok: true };
      if (doc.stock_done) {
        const lines = await loadLines(c, doc.id);
        const dir = (doc.side === 'sale' && doc.type === 'livraison') ? 1 : -1;
        await moveStock(c, req.company.id, doc, lines, dir, 'annulation');
      }
      await c.query(`UPDATE documents SET status = 'annule', stock_done = false WHERE id = $1`, [doc.id]);
      // Le document d'origine redevient transformable
      if (doc.source_id) await c.query(`UPDATE documents SET status = 'valide' WHERE id = $1 AND status = 'transforme'`, [doc.source_id]);
      return { ok: true };
    });
  });
}

module.exports = { register, LABELS, TYPES };
