'use strict';
const { HttpError } = require('../lib/http');
const { round3, nextNumber, localToday, DEFAULT_ACCOUNTS_MAP } = require('./db');

const accountsMap = (company) => ({ ...DEFAULT_ACCOUNTS_MAP, ...(company.accounts_map || {}) });

async function postEntry(c, companyId, e) {
  const lines = e.lines
    .map((l) => ({ ...l, debit: round3(l.debit || 0), credit: round3(l.credit || 0) }))
    .filter((l) => l.debit || l.credit);
  if (!lines.length) return null;
  const debit = round3(lines.reduce((s, l) => s + l.debit, 0));
  const credit = round3(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(debit - credit) > 0.0005) throw new HttpError(400, `Écriture déséquilibrée (débit ${debit.toFixed(3)} ≠ crédit ${credit.toFixed(3)}).`);
  const number = await nextNumber(c, companyId, 'J-' + e.journal, e.journal, e.date);
  const { rows } = await c.query(
    `INSERT INTO entries (company_id, journal, number, date, label, ref, source, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [companyId, e.journal, number, e.date, e.label, e.ref || null, e.source || 'manuel', e.source_id || null]);
  for (const l of lines) {
    await c.query(
      `INSERT INTO entry_lines (entry_id, company_id, account, partner_kind, partner_id, label, debit, credit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rows[0].id, companyId, String(l.account), l.partner_kind || null, l.partner_id || null, l.label || e.label, l.debit, l.credit]);
  }
  return rows[0].id;
}

// Facture / avoir (ventes ou achats) → journal VT ou AC
async function postInvoice(c, company, doc, lines, partnerName) {
  const map = accountsMap(company);
  const isSale = doc.side === 'sale';
  const isAvoir = doc.type === 'avoir';
  const byAccount = {};
  for (const l of lines) {
    const kind = l.product_kind || 'service';
    const acc = isSale
      ? (kind === 'stock' ? map.vente_marchandises : map.vente_services)
      : (kind === 'stock' ? map.achat_marchandises : map.achat_services);
    byAccount[acc] = round3((byAccount[acc] || 0) + Number(l.total_ht));
  }
  const label = `${isAvoir ? 'Avoir' : 'Facture'} ${doc.number} – ${partnerName}`;
  const entryLines = [];
  const D = (account, amount, extra = {}) => entryLines.push({ account, debit: Number(amount), credit: 0, ...extra });
  const C = (account, amount, extra = {}) => entryLines.push({ account, debit: 0, credit: Number(amount), ...extra });
  if (isSale) {
    D(map.client, doc.total_ttc, { partner_kind: 'C', partner_id: doc.customer_id });
    for (const [acc, amt] of Object.entries(byAccount)) C(acc, amt);
    C(map.tva_collectee, doc.total_tva);
    C(map.timbre_vente, doc.timbre);
  } else {
    for (const [acc, amt] of Object.entries(byAccount)) D(acc, amt);
    D(map.tva_deductible, doc.total_tva);
    D(map.timbre_achat, doc.timbre);
    C(map.fournisseur, doc.total_ttc, { partner_kind: 'F', partner_id: doc.supplier_id });
  }
  // Un avoir est l'écriture inverse d'une facture
  if (isAvoir) entryLines.forEach((l) => { const d = l.debit; l.debit = l.credit; l.credit = d; });
  return postEntry(c, company.id, {
    journal: isSale ? 'VT' : 'AC', date: doc.date, label, ref: doc.number,
    source: 'document', source_id: doc.id, lines: entryLines,
  });
}

// Règlement client / fournisseur → journal BQ ou CA
async function postPayment(c, company, p, partnerName, reverse = false) {
  const map = accountsMap(company);
  const treasury = p.method === 'especes' ? map.caisse : map.banque;
  const journal = p.method === 'especes' ? 'CA' : 'BQ';
  const amount = Number(p.amount);
  const wh = Number(p.withholding || 0);
  const total = round3(amount + wh);
  const lines = [];
  if (p.side === 'in') {
    lines.push({ account: treasury, debit: amount, credit: 0 });
    if (wh) lines.push({ account: map.retenue, debit: wh, credit: 0, label: 'Retenue à la source' });
    lines.push({ account: map.client, debit: 0, credit: total, partner_kind: 'C', partner_id: p.customer_id });
  } else {
    lines.push({ account: map.fournisseur, debit: total, credit: 0, partner_kind: 'F', partner_id: p.supplier_id });
    lines.push({ account: treasury, debit: 0, credit: amount });
    if (wh) lines.push({ account: map.retenue_a_payer, debit: 0, credit: wh, label: 'Retenue à la source opérée' });
  }
  if (reverse) lines.forEach((l) => { const d = l.debit; l.debit = l.credit; l.credit = d; });
  const verb = p.side === 'in' ? 'Règlement' : 'Paiement';
  return postEntry(c, company.id, {
    journal, date: reverse ? localToday() : p.date,
    label: `${reverse ? (p.status === 'impaye' ? 'Impayé – ' : 'Annulation – ') : ''}${verb} ${p.number || ''} – ${partnerName}`,
    ref: p.reference || p.number, source: 'payment', source_id: p.id, lines,
  });
}

module.exports = { postEntry, postInvoice, postPayment, accountsMap };
