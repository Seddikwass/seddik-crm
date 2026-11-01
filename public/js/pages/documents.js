// Documents de vente et d'achat : listes, saisie, consultation, impression
import {
  html, raw, esc, route, get, post, put, del, go, setTop, money, moneyText, date, today, n, fmt3, fmt2, qs, toast, fail,
  modal, confirmBox, combo, table, bindRowLinks, downloadCsv, csvNum, amountInWords, icon, canEdit, ref, clearRef, $, $$, on, state,
} from '../core.js';
import { openPaymentModal, openReminderModal, waLink } from './recovery.js';
import { quickPartner } from './partners.js';

export const LABELS = {
  sale: { devis: ['Devis', 'Devis'], commande: ['Commande client', 'Commandes clients'], livraison: ['Bon de livraison', 'Bons de livraison'], facture: ['Facture', 'Factures'], avoir: ['Avoir', 'Avoirs'] },
  purchase: { commande: ['Commande fournisseur', 'Commandes fournisseurs'], reception: ['Bon de réception', 'Bons de réception'], facture: ['Facture fournisseur', 'Factures fournisseurs'], avoir: ['Avoir fournisseur', 'Avoirs fournisseurs'] },
};
const TRANSFORM_LABEL = {
  sale: { commande: 'Transformer en commande', livraison: 'Créer le bon de livraison', facture: 'Facturer', avoir: 'Établir un avoir' },
  purchase: { reception: 'Réceptionner', facture: 'Saisir la facture', avoir: 'Établir un avoir' },
};
const VAT_RATES = [19, 13, 7, 0];
const round3 = (v) => Math.round(v * 1000) / 1000;
export const docLabel = (side, type) => (LABELS[side] && LABELS[side][type] ? LABELS[side][type][0] : type);
const sideOfPath = { ventes: 'sale', achats: 'purchase' };
const pathOfSide = { sale: 'ventes', purchase: 'achats' };

export function statusChip(d) {
  if (d.status === 'brouillon') return html`<span class="chip draft">Brouillon</span>`;
  if (d.status === 'annule') return html`<span class="chip off">Annulé</span>`;
  if (d.status === 'transforme') return html`<span class="chip ok">Transformé</span>`;
  if (d.type === 'facture') {
    const open = n(d.total_ttc) - n(d.paid);
    if (open <= 0.0005) return html`<span class="chip paid">Payée</span>`;
    if (d.due_date && d.due_date < today()) return html`<span class="chip bad">Échue</span>`;
    if (n(d.paid) > 0) return html`<span class="chip late">Partiellement payée</span>`;
    return html`<span class="chip ok">À payer</span>`;
  }
  if (d.type === 'avoir') return n(d.total_ttc) - n(d.paid) > 0.0005 ? html`<span class="chip ok">À imputer</span>` : html`<span class="chip paid">Imputé</span>`;
  return html`<span class="chip ok">Validé</span>`;
}

// ---------- Listes ----------
async function docList(view, side, type, q) {
  if (!LABELS[side] || !LABELS[side][type]) throw new Error('Page introuvable.');
  const [singular, plural] = LABELS[side][type];
  const partnerWord = side === 'sale' ? 'Client' : 'Fournisseur';
  const isInvoice = type === 'facture' || type === 'avoir';
  setTop(plural, canEdit() ? html`<a class="btn primary" href="#/nouveau/${side}/${type}">${icon('plus', 16)} ${type === 'avoir' || type === 'facture' ? 'Nouvelle' : 'Nouveau'} ${singular.toLowerCase()}</a>` : '');
  const filters = { q: q.q || '', status: q.statut || '', open: q.filtre === 'ouvertes' || q.filtre === 'echues' ? 1 : '', overdue: q.filtre === 'echues' ? 1 : '', from: q.du || '', to: q.au || '' };
  view.innerHTML = String(html`
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="f-q" placeholder="Numéro, ${partnerWord.toLowerCase()}, référence…" value="${filters.q}"></div>
      <select id="f-status">
        <option value="">Tous les statuts</option>
        ${[['brouillon', 'Brouillons'], ['valide', 'Validés'], ['transforme', 'Transformés'], ['annule', 'Annulés']].map(([v, l]) => html`<option value="${v}" ${filters.status === v ? raw('selected') : ''}>${l}</option>`)}
      </select>
      ${type === 'facture' ? html`<div class="seg" id="f-open">
        <button data-v="" class="${!q.filtre ? 'on' : ''}">Toutes</button><button data-v="ouvertes" class="${q.filtre === 'ouvertes' ? 'on' : ''}">Non soldées</button><button data-v="echues" class="${q.filtre === 'echues' ? 'on' : ''}">Échues</button></div>` : ''}
      <input type="date" id="f-from" value="${filters.from}" aria-label="Du"><input type="date" id="f-to" value="${filters.to}" aria-label="Au">
      <button class="btn" id="export">${icon('download', 16)} Exporter</button>
    </div>
    <div class="panel" id="list"><div class="loading">Chargement…</div></div>`);
  let rows = [];
  const load = async () => {
    rows = await get('/api/documents' + qs({ side, type, ...filters }));
    const cols = [
      { label: 'Numéro', render: (r) => html`<span class="strong">${r.number || 'Brouillon'}</span>${r.ext_ref ? html`<div class="muted small">${r.ext_ref}</div>` : ''}` },
      { label: 'Date', render: (r) => date(r.date) },
      { label: partnerWord, render: (r) => r.partner_name },
    ];
    if (type === 'facture') cols.push({ label: 'Échéance', render: (r) => html`${date(r.due_date)}${r.status === 'valide' && n(r.open_amount) > 0 && n(r.days_late) > 0 ? html`<div class="small" style="color:var(--grenade)">${r.days_late} j de retard</div>` : ''}` });
    cols.push({ label: 'Statut', render: (r) => statusChip(r) });
    cols.push({ label: isInvoice ? 'Total TTC' : 'Total HT', align: 'r', render: (r) => money(isInvoice ? r.total_ttc : r.total_ht) });
    if (isInvoice) cols.push({ label: type === 'avoir' ? 'Reste à imputer' : 'Reste à payer', align: 'r', render: (r) => (n(r.open_amount) > 0.0005 ? money(r.open_amount) : html`<span class="muted">—</span>`) });
    const valid = rows.filter((r) => r.status !== 'annule' && r.status !== 'brouillon');
    const sum = (k) => valid.reduce((s, r) => s + n(r[k]), 0);
    const foot = cols.map(() => '');
    foot[0] = `${rows.length} document${rows.length > 1 ? 's' : ''}`;
    foot[cols.length - (isInvoice ? 2 : 1)] = money(isInvoice ? sum('total_ttc') : sum('total_ht'));
    if (isInvoice) foot[cols.length - 1] = money(sum('open_amount'));
    $('#list', view).innerHTML = String(table({
      columns: cols, rows, href: (r) => '/document/' + r.id, foot: rows.length ? foot : null,
      empty: html`<p>Aucun document ne correspond.</p>${canEdit() ? html`<a class="btn primary" href="#/nouveau/${side}/${type}">Créer un document</a>` : ''}`,
    }));
  };
  let timer;
  $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { filters.q = e.target.value; load().catch(fail); }, 250); };
  $('#f-status', view).onchange = (e) => { filters.status = e.target.value; load().catch(fail); };
  $('#f-from', view).onchange = (e) => { filters.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { filters.to = e.target.value; load().catch(fail); };
  const seg = $('#f-open', view);
  if (seg) on(seg, 'click', 'button', (e, b) => {
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    filters.open = b.dataset.v ? 1 : ''; filters.overdue = b.dataset.v === 'echues' ? 1 : '';
    load().catch(fail);
  });
  $('#export', view).onclick = () => downloadCsv(`${plural}.csv`,
    ['Numéro', 'Date', partnerWord, 'Échéance', 'Statut', 'Total HT', 'TVA', 'Timbre', 'Total TTC', 'Réglé', 'Reste'],
    rows.map((r) => [r.number || 'Brouillon', date(r.date), r.partner_name, date(r.due_date), r.status, csvNum(r.total_ht), csvNum(r.total_tva), csvNum(r.timbre), csvNum(r.total_ttc), csvNum(r.paid), csvNum(r.open_amount)]));
  bindRowLinks(view);
  await load();
}

route('/ventes/:type', (view, p, q) => docList(view, 'sale', p.type, q));
route('/achats/:type', (view, p, q) => docList(view, 'purchase', p.type, q));

// ---------- Saisie ----------
function totals(lines, timbre) {
  let ht = 0; const byRate = {};
  for (const l of lines) {
    const t = round3(n(l.qty) * n(l.unit_price) * (1 - Math.min(100, n(l.discount)) / 100));
    l.total_ht = t; ht += t;
    const r = n(l.vat_rate);
    byRate[r] = (byRate[r] || 0) + t;
  }
  let tva = 0;
  const rates = Object.keys(byRate).map(Number).sort((a, b) => b - a).map((r) => { const v = byRate[r] * r / 100; tva += v; return { rate: r, base: round3(byRate[r]), tva: round3(v) }; });
  ht = round3(ht); tva = round3(tva);
  return { ht, tva, rates, timbre: round3(n(timbre)), ttc: round3(ht + tva + n(timbre)) };
}

async function editor(view, doc) {
  const side = doc.side; const type = doc.type;
  const [singular] = LABELS[side][type];
  const partners = await ref(side === 'sale' ? 'customers' : 'suppliers');
  const products = (await ref('products')).filter((p) => p.active);
  const company = state.me.company;
  const isNew = !doc.id;
  const isFacture = type === 'facture';
  setTop(isNew ? `${type === 'facture' || type === 'avoir' ? 'Nouvelle' : 'Nouveau'} ${singular.toLowerCase()}` : `${singular} ${doc.number || '(brouillon)'}`);
  if (!doc.lines || !doc.lines.length) doc.lines = [{ product_id: null, description: '', qty: 1, unit_price: 0, discount: 0, vat_rate: 19 }];
  if (isFacture && (doc.timbre === undefined || doc.timbre === null)) doc.timbre = company.timbre;
  const partner = partners.find((p) => p.id === doc.partner_id);
  const partnerWord = side === 'sale' ? 'Client' : 'Fournisseur';

  view.innerHTML = String(html`<form id="doc-form" class="stack" autocomplete="off">
    <div class="panel"><div class="panel-body">
      <div class="doc-head">
        <label class="field">${partnerWord}
          <div class="row" style="flex-wrap:nowrap"><div style="flex:1;min-width:0"><input id="partner" placeholder="Rechercher un ${partnerWord.toLowerCase()}…" value="${partner ? partner.name : ''}"></div>
          <button type="button" class="btn" id="new-partner" title="Nouveau ${partnerWord.toLowerCase()}">${icon('plus', 16)}</button></div></label>
        <label class="field">Date<input type="date" name="date" value="${doc.date || today()}" required></label>
        ${isFacture ? html`<label class="field">Échéance <span class="hint">vide = selon le délai du tiers</span><input type="date" name="due_date" value="${doc.due_date || ''}"></label>` : html`<div></div>`}
        ${side === 'purchase' ? html`<label class="field">N° pièce fournisseur<input name="ext_ref" value="${doc.ext_ref || ''}"></label>` : html`<label class="field">Référence client <span class="hint">bon de commande…</span><input name="ext_ref" value="${doc.ext_ref || ''}"></label>`}
      </div>
      <div id="partner-info" class="small muted" style="margin-top:8px"></div>
    </div></div>
    <div class="panel"><div class="panel-head"><h2>Lignes</h2><span class="muted small">Prix unitaires hors taxes</span></div>
      <div class="panel-body flush table-wrap"><table class="data lines-table"><thead><tr>
        <th>Article ou désignation</th><th class="r">Qté</th><th class="r">P.U. HT</th><th class="r">Remise %</th><th class="r">TVA</th><th class="r">Total HT</th><th></th></tr></thead>
        <tbody id="lines"></tbody></table></div>
      <div class="panel-body" style="border-top:1px solid var(--line)"><button type="button" class="btn" id="add-line">${icon('plus', 16)} Ajouter une ligne</button></div>
    </div>
    <div class="grid c2">
      <div class="panel"><div class="panel-body grid">
        <label class="field">Notes <span class="hint">imprimées sur le document</span><textarea name="notes" rows="3">${doc.notes || ''}</textarea></label>
        ${isFacture ? html`<label class="field">Timbre fiscal (DT)<input name="timbre" class="num" inputmode="decimal" value="${fmt3(doc.timbre)}"></label>` : ''}
        ${type === 'avoir' ? html`<label class="check"><input type="checkbox" name="return_stock" ${doc.return_stock ? raw('checked') : ''}> Retour de marchandise (remettre les articles en stock)</label>` : ''}
      </div></div>
      <div class="panel"><div class="panel-body"><div class="totals" id="totals"></div></div></div>
    </div>
    <div class="row between">
      <div>${!isNew ? html`<button type="button" class="btn danger" id="delete">${icon('trash', 16)} Supprimer le brouillon</button>` : ''}</div>
      <div class="row"><a class="btn" href="${isNew ? `#/${pathOfSide[side]}/${type}` : `#/document/${doc.id}`}">Annuler</a>
        <button type="submit" class="btn" data-mode="draft">Enregistrer le brouillon</button>
        <button type="submit" class="btn primary" data-mode="validate">Enregistrer et valider</button></div>
    </div>
  </form>`);

  const form = $('#doc-form', view);
  const showPartner = (p) => {
    $('#partner-info', view).textContent = p ? [p.code, p.city, p.phone, p.tax_id ? 'MF ' + p.tax_id : '', `délai ${p.terms} j`, side === 'sale' && n(p.balance) ? `encours ${moneyText(p.balance)}` : ''].filter(Boolean).join(', ') : '';
  };
  showPartner(partner);
  combo($('#partner', view), {
    items: () => partners.filter((p) => p.active), getLabel: (p) => p.name, getSub: (p) => [p.code, p.city].filter(Boolean).join(', '),
    onPick: (p) => { doc.partner_id = p.id; showPartner(p); },
  });
  $('#new-partner', view).onclick = () => quickPartner(side, (p) => { partners.push(p); doc.partner_id = p.id; $('#partner', view).value = p.name; showPartner(p); });

  const renderTotals = () => {
    const t = totals(doc.lines, isFacture ? doc.timbre : 0);
    $$('#lines tr', view).forEach((tr, i) => { const c = tr.querySelector('.c-total'); if (c) c.innerHTML = String(money(doc.lines[i].total_ht, { cur: false })); });
    $('#totals', view).innerHTML = String(html`
      <div class="t-row"><span>Total HT</span>${money(t.ht)}</div>
      ${t.rates.filter((r) => r.rate > 0).map((r) => html`<div class="t-row"><span>TVA ${fmt2(r.rate)} % sur ${money(r.base, { cur: false })}</span>${money(r.tva)}</div>`)}
      ${isFacture ? html`<div class="t-row"><span>Timbre fiscal</span>${money(t.timbre)}</div>` : ''}
      <div class="t-row grand"><span class="label">Total TTC</span>${money(t.ttc, { cls: 'amt-xl' })}</div>`);
  };
  const renderLines = () => {
    $('#lines', view).innerHTML = String(html`${doc.lines.map((l, i) => {
      const p = l.product_id ? products.find((x) => x.id === l.product_id) : null;
      return html`<tr data-i="${i}">
        <td class="c-prod" data-label="Article"><input class="l-prod" placeholder="Rechercher un article ou saisir un texte" value="${l.description || (p ? p.name : '')}">
          ${p ? html`<div class="small muted" style="margin-top:3px">${p.code}${p.kind === 'stock' ? html`, stock ${fmt3(p.stock).replace(/,000$/, '')} ${p.unit}` : ', service'}</div>` : ''}</td>
        <td class="c-qty" data-label="Quantité"><input class="num l-qty" inputmode="decimal" value="${String(l.qty).replace('.', ',')}"></td>
        <td class="c-price" data-label="P.U. HT"><input class="num l-price" inputmode="decimal" value="${fmt3(l.unit_price)}"></td>
        <td class="c-disc" data-label="Remise %"><input class="num l-disc" inputmode="decimal" value="${l.discount ? String(l.discount).replace('.', ',') : ''}"></td>
        <td class="c-vat" data-label="TVA"><select class="l-vat">${VAT_RATES.map((r) => html`<option value="${r}" ${n(l.vat_rate) === r ? raw('selected') : ''}>${r} %</option>`)}</select></td>
        <td class="c-total r" data-label="Total HT"></td>
        <td class="c-del" data-label=""><button type="button" class="btn ghost small l-del" aria-label="Supprimer la ligne">${icon('trash', 16)}</button></td></tr>`;
    })}`);
    $$('#lines tr', view).forEach((tr) => {
      const i = +tr.dataset.i;
      combo(tr.querySelector('.l-prod'), {
        items: products, minChars: 1, getLabel: (p) => p.name,
        getSub: (p) => `${p.code}, ${moneyText(side === 'sale' ? p.sale_price : p.purchase_price)}`,
        onPick: (p) => {
          Object.assign(doc.lines[i], { product_id: p.id, description: p.name, unit_price: n(side === 'sale' ? p.sale_price : p.purchase_price), vat_rate: n(p.vat_rate) });
          renderLines();
          const next = $$('#lines tr', view)[i]; if (next) next.querySelector('.l-qty').focus();
        },
      });
    });
    renderTotals();
  };
  const parse = (v) => n(String(v).replace(/\s/g, '').replace(',', '.'));
  on($('#lines', view), 'input', 'input,select', (e, el) => {
    const i = +el.closest('tr').dataset.i; const l = doc.lines[i];
    if (el.classList.contains('l-prod')) { l.description = el.value; if (l.product_id) { const p = products.find((x) => x.id === l.product_id); if (p && el.value !== p.name && !el.value) l.product_id = null; } }
    if (el.classList.contains('l-qty')) l.qty = parse(el.value);
    if (el.classList.contains('l-price')) l.unit_price = parse(el.value);
    if (el.classList.contains('l-disc')) l.discount = parse(el.value);
    if (el.classList.contains('l-vat')) l.vat_rate = parse(el.value);
    renderTotals();
  });
  on($('#lines', view), 'change', 'select', (e, el) => { doc.lines[+el.closest('tr').dataset.i].vat_rate = n(el.value); renderTotals(); });
  on($('#lines', view), 'click', '.l-del', (e, b) => { doc.lines.splice(+b.closest('tr').dataset.i, 1); if (!doc.lines.length) doc.lines.push({ qty: 1, unit_price: 0, discount: 0, vat_rate: 19 }); renderLines(); });
  $('#add-line', view).onclick = () => { doc.lines.push({ product_id: null, description: '', qty: 1, unit_price: 0, discount: 0, vat_rate: 19 }); renderLines(); $$('#lines .l-prod', view).pop().focus(); };
  const timbreEl = form.querySelector('[name=timbre]');
  if (timbreEl) timbreEl.oninput = () => { doc.timbre = parse(timbreEl.value); renderTotals(); };
  renderLines();

  if (!isNew) $('#delete', view).onclick = async () => {
    if (!(await confirmBox('Supprimer ce brouillon ?', { ok: 'Supprimer', danger: true }))) return;
    try { await del('/api/documents/' + doc.id); toast('Brouillon supprimé'); go(`/${pathOfSide[side]}/${type}`); } catch (e) { fail(e); }
  };

  let mode = 'draft';
  $$('button[type=submit]', form).forEach((b) => { b.onclick = () => { mode = b.dataset.mode; }; });
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!doc.partner_id) return fail(new Error(`Choisissez un ${partnerWord.toLowerCase()}.`));
    const lines = doc.lines.filter((l) => l.product_id || (l.description && l.description.trim()));
    if (!lines.length) return fail(new Error('Ajoutez au moins une ligne.'));
    const f = Object.fromEntries(new FormData(form));
    const body = {
      side, type, partner_id: doc.partner_id, date: f.date, due_date: f.due_date || null, ext_ref: f.ext_ref || null, notes: f.notes || null,
      timbre: isFacture ? parse(f.timbre) : 0, return_stock: !!form.querySelector('[name=return_stock]:checked'),
      lines: lines.map((l) => ({ product_id: l.product_id || null, description: l.description, qty: l.qty, unit_price: l.unit_price, discount: l.discount || 0, vat_rate: l.vat_rate })),
    };
    $$('button', form).forEach((b) => { b.disabled = true; });
    try {
      const id = doc.id || (await post('/api/documents', body)).id;
      if (doc.id) await put('/api/documents/' + doc.id, body);
      doc.id = id;
      if (mode === 'validate') {
        const r = await post(`/api/documents/${id}/validate`);
        toast(`Document validé${r.number ? ' : ' + r.number : ''}`, 'success');
      } else toast('Brouillon enregistré');
      clearRef('products'); clearRef('customers'); clearRef('suppliers');
      go('/document/' + id);
    } catch (err) { fail(err); $$('button', form).forEach((b) => { b.disabled = false; }); }
  };
}

route('/nouveau/:side/:type', async (view, p, q) => {
  if (!LABELS[p.side] || !LABELS[p.side][p.type]) throw new Error('Type de document inconnu.');
  if (!canEdit()) throw new Error('Votre accès ne permet pas de créer de document.');
  await editor(view, { side: p.side, type: p.type, partner_id: q.tiers ? Number(q.tiers) : null, date: today(), lines: [] });
});

// ---------- Consultation ----------
route('/document/:id', async (view, p) => {
  const d = await get('/api/documents/' + p.id);
  if (d.status === 'brouillon' && canEdit()) {
    d.lines = d.lines.map((l) => ({ ...l, qty: n(l.qty), unit_price: n(l.unit_price), discount: n(l.discount), vat_rate: n(l.vat_rate) }));
    return editor(view, d);
  }
  const side = d.side;
  const partnerWord = side === 'sale' ? 'Client' : 'Fournisseur';
  const open = round3(n(d.total_ttc) - n(d.paid));
  const t = totals(d.lines.map((l) => ({ ...l })), d.timbre);
  const can = canEdit();
  const actions = [];
  actions.push(html`<a class="btn" href="#/imprimer/${d.id}" target="_blank" rel="noopener">${icon('print', 16)} Imprimer / PDF</a>`);
  if (can) {
    for (const to of d.transforms) actions.push(html`<button class="btn ${to === 'avoir' ? '' : 'primary'}" data-transform="${to}">${TRANSFORM_LABEL[side][to]}</button>`);
    if (d.type === 'facture' && d.status === 'valide' && open > 0.0005) actions.push(html`<button class="btn success" id="pay">${side === 'sale' ? 'Encaisser' : 'Payer'}</button>`);
    if (!['facture', 'avoir'].includes(d.type) && d.status === 'valide') actions.push(html`<button class="btn danger" id="cancel">Annuler</button>`);
    actions.push(html`<button class="btn" id="duplicate">Dupliquer</button>`);
  }
  setTop(`${d.label} ${d.number || ''}`, actions);

  const share = side === 'sale' && d.partner;
  const msg = `Bonjour,\n\nVeuillez trouver ci-joint notre ${d.label.toLowerCase()} n° ${d.number} du ${date(d.date)} d'un montant de ${moneyText(d.total_ttc)}${d.due_date ? `, à régler avant le ${date(d.due_date)}` : ''}.\n\nCordialement,\n${state.me.company.name}`;
  view.innerHTML = String(html`<div class="stack">
    <div class="panel"><div class="panel-body">
      <div class="row between" style="align-items:flex-start">
        <div>
          <div class="row">${statusChip(d)}${d.stock_done ? html`<span class="chip ok">Stock mis à jour</span>` : ''}</div>
          <h2 style="margin-top:10px"><a href="#/${side === 'sale' ? 'clients' : 'fournisseurs'}/${d.partner_id}">${d.partner ? d.partner.name : ''}</a></h2>
          <div class="muted small">${d.partner ? [d.partner.code, d.partner.address, d.partner.city, d.partner.tax_id ? 'MF ' + d.partner.tax_id : ''].filter(Boolean).join(', ') : ''}</div>
        </div>
        <dl class="dl">
          <dt>Date</dt><dd>${date(d.date)}</dd>
          ${d.due_date ? html`<dt>Échéance</dt><dd>${date(d.due_date)}</dd>` : ''}
          ${d.ext_ref ? html`<dt>${side === 'purchase' ? 'Pièce fournisseur' : 'Réf. client'}</dt><dd>${d.ext_ref}</dd>` : ''}
          ${d.type === 'facture' ? html`<dt>Reste à payer</dt><dd>${money(open)}</dd>` : ''}
        </dl>
      </div>
      ${d.source || d.children.length ? html`<div class="flow" style="margin-top:14px">
        ${d.source ? html`<a class="step" href="#/document/${d.source.id}">${docLabel(side, d.source.type)} ${d.source.number || ''}</a><span class="sep">›</span>` : ''}
        <span class="step cur">${d.label} ${d.number || ''}</span>
        ${d.children.map((c) => html`<span class="sep">›</span><a class="step" href="#/document/${c.id}">${docLabel(side, c.type)} ${c.number || '(brouillon)'}${c.status === 'annule' ? ' (annulé)' : ''}</a>`)}
      </div>` : ''}
    </div></div>
    <div class="panel"><div class="panel-body flush">${table({
      columns: [
        { label: 'Désignation', render: (l) => html`<span class="strong">${l.description}</span>${l.product_code ? html`<div class="muted small">${l.product_code}</div>` : ''}` },
        { label: 'Qté', align: 'r', render: (l) => `${fmt3(l.qty).replace(/,000$/, '')} ${l.unit || ''}` },
        { label: 'P.U. HT', align: 'r', render: (l) => money(l.unit_price, { cur: false }) },
        { label: 'Remise', align: 'r', render: (l) => (n(l.discount) ? fmt2(l.discount) + ' %' : '') },
        { label: 'TVA', align: 'r', render: (l) => fmt2(l.vat_rate) + ' %' },
        { label: 'Total HT', align: 'r', render: (l) => money(l.total_ht, { cur: false }) },
      ], rows: d.lines,
    })}</div></div>
    <div class="grid c2">
      <div class="stack">
        ${d.notes ? html`<div class="panel"><div class="panel-body"><h3>Notes</h3><p style="white-space:pre-line;margin:6px 0 0">${d.notes}</p></div></div>` : ''}
        ${d.type === 'facture' || d.payments.length ? html`<div class="panel"><div class="panel-head"><h2>${side === 'sale' ? 'Encaissements' : 'Paiements'}</h2></div><div class="panel-body">
          ${d.payments.length ? html`<ul class="list">${d.payments.map((pm) => html`<li><span>${date(pm.date)}, ${pm.number}${pm.reference ? ` (n° ${pm.reference})` : ''}</span>${money(pm.amount)}</li>`)}</ul>`
            : html`<p class="muted" style="margin:0">Aucun règlement enregistré.</p>`}
          ${d.type === 'facture' && n(d.paid) > 0 && !d.payments.length ? html`<p class="small muted">Montant imputé par avoir : ${money(d.paid)}</p>` : ''}
        </div></div>` : ''}
        ${share ? html`<div class="panel"><div class="panel-head"><h2>Envoyer au client</h2></div><div class="panel-body row">
          <a class="btn" href="#/imprimer/${d.id}" target="_blank" rel="noopener">${icon('download', 16)} Télécharger le PDF</a>
          ${waLink(d.partner.whatsapp || d.partner.phone, msg) ? html`<a class="btn" target="_blank" rel="noopener" href="${waLink(d.partner.whatsapp || d.partner.phone, msg)}">${icon('chat', 16)} WhatsApp</a>` : ''}
          ${d.partner.email ? html`<a class="btn" href="mailto:${d.partner.email}?subject=${encodeURIComponent(`${d.label} ${d.number} – ${state.me.company.name}`)}&body=${encodeURIComponent(msg)}">${icon('mail', 16)} E-mail</a>` : ''}
          ${d.type === 'facture' && open > 0.0005 && can ? html`<button class="btn" id="remind">Relancer</button>` : ''}
          <p class="small muted" style="margin:6px 0 0;flex-basis:100%">Enregistrez d'abord le PDF depuis la page d'impression, puis joignez-le au message.</p>
        </div></div>` : ''}
      </div>
      <div class="panel"><div class="panel-body"><div class="totals">
        <div class="t-row"><span>Total HT</span>${money(d.total_ht)}</div>
        ${t.rates.filter((r) => r.rate > 0).map((r) => html`<div class="t-row"><span>TVA ${fmt2(r.rate)} % sur ${money(r.base, { cur: false })}</span>${money(r.tva)}</div>`)}
        ${n(d.timbre) ? html`<div class="t-row"><span>Timbre fiscal</span>${money(d.timbre)}</div>` : ''}
        <div class="t-row grand"><span class="label">Total TTC</span>${money(d.total_ttc, { cls: 'amt-xl' })}</div>
        ${['facture', 'avoir', 'devis'].includes(d.type) ? html`<p class="small muted" style="margin-top:10px">${amountInWords(d.total_ttc)}</p>` : ''}
      </div></div></div>
    </div>
  </div>`);

  document.querySelectorAll('#top-actions [data-transform]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { const r = await post(`/api/documents/${d.id}/transform`, { to: b.dataset.transform }); toast('Document créé en brouillon : vérifiez-le puis validez.'); go('/document/' + r.id); } catch (err) { fail(err); b.disabled = false; }
    };
  });
  const top = document.getElementById('top-actions');
  const payBtn = top.querySelector('#pay');
  if (payBtn) payBtn.onclick = () => openPaymentModal({ side: side === 'sale' ? 'in' : 'out', partner_id: d.partner_id, partner_name: d.partner.name, document: d, onDone: () => go('/document/' + d.id) });
  const cancelBtn = top.querySelector('#cancel');
  if (cancelBtn) cancelBtn.onclick = async () => {
    if (!(await confirmBox(`Annuler ce document ?${d.stock_done ? ' Les mouvements de stock seront inversés.' : ''}`, { ok: 'Annuler le document', danger: true }))) return;
    try { await post(`/api/documents/${d.id}/cancel`); toast('Document annulé'); go('/document/' + d.id); } catch (err) { fail(err); }
  };
  const dupBtn = top.querySelector('#duplicate');
  if (dupBtn) dupBtn.onclick = async () => { try { const r = await post(`/api/documents/${d.id}/duplicate`); toast('Copie créée en brouillon'); go('/document/' + r.id); } catch (err) { fail(err); } };
  const remindBtn = view.querySelector('#remind');
  if (remindBtn) remindBtn.onclick = () => openReminderModal({ customer: d.partner, documents: [d] });
});

// ---------- Impression ----------
route('/imprimer/:id', async (view, p) => {
  const [d, company] = await Promise.all([get('/api/documents/' + p.id), get('/api/company')]);
  const t = totals(d.lines.map((l) => ({ ...l })), d.timbre);
  const pt = d.partner || {};
  const partnerWord = d.side === 'sale' ? 'Client' : 'Fournisseur';
  const showPrices = true;
  document.title = `${d.label} ${d.number || 'brouillon'} – ${company.name}`;
  view.innerHTML = String(html`
    <div class="print-bar"><span>${d.label} ${d.number || '(brouillon)'}</span>
      <div class="row"><button class="btn" id="do-print">${icon('print', 16)} Imprimer ou enregistrer en PDF</button><button class="btn ghost" style="color:#fff" onclick="window.close()">Fermer</button></div></div>
    ${d.status === 'brouillon' ? html`<div class="p-draft">BROUILLON</div>` : ''}
    <div class="print-page">
      <div class="p-head">
        <div class="p-company"><h2>${company.name}${company.legal_form ? ' ' + company.legal_form : ''}</h2>
          <div>${company.address || ''}${company.city ? html`<br>${company.city}` : ''}</div>
          <div>${[company.phone ? 'Tél. ' + company.phone : '', company.email].filter(Boolean).join(' – ')}</div>
          <div>${company.tax_id ? 'Matricule fiscal : ' + company.tax_id : ''}${company.rc ? html`<br>RC : ${company.rc}` : ''}</div></div>
        <div class="p-title"><h1>${d.label}</h1>
          <div style="font-size:15px;font-weight:700">N° ${d.number || 'BROUILLON'}</div>
          <div>Date : ${date(d.date)}</div>${d.due_date ? html`<div>Échéance : ${date(d.due_date)}</div>` : ''}
          ${d.ext_ref ? html`<div>Réf. : ${d.ext_ref}</div>` : ''}${d.source ? html`<div>Selon ${docLabel(d.side, d.source.type).toLowerCase()} ${d.source.number || ''}</div>` : ''}</div>
      </div>
      <div class="p-parties">
        <div></div>
        <div class="p-box"><div class="t">${partnerWord}</div><b>${pt.name || ''}</b><br>${pt.address || ''}${pt.city ? html`<br>${pt.city}` : ''}
          ${pt.tax_id ? html`<br>MF : ${pt.tax_id}` : ''}${pt.phone ? html`<br>Tél. ${pt.phone}` : ''}<br><span style="color:#666">Code ${pt.code || ''}</span></div>
      </div>
      <table class="p-lines"><thead><tr><th>Réf.</th><th>Désignation</th><th class="r">Qté</th>${showPrices ? html`<th class="r">P.U. HT</th><th class="r">Rem. %</th><th class="r">TVA</th><th class="r">Total HT</th>` : ''}</tr></thead>
        <tbody>${d.lines.map((l) => html`<tr><td>${l.product_code || ''}</td><td>${l.description}</td><td class="r">${fmt3(l.qty).replace(/,000$/, '')} ${l.unit || ''}</td>
          ${showPrices ? html`<td class="r">${fmt3(l.unit_price)}</td><td class="r">${n(l.discount) ? fmt2(l.discount) : ''}</td><td class="r">${fmt2(l.vat_rate)} %</td><td class="r">${fmt3(l.total_ht)}</td>` : ''}</tr>`)}</tbody></table>
      <div class="p-bottom">
        <div>
          ${t.rates.length ? html`<table class="p-lines" style="width:auto;min-width:260px"><thead><tr><th>Taux TVA</th><th class="r">Base HT</th><th class="r">Montant TVA</th></tr></thead>
            <tbody>${t.rates.map((r) => html`<tr><td>${fmt2(r.rate)} %</td><td class="r">${fmt3(r.base)}</td><td class="r">${fmt3(r.tva)}</td></tr>`)}</tbody></table>` : ''}
          ${['facture', 'avoir', 'devis'].includes(d.type) ? html`<p class="p-words">${d.type === 'facture' ? 'Arrêtée la présente facture' : `Arrêté le présent ${d.type === 'avoir' ? 'avoir' : 'devis'}`} à la somme de : ${amountInWords(d.total_ttc)}.</p>` : ''}
          ${d.notes ? html`<p style="white-space:pre-line;margin-top:10px">${d.notes}</p>` : ''}
          ${d.type === 'facture' && d.side === 'sale' && company.rib ? html`<p style="margin-top:10px">Règlement par virement : ${company.bank_name || ''} RIB ${company.rib}</p>` : ''}
        </div>
        <div class="p-totals">
          <div><span>Total HT</span><span>${fmt3(d.total_ht)}</span></div>
          <div><span>Total TVA</span><span>${fmt3(d.total_tva)}</span></div>
          ${n(d.timbre) ? html`<div><span>Timbre fiscal</span><span>${fmt3(d.timbre)}</span></div>` : ''}
          <div class="g"><span>${d.type === 'facture' ? 'Net à payer TTC' : 'Total TTC'}</span><span>${fmt3(d.total_ttc)} DT</span></div>
        </div>
      </div>
      <div class="p-sign"><div>Cachet et signature</div></div>
      <div class="p-foot">${company.invoice_footer || [company.name, company.legal_form, company.tax_id ? 'MF ' + company.tax_id : '', company.rc ? 'RC ' + company.rc : '', company.rib ? 'RIB ' + company.rib : ''].filter(Boolean).join(' – ')}</div>
    </div>`);
  $('#do-print').onclick = () => window.print();
}, { bare: true });

export { raw, esc };
