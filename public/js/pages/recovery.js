// Recouvrement : balance âgée, relances, règlements
import {
  html, raw, esc, route, get, post, put, go, setTop, money, moneyText, date, today, addDays, n, fmt3, qs, toast, fail, modal, confirmBox,
  combo, table, bindRowLinks, downloadCsv, csvNum, icon, canEdit, ref, clearRef, $, $$, on, state, formData, field, input, select, textarea,
} from '../core.js';
import { updateBadges } from '../main.js';

export const METHODS = { especes: 'Espèces', cheque: 'Chèque', virement: 'Virement', traite: 'Traite', carte: 'Carte bancaire', d17: 'D17', autre: 'Autre' };
const CHANNELS = { telephone: 'Téléphone', whatsapp: 'WhatsApp', email: 'E-mail', sms: 'SMS', courrier: 'Courrier', visite: 'Visite' };
const LEVELS = { 1: 'Relance amiable', 2: 'Relance ferme', 3: 'Mise en demeure' };
const parse = (v) => n(String(v ?? '').replace(/\s/g, '').replace(',', '.'));

export function waLink(phone, text) {
  let p = String(phone || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.length === 8) p = '216' + p;
  if (p.startsWith('00')) p = p.slice(2);
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

// ---------- Saisie d'un règlement ----------
export async function openPaymentModal({ side = 'in', partner_id = null, partner_name = '', document = null, onDone }) {
  const docSide = side === 'in' ? 'sale' : 'purchase';
  const partners = await ref(side === 'in' ? 'customers' : 'suppliers');
  let pid = partner_id;
  let items = [];
  const word = side === 'in' ? 'client' : 'fournisseur';
  const m = modal({
    title: side === 'in' ? 'Encaisser un règlement client' : 'Payer un fournisseur', wide: true,
    body: html`<form id="pay-form" class="grid" autocomplete="off">
      <label class="field">${side === 'in' ? 'Client' : 'Fournisseur'}<div><input id="pay-partner" value="${partner_name}" placeholder="Rechercher un ${word}…" ${partner_id ? raw('disabled') : ''}></div></label>
      <div class="grid c3">
        ${field('Date', input('date', today(), 'type="date" required'))}
        ${field('Montant reçu (DT)', input('amount', document ? fmt3(n(document.total_ttc) - n(document.paid)) : '', 'class="num" inputmode="decimal" required'))}
        ${field('Mode de règlement', select('method', Object.entries(METHODS), 'virement'))}
      </div>
      <div class="grid c3">
        ${field('Référence', input('reference', '', 'placeholder="N° de chèque, de virement…"'))}
        ${field('Banque', input('bank', ''))}
        ${field('Échéance', input('due_date', '', 'type="date"'), 'chèque ou traite')}
      </div>
      ${side === 'in' ? html`<div class="grid c3">${field('Retenue à la source (DT)', input('withholding', '', 'class="num" inputmode="decimal"'), 'déduite par le client')}
        <div class="span-2" style="align-self:end"><button type="button" class="btn small" id="rs15">Retenue 1,5 % du TTC</button> <button type="button" class="btn small" id="rs1">Retenue 1 %</button></div></div>` : ''}
      <div><div class="row between" style="margin-bottom:6px"><b>Affectation aux factures</b><span class="small muted" id="alloc-sum"></span></div><div id="alloc"><p class="muted">Choisissez un ${word} pour voir ses factures ouvertes.</p></div></div>
      ${field('Note', input('note', ''))}
    </form>`,
    actions: [{ label: 'Annuler' }, {
      label: 'Enregistrer le règlement', kind: 'primary', onClick: async (mm) => {
        if (!pid) throw new Error(`Choisissez un ${word}.`);
        const f = formData($('#pay-form', mm.el));
        const allocations = $$('.alloc-amt', mm.el).map((el) => ({ document_id: Number(el.dataset.id), amount: parse(el.value) })).filter((a) => a.amount > 0);
        const r = await post('/api/payments', { side, partner_id: pid, date: f.date, amount: parse(f.amount), withholding: parse(f.withholding), method: f.method, reference: f.reference, bank: f.bank, due_date: f.due_date || null, note: f.note, allocations, auto: false });
        toast(`Règlement ${r.number} enregistré${r.unallocated > 0.0005 ? ` (${moneyText(r.unallocated)} non affectés, gardés en avance)` : ''}`, 'success');
        clearRef('customers'); clearRef('suppliers');
        if (onDone) onDone(r);
      },
    }],
  });
  const form = $('#pay-form', m.el);
  const distribute = () => {
    let left = parse(form.amount.value) + parse(form.withholding ? form.withholding.value : 0);
    const order = [...items].sort((a, b) => (document && a.id === document.id ? -1 : document && b.id === document.id ? 1 : 0));
    for (const it of order) { const a = Math.max(0, Math.min(left, n(it.open_amount))); it.alloc = Math.round(a * 1000) / 1000; left -= a; }
    renderAlloc();
  };
  const updateSum = () => {
    const s = $$('.alloc-amt', m.el).reduce((t, el) => t + parse(el.value), 0);
    const total = parse(form.amount.value) + parse(form.withholding ? form.withholding.value : 0);
    $('#alloc-sum', m.el).textContent = `Affecté ${moneyText(s)} sur ${moneyText(total)}`;
  };
  const renderAlloc = () => {
    $('#alloc', m.el).innerHTML = items.length ? String(table({
      stack: true,
      columns: [
        { label: 'Facture', render: (d) => html`<span class="strong">${d.number}</span> <span class="muted small">du ${date(d.date)}</span>` },
        { label: 'Échéance', render: (d) => date(d.due_date) },
        { label: 'Reste dû', align: 'r', render: (d) => money(d.open_amount) },
        { label: 'À affecter', align: 'r', render: (d) => raw(`<input class="num alloc-amt" data-id="${d.id}" style="width:130px" inputmode="decimal" value="${d.alloc ? fmt3(d.alloc) : ''}">`) },
      ], rows: items,
    })) : `<p class="muted">Aucune facture ouverte : le montant sera gardé comme avance du ${word}.</p>`;
    updateSum();
  };
  const loadItems = async () => {
    items = pid ? await get('/api/open-items' + qs({ side: docSide, partner_id: pid })) : [];
    distribute();
  };
  if (!partner_id) combo($('#pay-partner', m.el), { items: () => partners.filter((p) => p.active), getLabel: (p) => p.name, getSub: (p) => (n(p.balance) ? moneyText(p.balance) : p.code), onPick: (p) => { pid = p.id; loadItems().catch(fail); } });
  form.amount.addEventListener('input', distribute);
  if (form.withholding) {
    form.withholding.addEventListener('input', distribute);
    const rs = (rate) => { const base = items.reduce((s, d) => s + n(d.total_ttc) - n(d.paid), 0); form.withholding.value = fmt3(Math.round(base * rate * 1000) / 1000); form.amount.value = fmt3(Math.max(0, base - parse(form.withholding.value))); distribute(); };
    $('#rs15', m.el).onclick = () => rs(0.015);
    $('#rs1', m.el).onclick = () => rs(0.01);
  }
  on($('#alloc', m.el), 'input', '.alloc-amt', updateSum);
  form.method.addEventListener('change', () => { if (form.method.value === 'especes') form.reference.value = ''; });
  await loadItems();
}

// ---------- Relance ----------
function reminderText(level, customer, docs, company) {
  const total = docs.reduce((s, d) => s + n(d.total_ttc) - n(d.paid), 0);
  const list = docs.map((d) => `- Facture ${d.number} du ${date(d.date)}${d.due_date ? ` (échéance ${date(d.due_date)})` : ''} : ${moneyText(n(d.total_ttc) - n(d.paid))}`).join('\n');
  const hello = `Bonjour${customer.contact ? ' ' + customer.contact : ''},`;
  if (Number(level) === 3) return `${hello}\n\nMalgré nos relances, les factures suivantes restent impayées :\n${list}\n\nTotal dû : ${moneyText(total)}.\n\nPar la présente, nous vous mettons en demeure de régler cette somme dans un délai de huit jours. À défaut, nous engagerons une procédure de recouvrement.\n\n${company}`;
  if (Number(level) === 2) return `${hello}\n\nMalgré notre précédente relance, les factures suivantes restent impayées :\n${list}\n\nTotal dû : ${moneyText(total)}.\n\nNous vous demandons de régulariser cette situation sous huit jours. Pour toute question, nous restons à votre disposition.\n\nCordialement,\n${company}`;
  return `${hello}\n\nSauf erreur de notre part, les factures suivantes restent à régler :\n${list}\n\nTotal dû : ${moneyText(total)}.\n\nMerci de bien vouloir procéder à leur règlement. Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.\n\nCordialement,\n${company}`;
}

export async function openReminderModal({ customer, documents = null, onDone }) {
  const docs = documents && documents.length && documents[0].total_ttc !== undefined && documents.length > 1 ? documents
    : await get('/api/open-items' + qs({ side: 'sale', partner_id: customer.id }));
  const last = (await get('/api/reminders' + qs({ customer_id: customer.id })))[0];
  const level = last ? Math.min(3, last.level + 1) : 1;
  const company = state.me.company.name;
  const m = modal({
    title: `Relancer ${customer.name}`, wide: true,
    body: html`<form id="rem-form" class="grid">
      ${last ? html`<div class="notice">Dernière relance le ${date(last.date)} (${CHANNELS[last.channel] || last.channel}, ${LEVELS[last.level]})${last.note ? html` : ${last.note}` : ''}</div>` : ''}
      <div class="grid c3">${field('Niveau', select('level', Object.entries(LEVELS), level))}${field('Canal', select('channel', Object.entries(CHANNELS), customer.whatsapp ? 'whatsapp' : 'telephone'))}${field('Date', input('date', today(), 'type="date"'))}</div>
      ${field('Message', textarea('message', reminderText(level, customer, docs, company), 'rows="10"'), 'modifiable')}
      <div class="row">
        ${customer.phone ? html`<a class="btn" href="tel:${customer.phone}">${icon('phone', 16)} Appeler ${customer.phone}</a>` : ''}
        <a class="btn" id="rem-wa" target="_blank" rel="noopener" href="#">${icon('chat', 16)} Ouvrir WhatsApp</a>
        <a class="btn" id="rem-mail" href="#">${icon('mail', 16)} Ouvrir l'e-mail</a>
        <button type="button" class="btn" id="rem-print">${icon('print', 16)} Imprimer la lettre</button>
      </div>
      ${field('Compte rendu', input('note', '', 'placeholder="Ce que le client a répondu"'))}
      <div class="grid c3">${field('Promesse de paiement le', input('promise_date', '', 'type="date"'))}${field('Montant promis (DT)', input('promise_amount', '', 'class="num" inputmode="decimal"'))}${field('Prochaine relance le', input('next_date', addDays(today(), 7), 'type="date"'))}</div>
    </form>`,
    actions: [{ label: 'Fermer' }, {
      label: 'Enregistrer la relance', kind: 'primary', onClick: async (mm) => {
        const f = formData($('#rem-form', mm.el));
        await post('/api/reminders', { customer_id: customer.id, document_id: docs.length === 1 ? docs[0].id : null, date: f.date, channel: f.channel, level: f.level, note: f.note, promise_date: f.promise_date || null, promise_amount: f.promise_amount ? parse(f.promise_amount) : null, next_date: f.next_date || null });
        toast('Relance enregistrée', 'success');
        updateBadges();
        if (onDone) onDone();
      },
    }],
  });
  const form = $('#rem-form', m.el);
  const refresh = () => {
    const wa = waLink(customer.whatsapp || customer.phone, form.message.value);
    const a = $('#rem-wa', m.el); a.href = wa || '#'; a.classList.toggle('hidden', !wa);
    const mail = $('#rem-mail', m.el);
    mail.href = `mailto:${customer.email || ''}?subject=${encodeURIComponent(`${LEVELS[form.level.value]} – factures impayées – ${company}`)}&body=${encodeURIComponent(form.message.value)}`;
  };
  form.level.onchange = () => { form.message.value = reminderText(form.level.value, customer, docs, company); refresh(); };
  form.message.oninput = refresh;
  refresh();
  $('#rem-print', m.el).onclick = async () => {
    const co = await get('/api/company');
    const w = window.open('', '_blank');
    if (!w) return fail(new Error('Autorisez les fenêtres pour imprimer la lettre.'));
    w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(LEVELS[form.level.value])}</title>
      <style>body{font:14px/1.6 Georgia,serif;max-width:170mm;margin:20mm auto;color:#111}h1{font-size:18px;margin:28px 0 18px}.right{text-align:right}pre{font:inherit;white-space:pre-wrap}</style></head><body>
      <div><b>${esc(co.name)}</b><br>${esc(co.address || '')}<br>${esc(co.city || '')}<br>${co.tax_id ? 'MF ' + esc(co.tax_id) : ''}</div>
      <div class="right"><b>${esc(customer.name)}</b><br>${esc(customer.address || '')}<br>${esc(customer.city || '')}</div>
      <p class="right">${esc(co.city || '')}, le ${date(form.date.value)}</p>
      <h1>Objet : ${esc(LEVELS[form.level.value])}${Number(form.level.value) === 3 ? ' de payer' : ''}</h1>
      <pre>${esc(form.message.value)}</pre><script>window.print()<\/script></body></html>`);
    w.document.close();
  };
}

// ---------- Balance âgée ----------
route('/recouvrement', async (view, p, q) => {
  const side = q.cote === 'fournisseurs' ? 'purchase' : 'sale';
  const [ov, ag] = await Promise.all([get('/api/recovery/overview'), get('/api/recovery/aging' + qs({ side }))]);
  setTop('Encours et balance âgée', canEdit() && side === 'sale' ? html`<button class="btn primary" id="new-pay">Encaisser un règlement</button>` : '');
  const tt = ag.totals;
  const buckets = [['not_due', 'Non échu'], ['d30', '1 à 30 j'], ['d60', '31 à 60 j'], ['d90', '61 à 90 j'], ['d90p', 'Plus de 90 j']];
  const posTotal = buckets.reduce((s, [k]) => s + Math.max(0, n(tt[k])), 0);
  view.innerHTML = String(html`
    ${side === 'sale' ? html`<div class="kpis">
      <div class="kpi"><div class="label">Encours clients</div><div class="value">${money(ov.total, { cls: 'amt-xl' })}</div><div class="sub">dont ${money(ov.overdue)} échus (${Math.round(ov.overdue_rate)} %)</div></div>
      <div class="kpi"><div class="label">Délai moyen de paiement</div><div class="value amt-xl">${ov.dso === null ? '—' : ov.dso + ' j'}</div><div class="sub">Encours rapporté aux ventes des 90 derniers jours</div></div>
      <div class="kpi"><div class="label">Encaissé ce mois</div><div class="value">${money(ov.collected_month, { cls: 'amt-xl' })}</div><div class="sub">Règlements clients enregistrés</div></div>
      <a class="kpi ${ov.todo ? 'alert' : ''}" href="#/recouvrement/relances" style="text-decoration:none;color:inherit"><div class="label">Relances à faire</div><div class="value amt-xl">${ov.todo}</div><div class="sub">${ov.promises.n} promesse${ov.promises.n > 1 ? 's' : ''} pour ${money(ov.promises.amount)}${ov.over_limit ? html`, ${ov.over_limit} client${ov.over_limit > 1 ? 's' : ''} au-delà du plafond` : ''}</div></a>
    </div>` : ''}
    <div class="panel" style="margin-top:18px"><div class="panel-head">
      <div class="seg" id="side"><button data-v="clients" class="${side === 'sale' ? 'on' : ''}">Clients</button><button data-v="fournisseurs" class="${side === 'purchase' ? 'on' : ''}">Fournisseurs</button></div>
      <button class="btn small" id="export">${icon('download', 16)} Exporter</button></div>
      <div class="panel-body">
        ${posTotal > 0 ? html`<div class="agebar" role="img" aria-label="Répartition de l'encours par ancienneté">${buckets.map(([k], i) => (n(tt[k]) > 0 ? raw(`<span style="flex:${n(tt[k])};background:var(--age-${i})" title="${esc(moneyText(tt[k]))}"></span>`) : ''))}</div>
        <div class="legend">${buckets.map(([k, l], i) => html`<span><i style="background:var(--age-${i})"></i>${l} ${money(tt[k] || 0)}</span>`)}</div>` : html`<p class="muted" style="margin:0">Aucun montant en attente.</p>`}
      </div>
      <div class="panel-body flush" id="aging"></div></div>`);
  const cols = [
    { label: side === 'sale' ? 'Client' : 'Fournisseur', render: (r) => html`<span class="strong">${r.name}</span>${n(r.credit_limit) > 0 && r.total > n(r.credit_limit) ? html` <span class="chip bad">plafond dépassé</span>` : ''}<div class="muted small">${r.code}${r.phone ? ', ' + r.phone : ''}</div>` },
    ...buckets.map(([k, l]) => ({ label: l, align: 'r', render: (r) => (n(r[k]) ? money(r[k], { cur: false }) : html`<span class="muted">—</span>`) })),
    { label: 'Avances et avoirs', align: 'r', render: (r) => (n(r.credits) ? money(r.credits, { cur: false }) : html`<span class="muted">—</span>`) },
    { label: 'Total', align: 'r', render: (r) => money(r.total) },
  ];
  if (side === 'sale') {
    cols.push({ label: 'Dernière relance', render: (r) => (r.last_reminder ? html`${date(r.last_reminder.date)}<div class="muted small">${LEVELS[r.last_reminder.level]}${r.last_reminder.promise_date ? html`, promesse au ${date(r.last_reminder.promise_date)}` : ''}</div>` : html`<span class="muted">Jamais</span>`) });
    if (canEdit()) cols.push({ label: '', render: (r) => (r.overdue > 0 ? html`<button class="btn small" data-remind="${r.id}">Relancer</button>` : '') });
  }
  const foot = cols.map(() => '');
  foot[0] = `${ag.rows.length} ${side === 'sale' ? 'client' : 'fournisseur'}${ag.rows.length > 1 ? 's' : ''}`;
  buckets.forEach(([k], i) => { foot[i + 1] = money(tt[k] || 0, { cur: false }); });
  foot[buckets.length + 1] = money(tt.credits || 0, { cur: false });
  foot[buckets.length + 2] = money(tt.total || 0);
  $('#aging', view).innerHTML = String(table({ columns: cols, rows: ag.rows, href: (r) => (side === 'sale' ? '/clients/' : '/fournisseurs/') + r.id, foot: ag.rows.length ? foot : null, empty: 'Personne ne doit d\'argent pour le moment.' }));
  bindRowLinks(view);
  on(view, 'click', '[data-remind]', (e, b) => { const c = ag.rows.find((r) => r.id === Number(b.dataset.remind)); openReminderModal({ customer: c, onDone: () => go('/recouvrement') }); });
  on($('#side', view), 'click', 'button', (e, b) => go('/recouvrement' + (b.dataset.v === 'fournisseurs' ? '?cote=fournisseurs' : '')));
  $('#export', view).onclick = () => downloadCsv('balance-agee.csv', ['Code', 'Nom', ...buckets.map(([, l]) => l), 'Avances et avoirs', 'Total'],
    ag.rows.map((r) => [r.code, r.name, ...buckets.map(([k]) => csvNum(r[k])), csvNum(r.credits), csvNum(r.total)]));
  const np = document.getElementById('new-pay');
  if (np) np.onclick = () => openPaymentModal({ side: 'in', onDone: () => go('/recouvrement') });
});

// ---------- Agenda des relances ----------
route('/recouvrement/relances', async (view, p, q) => {
  const all = q.vue === 'historique';
  setTop('Agenda des relances');
  const rows = await get('/api/reminders' + (all ? '' : '?todo=1'));
  view.innerHTML = String(html`
    <div class="tabs"><a href="#/recouvrement/relances" class="${!all ? 'on' : ''}">À faire</a><a href="#/recouvrement/relances?vue=historique" class="${all ? 'on' : ''}">Historique</a></div>
    <div class="panel">${table({
      columns: [
        { label: 'Client', render: (r) => html`<a class="strong" href="#/clients/${r.customer_id}">${r.customer_name}</a><div class="muted small">${r.phone || ''}</div>` },
        { label: all ? 'Date' : 'Prévue le', render: (r) => (all ? date(r.date) : html`${date(r.next_date || r.promise_date)}${(r.next_date || r.promise_date) < today() ? html` <span class="chip late">en retard</span>` : ''}`) },
        { label: 'Dernier contact', render: (r) => html`${CHANNELS[r.channel] || r.channel}, ${LEVELS[r.level]}<div class="muted small">${date(r.date)}${r.user_name ? ', ' + r.user_name : ''}</div>` },
        { label: 'Compte rendu', render: (r) => r.note || html`<span class="muted">—</span>` },
        { label: 'Promesse', render: (r) => (r.promise_date ? html`${date(r.promise_date)}${r.promise_amount ? html`<div>${money(r.promise_amount)}</div>` : ''}` : html`<span class="muted">—</span>`) },
        { label: '', render: (r) => (canEdit() && !r.done ? html`<div class="row" style="justify-content:flex-end"><button class="btn small primary" data-relance="${r.customer_id}">Relancer</button><button class="btn small" data-done="${r.id}">Marquer traité</button></div>` : (r.done ? html`<span class="chip off">Traité</span>` : '')) },
      ], rows, empty: all ? 'Aucune relance enregistrée.' : html`<p>Aucune relance prévue aujourd'hui.</p><a class="btn" href="#/recouvrement">Voir la balance âgée</a>`,
    })}</div>`);
  on(view, 'click', '[data-done]', async (e, b) => { try { await put('/api/reminders/' + b.dataset.done, { done: true }); toast('Relance marquée comme traitée'); updateBadges(); go(location.hash.slice(1)); } catch (err) { fail(err); } });
  on(view, 'click', '[data-relance]', async (e, b) => {
    const c = await get('/api/customers/' + b.dataset.relance);
    openReminderModal({ customer: c, onDone: () => go('/recouvrement/relances') });
  });
});

// ---------- Règlements ----------
export async function paymentDetail(id, onChange) {
  const pm = await get('/api/payments/' + id);
  const isIn = pm.side === 'in';
  const statusLabel = { valide: 'Validé', impaye: 'Impayé', annule: 'Annulé' };
  const actions = [{ label: 'Fermer' }];
  if (canEdit() && pm.status === 'valide') {
    if (['cheque', 'traite'].includes(pm.method) && isIn) actions.unshift({ label: 'Déclarer impayé', kind: 'danger', onClick: async () => {
      if (!(await confirmBox('Déclarer ce règlement impayé ? Les factures concernées redeviennent dues.', { ok: 'Déclarer impayé', danger: true }))) return false;
      await post(`/api/payments/${pm.id}/cancel`, { reason: 'impaye' }); toast('Règlement déclaré impayé'); if (onChange) onChange();
    } });
    actions.unshift({ label: 'Annuler le règlement', kind: 'danger', onClick: async () => {
      if (!(await confirmBox('Annuler ce règlement ? Une écriture d\'annulation sera passée en comptabilité.', { ok: 'Annuler le règlement', danger: true }))) return false;
      await post(`/api/payments/${pm.id}/cancel`, { reason: 'annule' }); toast('Règlement annulé'); if (onChange) onChange();
    } });
  }
  modal({
    title: `${isIn ? 'Règlement' : 'Paiement'} ${pm.number}`,
    body: html`<dl class="dl">
      <dt>${isIn ? 'Client' : 'Fournisseur'}</dt><dd><a href="#/${isIn ? 'clients' : 'fournisseurs'}/${pm.partner.id}">${pm.partner.name}</a></dd>
      <dt>Date</dt><dd>${date(pm.date)}</dd><dt>Montant</dt><dd>${money(pm.amount)}</dd>
      ${n(pm.withholding) ? html`<dt>Retenue à la source</dt><dd>${money(pm.withholding)}</dd>` : ''}
      <dt>Mode</dt><dd>${METHODS[pm.method] || pm.method}${pm.reference ? ` n° ${pm.reference}` : ''}${pm.bank ? `, ${pm.bank}` : ''}</dd>
      ${pm.due_date ? html`<dt>Échéance</dt><dd>${date(pm.due_date)}</dd>` : ''}
      <dt>Statut</dt><dd>${statusLabel[pm.status] || pm.status}</dd>${pm.note ? html`<dt>Note</dt><dd>${pm.note}</dd>` : ''}
    </dl>
    <h3 style="margin:18px 0 6px">Factures réglées</h3>
    ${pm.allocations.length ? html`<ul class="list">${pm.allocations.map((a) => html`<li><a href="#/document/${a.document_id}">${a.number}</a>${money(a.amount)}</li>`)}</ul>` : html`<p class="muted">Aucune (avance${pm.status !== 'valide' ? ' ou règlement annulé' : ''}).</p>`}`,
    actions,
  });
}

route('/reglements/:side', async (view, p, q) => {
  const side = p.side === 'out' ? 'out' : 'in';
  const word = side === 'in' ? 'Client' : 'Fournisseur';
  setTop(side === 'in' ? 'Règlements clients' : 'Paiements fournisseurs', canEdit() ? html`<button class="btn primary" id="new-pay">${icon('plus', 16)} ${side === 'in' ? 'Encaisser un règlement' : 'Payer un fournisseur'}</button>` : '');
  const filters = { side, q: '', method: '', from: '', to: '', portfolio: q.portefeuille ? 1 : '' };
  view.innerHTML = String(html`<div class="toolbar">
      <div class="search">${icon('search')}<input id="f-q" placeholder="N°, référence, ${word.toLowerCase()}…"></div>
      <select id="f-method"><option value="">Tous les modes</option>${Object.entries(METHODS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      ${side === 'in' ? html`<label class="check"><input type="checkbox" id="f-port" ${filters.portfolio ? raw('checked') : ''}> Chèques et traites à échéance</label>` : ''}
      <input type="date" id="f-from" aria-label="Du"><input type="date" id="f-to" aria-label="Au">
      <button class="btn" id="export">${icon('download', 16)} Exporter</button></div>
    <div class="panel" id="list"></div>`);
  let rows = [];
  const load = async () => {
    rows = await get('/api/payments' + qs(filters));
    const st = { valide: '', impaye: html`<span class="chip bad">Impayé</span>`, annule: html`<span class="chip off">Annulé</span>` };
    const valid = rows.filter((r) => r.status === 'valide');
    $('#list', view).innerHTML = String(table({
      columns: [
        { label: 'N°', render: (r) => html`<span class="strong">${r.number}</span> ${st[r.status]}` },
        { label: 'Date', render: (r) => date(r.date) },
        { label: word, render: (r) => r.partner_name },
        { label: 'Mode', render: (r) => html`${METHODS[r.method] || r.method}${r.reference ? html`<div class="muted small">n° ${r.reference}${r.bank ? ', ' + r.bank : ''}</div>` : ''}` },
        { label: 'Échéance', render: (r) => date(r.due_date) },
        { label: 'Non affecté', align: 'r', render: (r) => (r.status === 'valide' && n(r.amount) + n(r.withholding) - n(r.allocated) > 0.0005 ? money(n(r.amount) + n(r.withholding) - n(r.allocated), { cur: false }) : '') },
        { label: 'Montant', align: 'r', render: (r) => html`${money(r.amount)}${n(r.withholding) ? html`<div class="muted small">+ RS ${money(r.withholding, { cur: false })}</div>` : ''}` },
      ], rows, href: (r) => `/reglement/${r.id}`,
      foot: rows.length ? [`${rows.length} règlement${rows.length > 1 ? 's' : ''}`, '', '', '', '', '', money(valid.reduce((s, r) => s + n(r.amount), 0))] : null,
      empty: 'Aucun règlement ne correspond.',
    }));
  };
  on(view, 'click', 'tr[data-href]', (e, tr) => paymentDetail(tr.dataset.href.split('/').pop(), () => load().catch(fail)));
  let timer;
  $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { filters.q = e.target.value; load().catch(fail); }, 250); };
  $('#f-method', view).onchange = (e) => { filters.method = e.target.value; load().catch(fail); };
  $('#f-from', view).onchange = (e) => { filters.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { filters.to = e.target.value; load().catch(fail); };
  const port = $('#f-port', view);
  if (port) port.onchange = () => { filters.portfolio = port.checked ? 1 : ''; load().catch(fail); };
  $('#export', view).onclick = () => downloadCsv(side === 'in' ? 'reglements-clients.csv' : 'paiements-fournisseurs.csv',
    ['N°', 'Date', word, 'Mode', 'Référence', 'Banque', 'Échéance', 'Statut', 'Montant', 'Retenue à la source'],
    rows.map((r) => [r.number, date(r.date), r.partner_name, METHODS[r.method], r.reference, r.bank, date(r.due_date), r.status, csvNum(r.amount), csvNum(r.withholding)]));
  const np = document.getElementById('new-pay');
  if (np) np.onclick = () => openPaymentModal({ side, onDone: () => load().catch(fail) });
  await load();
});

export { raw };
