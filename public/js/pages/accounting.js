// Comptabilité et trésorerie
import {
  html, raw, route, get, post, put, del, go, setTop, money, moneyText, date, n, fmt3, fmt2, qs, toast, fail, modal, confirmBox, combo, table,
  downloadCsv, csvNum, icon, canEdit, $, $$, on, formData, field, input, today, yearStart,
} from '../core.js';
import { METHODS, paymentDetail } from './recovery.js';

const JOURNALS = { VT: 'Ventes', AC: 'Achats', BQ: 'Banque', CA: 'Caisse', OD: 'Opérations diverses', AN: 'À-nouveaux' };
const CLASSES = { 1: 'Capitaux propres et passifs non courants', 2: 'Actifs non courants', 3: 'Stocks', 4: 'Tiers', 5: 'Financiers', 6: 'Charges', 7: 'Produits' };
const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const parse = (v) => n(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
const tabs = (cur) => html`<div class="tabs">${[['tresorerie', 'Trésorerie'], ['ecritures', 'Écritures'], ['grand-livre', 'Grand livre'], ['balance', 'Balance'], ['tva', 'TVA'], ['plan', 'Plan comptable']]
  .map(([k, l]) => html`<a href="#/compta/${k}" class="${cur === k ? 'on' : ''}">${l}</a>`)}</div>`;

// ---------- Trésorerie ----------
route('/compta/tresorerie', async (view) => {
  setTop('Trésorerie');
  const t = await get('/api/treasury');
  const flows = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    const k = d.toISOString().slice(0, 7);
    const f = t.flows.find((x) => x.month === k) || {};
    flows.push({ month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, cash_in: n(f.cash_in), cash_out: n(f.cash_out) });
  }
  const inSum = t.receivables.reduce((s, r) => s + n(r.open), 0);
  const outSum = t.payables.reduce((s, r) => s + n(r.open), 0);
  view.innerHTML = String(html`${tabs('tresorerie')}
    <div class="kpis">
      <div class="kpi"><div class="label">Banque</div><div class="value">${money(t.bank, { cls: 'amt-xl' })}</div><div class="sub">Solde comptable</div></div>
      <div class="kpi"><div class="label">Caisse</div><div class="value">${money(t.cash, { cls: 'amt-xl' })}</div><div class="sub">Règlements en espèces</div></div>
      <div class="kpi"><div class="label">À encaisser sous 30 jours</div><div class="value">${money(inSum, { cls: 'amt-xl' })}</div><div class="sub">Factures clients échues ou à échoir</div></div>
      <div class="kpi"><div class="label">À payer sous 30 jours</div><div class="value">${money(outSum, { cls: 'amt-xl' })}</div><div class="sub">Factures fournisseurs</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><div class="panel-head"><h2>Encaissements et décaissements</h2></div><div class="panel-body flush">${table({
        stack: true, columns: [{ label: 'Mois', key: 'month' }, { label: 'Encaissé', align: 'r', render: (r) => money(r.cash_in) }, { label: 'Décaissé', align: 'r', render: (r) => money(r.cash_out) },
          { label: 'Solde du mois', align: 'r', render: (r) => money(r.cash_in - r.cash_out) }], rows: flows,
      })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Chèques et traites à encaisser</h2><a class="small" href="#/reglements/in?portefeuille=1">Tout voir</a></div><div class="panel-body">
        ${t.portfolio.length ? html`<ul class="list">${t.portfolio.map((p) => html`<li><span>${date(p.due_date)}, ${METHODS[p.method]} ${p.reference || ''}<div class="muted small">${p.partner_name}${p.bank ? ', ' + p.bank : ''}</div></span>${money(p.amount)}</li>`)}</ul>`
          : html`<p class="muted" style="margin:0">Aucun chèque ni traite en portefeuille.</p>`}</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><div class="panel-head"><h2>Factures clients à encaisser (30 jours)</h2></div><div class="panel-body flush">${table({
        columns: [{ label: 'Échéance', render: (r) => html`${date(r.due_date)}${r.due_date < today() ? html` <span class="chip late">échue</span>` : ''}` }, { label: 'Facture', key: 'number' }, { label: 'Client', key: 'partner_name' }, { label: 'Reste', align: 'r', render: (r) => money(r.open) }],
        rows: t.receivables, href: (r) => '/document/' + r.id, empty: 'Rien à encaisser sur la période.',
      })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Factures fournisseurs à payer (30 jours)</h2></div><div class="panel-body flush">${table({
        columns: [{ label: 'Échéance', render: (r) => date(r.due_date) }, { label: 'Facture', render: (r) => r.ext_ref || r.number }, { label: 'Fournisseur', key: 'partner_name' }, { label: 'Reste', align: 'r', render: (r) => money(r.open) }],
        rows: t.payables, href: (r) => '/document/' + r.id, empty: 'Rien à payer sur la période.',
      })}</div></div>
    </div>`);
  view.querySelectorAll('tr[data-href]').forEach((tr) => { tr.onclick = () => go(tr.dataset.href); });
});

// ---------- Écritures ----------
function entryModal(accounts, onDone) {
  const lines = [{ account: '', debit: '', credit: '' }, { account: '', debit: '', credit: '' }];
  const m = modal({
    title: 'Nouvelle écriture', wide: true,
    body: html`<form id="en-form" class="grid" autocomplete="off">
      <div class="grid c3">${field('Journal', raw(`<select name="journal">${Object.entries(JOURNALS).map(([k, l]) => `<option value="${k}" ${k === 'OD' ? 'selected' : ''}>${k} – ${l}</option>`).join('')}</select>`))}
        ${field('Date', input('date', today(), 'type="date"'))}${field('Pièce', input('ref', ''))}</div>
      ${field('Libellé', input('label', '', 'required placeholder="Ex. : loyer d\'octobre"'))}
      <table class="data" style="font-size:.9rem"><thead><tr><th>Compte</th><th class="r">Débit</th><th class="r">Crédit</th><th></th></tr></thead><tbody id="en-lines"></tbody>
        <tfoot><tr><td><button type="button" class="btn small" id="en-add">${icon('plus', 14)} Ligne</button></td><td class="r" id="en-d"></td><td class="r" id="en-c"></td><td></td></tr></tfoot></table>
      <p class="small" id="en-bal"></p>
    </form>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (mm) => {
      const f = formData($('#en-form', mm.el));
      await post('/api/entries', { journal: f.journal, date: f.date, ref: f.ref, label: f.label, lines: lines.map((l) => ({ account: l.account, debit: parse(l.debit), credit: parse(l.credit) })) });
      toast('Écriture enregistrée', 'success'); onDone();
    } }],
  });
  const tbody = $('#en-lines', m.el);
  const sums = () => {
    const d = lines.reduce((s, l) => s + parse(l.debit), 0); const c = lines.reduce((s, l) => s + parse(l.credit), 0);
    $('#en-d', m.el).innerHTML = String(money(d, { cur: false })); $('#en-c', m.el).innerHTML = String(money(c, { cur: false }));
    const diff = Math.round((d - c) * 1000) / 1000;
    $('#en-bal', m.el).textContent = diff ? `Écart à répartir : ${fmt3(diff)} (${diff > 0 ? 'crédit' : 'débit'} manquant)` : 'Écriture équilibrée.';
    $('#en-bal', m.el).style.color = diff ? 'var(--grenade)' : 'var(--olive)';
  };
  const render = () => {
    tbody.innerHTML = lines.map((l, i) => `<tr data-i="${i}"><td data-label="Compte"><div><input class="en-acc" value="${l.account}" placeholder="N° ou intitulé"></div></td>
      <td class="r"><input class="num en-d" inputmode="decimal" style="width:120px" value="${l.debit}"></td><td class="r"><input class="num en-c" inputmode="decimal" style="width:120px" value="${l.credit}"></td>
      <td><button type="button" class="btn ghost small en-del" aria-label="Supprimer">×</button></td></tr>`).join('');
    $$('.en-acc', tbody).forEach((el) => {
      const i = +el.closest('tr').dataset.i;
      combo(el, { items: accounts, getLabel: (a) => a.code, getSub: (a) => a.name, onPick: (a) => { lines[i].account = a.code; } });
      el.addEventListener('input', () => { lines[i].account = el.value.trim(); });
    });
    sums();
  };
  on(tbody, 'input', '.en-d,.en-c', (e, el) => { const l = lines[+el.closest('tr').dataset.i]; if (el.classList.contains('en-d')) l.debit = el.value; else l.credit = el.value; sums(); });
  on(tbody, 'click', '.en-del', (e, b) => { if (lines.length > 2) { lines.splice(+b.closest('tr').dataset.i, 1); render(); } });
  $('#en-add', m.el).onclick = () => {
    const d = lines.reduce((s, l) => s + parse(l.debit), 0) - lines.reduce((s, l) => s + parse(l.credit), 0);
    lines.push({ account: '', debit: d < 0 ? fmt3(-d) : '', credit: d > 0 ? fmt3(d) : '' }); render();
  };
  render();
}

route('/compta/ecritures', async (view, p, q) => {
  setTop('Écritures comptables', canEdit() ? html`<button class="btn primary" id="new">${icon('plus', 16)} Saisir une écriture</button>` : '');
  const f = { journal: q.journal || '', from: q.du || yearStart(), to: '', q: '' };
  view.innerHTML = String(html`${tabs('ecritures')}
    <div class="toolbar">
      <div class="seg" id="f-j"><button data-v="" class="${!f.journal ? 'on' : ''}">Tous</button>${Object.keys(JOURNALS).map((k) => html`<button data-v="${k}" class="${f.journal === k ? 'on' : ''}" title="${JOURNALS[k]}">${k}</button>`)}</div>
      <div class="search">${icon('search')}<input id="f-q" placeholder="Libellé, n°, pièce…"></div>
      <input type="date" id="f-from" value="${f.from}" aria-label="Du"><input type="date" id="f-to" aria-label="Au">
      <button class="btn" id="export">${icon('download', 16)} Exporter</button></div>
    <div class="panel" id="list"></div>`);
  let data = { entries: [] };
  const load = async () => {
    data = await get('/api/entries' + qs(f));
    $('#list', view).innerHTML = String(data.entries.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>N°</th><th>Libellé</th><th>Compte</th><th class="r">Débit</th><th class="r">Crédit</th><th></th></tr></thead><tbody>
      ${data.entries.map((e) => html`${(e.lines || []).map((l, i) => html`<tr style="${i === 0 ? '' : 'border-top:0'}">
        <td>${i === 0 ? date(e.date) : ''}</td><td>${i === 0 ? html`<span class="strong">${e.number}</span>` : ''}</td>
        <td>${i === 0 ? html`<span class="strong">${e.label}</span>${e.ref ? html`<div class="muted small">Pièce ${e.ref}</div>` : ''}` : html`<span class="muted small">${l.label !== e.label ? l.label : ''}</span>`}</td>
        <td><a href="#/compta/grand-livre?compte=${l.account}">${l.account}</a></td>
        <td class="r">${n(l.debit) ? money(l.debit, { cur: false }) : ''}</td><td class="r">${n(l.credit) ? money(l.credit, { cur: false }) : ''}</td>
        <td>${i === 0 && e.source === 'manuel' && canEdit() ? html`<button class="btn ghost small" data-del="${e.id}" aria-label="Supprimer">${icon('trash', 15)}</button>` : ''}</td></tr>`)}`)}
      </tbody></table></div>` : html`<div class="empty">Aucune écriture sur la période. Les factures et règlements validés génèrent leurs écritures automatiquement.</div>`);
  };
  on($('#f-j', view), 'click', 'button', (e, b) => { $$('#f-j button', view).forEach((x) => x.classList.toggle('on', x === b)); f.journal = b.dataset.v; load().catch(fail); });
  let timer;
  $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; load().catch(fail); }, 250); };
  $('#f-from', view).onchange = (e) => { f.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { f.to = e.target.value; load().catch(fail); };
  on(view, 'click', '[data-del]', async (e, b) => {
    if (!(await confirmBox('Supprimer cette écriture manuelle ?', { ok: 'Supprimer', danger: true }))) return;
    try { await del('/api/entries/' + b.dataset.del); toast('Écriture supprimée'); load().catch(fail); } catch (err) { fail(err); }
  });
  $('#export', view).onclick = () => downloadCsv('ecritures.csv', ['Journal', 'N°', 'Date', 'Pièce', 'Libellé', 'Compte', 'Débit', 'Crédit'],
    data.entries.flatMap((e) => (e.lines || []).map((l) => [e.journal, e.number, date(e.date), e.ref, l.label || e.label, l.account, csvNum(l.debit), csvNum(l.credit)])));
  const nb = document.getElementById('new');
  if (nb) nb.onclick = async () => entryModal(await get('/api/accounts'), () => load().catch(fail));
  await load();
});

// ---------- Grand livre ----------
route('/compta/grand-livre', async (view, p, q) => {
  setTop('Grand livre');
  const accounts = await get('/api/accounts');
  const f = { account: q.compte || '', from: yearStart(), to: '' };
  const cur = accounts.find((a) => a.code === f.account);
  view.innerHTML = String(html`${tabs('grand-livre')}
    <div class="toolbar"><div class="search">${icon('search')}<input id="f-acc" placeholder="Compte (ex. 411, 532…)" value="${cur ? cur.code + ' ' + cur.name : f.account}"></div>
      <input type="date" id="f-from" value="${f.from}" aria-label="Du"><input type="date" id="f-to" aria-label="Au"><button class="btn" id="export">${icon('download', 16)} Exporter</button></div>
    <div class="panel" id="list"><div class="empty">Choisissez un compte. Un numéro court (par exemple 41) regroupe tous ses sous-comptes.</div></div>`);
  let data = null;
  const load = async () => {
    if (!f.account) return;
    data = await get('/api/ledger' + qs(f));
    $('#list', view).innerHTML = String(html`<div class="panel-head"><h2>${data.account} ${data.name || ''}</h2><span>Solde de clôture ${money(data.closing)}</span></div>${table({
      columns: [
        { label: 'Date', render: (r) => date(r.date) }, { label: 'Journal', key: 'journal' }, { label: 'N°', key: 'number' },
        { label: 'Libellé', render: (r) => html`${r.label}${r.account !== data.account ? html` <span class="muted small">(${r.account})</span>` : ''}` },
        { label: 'Débit', align: 'r', render: (r) => (n(r.debit) ? money(r.debit, { cur: false }) : '') },
        { label: 'Crédit', align: 'r', render: (r) => (n(r.credit) ? money(r.credit, { cur: false }) : '') },
        { label: 'Solde', align: 'r', render: (r) => money(r.balance, { cur: false }) },
      ], rows: [{ date: f.from, journal: '', number: '', label: 'Solde à nouveau', account: data.account, debit: 0, credit: 0, balance: data.opening }, ...data.lines],
      foot: ['', '', '', 'Totaux', money(data.lines.reduce((s, r) => s + n(r.debit), 0), { cur: false }), money(data.lines.reduce((s, r) => s + n(r.credit), 0), { cur: false }), money(data.closing)],
    })}`);
  };
  combo($('#f-acc', view), { items: accounts, getLabel: (a) => `${a.code} ${a.name}`, getSub: () => '', onPick: (a) => { f.account = a.code; load().catch(fail); } });
  $('#f-acc', view).addEventListener('keydown', (e) => { if (e.key === 'Enter' && /^\d+$/.test(e.target.value.trim())) { f.account = e.target.value.trim(); load().catch(fail); } });
  $('#f-from', view).onchange = (e) => { f.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { f.to = e.target.value; load().catch(fail); };
  $('#export', view).onclick = () => data && downloadCsv(`grand-livre-${data.account}.csv`, ['Date', 'Journal', 'N°', 'Compte', 'Libellé', 'Débit', 'Crédit', 'Solde'],
    data.lines.map((r) => [date(r.date), r.journal, r.number, r.account, r.label, csvNum(r.debit), csvNum(r.credit), csvNum(r.balance)]));
  await load();
});

// ---------- Balance ----------
route('/compta/balance', async (view) => {
  setTop('Balance générale');
  const f = { from: yearStart(), to: today() };
  view.innerHTML = String(html`${tabs('balance')}<div class="toolbar"><label class="field" style="flex-direction:row;align-items:center">Du <input type="date" id="f-from" value="${f.from}"></label>
    <label class="field" style="flex-direction:row;align-items:center">au <input type="date" id="f-to" value="${f.to}"></label><button class="btn" id="export">${icon('download', 16)} Exporter</button><button class="btn" onclick="window.print()">${icon('print', 16)} Imprimer</button></div><div class="panel" id="list"></div>`);
  let data;
  const load = async () => {
    data = await get('/api/trial-balance' + qs(f));
    const groups = {};
    data.rows.forEach((r) => { (groups[r.account[0]] = groups[r.account[0]] || []).push(r); });
    const sd = (v) => (v > 0.0005 ? money(v, { cur: false }) : '');
    const sc = (v) => (v < -0.0005 ? money(-v, { cur: false }) : '');
    $('#list', view).innerHTML = String(data.rows.length ? html`<div class="table-wrap"><table class="data"><thead><tr><th>Compte</th><th>Intitulé</th><th class="r">Mouvements débit</th><th class="r">Mouvements crédit</th><th class="r">Solde débiteur</th><th class="r">Solde créditeur</th></tr></thead><tbody>
      ${Object.keys(groups).sort().map((k) => {
        const g = groups[k];
        const t = g.reduce((a, r) => ({ d: a.d + r.debit, c: a.c + r.credit, s: a.s + r.closing }), { d: 0, c: 0, s: 0 });
        return html`<tr><td colspan="6" style="background:#F9FAFB;font-weight:650;color:var(--ink)">Classe ${k} – ${CLASSES[k] || ''}</td></tr>
          ${g.map((r) => html`<tr class="click" data-acc="${r.account}"><td class="strong">${r.account}</td><td>${r.name}</td><td class="r">${money(r.debit, { cur: false })}</td><td class="r">${money(r.credit, { cur: false })}</td><td class="r">${sd(r.closing)}</td><td class="r">${sc(r.closing)}</td></tr>`)}
          <tr><td></td><td class="muted">Total classe ${k}</td><td class="r strong">${money(t.d, { cur: false })}</td><td class="r strong">${money(t.c, { cur: false })}</td><td class="r strong">${sd(t.s)}</td><td class="r strong">${sc(t.s)}</td></tr>`;
      })}</tbody>
      <tfoot><tr><td></td><td>Total général</td><td class="r">${money(data.totals.debit, { cur: false })}</td><td class="r">${money(data.totals.credit, { cur: false })}</td>
        <td class="r">${money(data.rows.reduce((s, r) => s + Math.max(0, r.closing), 0), { cur: false })}</td><td class="r">${money(data.rows.reduce((s, r) => s + Math.max(0, -r.closing), 0), { cur: false })}</td></tr></tfoot></table></div>`
      : html`<div class="empty">Aucune écriture sur la période.</div>`);
  };
  on(view, 'click', 'tr[data-acc]', (e, tr) => go('/compta/grand-livre?compte=' + tr.dataset.acc));
  $('#f-from', view).onchange = (e) => { f.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { f.to = e.target.value; load().catch(fail); };
  $('#export', view).onclick = () => downloadCsv('balance-generale.csv', ['Compte', 'Intitulé', 'Solde initial', 'Débit', 'Crédit', 'Solde final'],
    data.rows.map((r) => [r.account, r.name, csvNum(r.opening), csvNum(r.debit), csvNum(r.credit), csvNum(r.closing)]));
  await load();
});

// ---------- TVA ----------
route('/compta/tva', async (view, p, q) => {
  setTop('Déclaration de TVA');
  const year = Number(q.annee) || new Date().getFullYear();
  const v = await get('/api/vat?year=' + year);
  const rates = (obj) => Object.entries(obj).sort((a, b) => b[0] - a[0]).map(([r, x]) => html`<div class="small">${fmt2(r)} % : base ${money(x.base, { cur: false })}, TVA ${money(x.tva, { cur: false })}</div>`);
  view.innerHTML = String(html`${tabs('tva')}
    <div class="toolbar"><select id="f-year">${[year + 1, year, year - 1, year - 2].map((y) => html`<option value="${y}" ${y === year ? raw('selected') : ''}>${y}</option>`)}</select>
      <span class="muted small">Calcul à partir des factures et avoirs validés. À faire vérifier par votre comptable avant dépôt.</span></div>
    <div class="panel">${table({
      columns: [
        { label: 'Mois', render: (m) => html`<span class="strong">${MONTHS[m.month - 1]}</span>` },
        { label: 'TVA collectée', align: 'r', render: (m) => html`${money(m.collected, { cur: false })}${rates(m.sales)}` },
        { label: 'TVA déductible', align: 'r', render: (m) => html`${money(m.deductible, { cur: false })}${rates(m.purchases)}` },
        { label: 'Crédit reporté', align: 'r', render: (m) => (m.carry_in ? money(m.carry_in, { cur: false }) : '') },
        { label: 'TVA à payer', align: 'r', render: (m) => (m.due ? money(m.due) : html`<span class="muted">—</span>`) },
        { label: 'Crédit à reporter', align: 'r', render: (m) => (m.carry_out ? money(m.carry_out, { cur: false }) : '') },
        { label: 'Droits de timbre', align: 'r', render: (m) => (m.timbre ? money(m.timbre, { cur: false }) : '') },
      ], rows: v.months,
      foot: ['Total', money(v.months.reduce((s, m) => s + m.collected, 0), { cur: false }), money(v.months.reduce((s, m) => s + m.deductible, 0), { cur: false }), '', money(v.months.reduce((s, m) => s + m.due, 0)), '', money(v.months.reduce((s, m) => s + m.timbre, 0), { cur: false })],
    })}</div>`);
  $('#f-year', view).onchange = (e) => go('/compta/tva?annee=' + e.target.value);
});

// ---------- Plan comptable ----------
route('/compta/plan', async (view) => {
  setTop('Plan comptable', canEdit() ? html`<button class="btn primary" id="new">${icon('plus', 16)} Nouveau compte</button>` : '');
  view.innerHTML = String(html`${tabs('plan')}<div class="toolbar"><div class="search">${icon('search')}<input id="f-q" placeholder="Numéro ou intitulé"></div></div><div class="panel" id="list"></div>`);
  let rows = await get('/api/accounts');
  const draw = (q = '') => {
    const list = rows.filter((a) => !q || (a.code + ' ' + a.name).toLowerCase().includes(q.toLowerCase()));
    $('#list', view).innerHTML = String(table({
      columns: [{ label: 'Compte', render: (a) => html`<span class="strong">${a.code}</span>` }, { label: 'Intitulé', key: 'name' },
        { label: 'Débit', align: 'r', render: (a) => (n(a.debit) ? money(a.debit, { cur: false }) : '') }, { label: 'Crédit', align: 'r', render: (a) => (n(a.credit) ? money(a.credit, { cur: false }) : '') },
        { label: 'Solde', align: 'r', render: (a) => (n(a.debit) || n(a.credit) ? money(n(a.debit) - n(a.credit), { cur: false }) : '') },
        { label: '', render: (a) => (canEdit() ? html`<button class="btn ghost small" data-edit="${a.id}">Modifier</button>` : '') }], rows: list,
    }));
  };
  const reload = async () => { rows = await get('/api/accounts'); draw($('#f-q', view).value); };
  $('#f-q', view).oninput = (e) => draw(e.target.value);
  on(view, 'click', '[data-edit]', (e, b) => {
    const a = rows.find((x) => x.id === Number(b.dataset.edit));
    modal({
      title: `Compte ${a.code}`, body: html`<form id="ac-form" class="grid">${field('Intitulé', input('name', a.name, 'required'))}</form>`,
      actions: [{ label: 'Supprimer', kind: 'danger', onClick: async () => { await del('/api/accounts/' + a.id); toast('Compte supprimé'); reload().catch(fail); } },
        { label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => { await put('/api/accounts/' + a.id, formData($('#ac-form', m.el))); toast('Compte enregistré'); reload().catch(fail); } }],
    });
  });
  const nb = document.getElementById('new');
  if (nb) nb.onclick = () => modal({
    title: 'Nouveau compte', body: html`<form id="ac-form" class="grid">${field('Numéro', input('code', '', 'required inputmode="numeric"'))}${field('Intitulé', input('name', '', 'required'))}</form>`,
    actions: [{ label: 'Annuler' }, { label: 'Créer', kind: 'primary', onClick: async (m) => { await post('/api/accounts', formData($('#ac-form', m.el))); toast('Compte créé'); reload().catch(fail); } }],
  });
  draw();
});

export { moneyText, paymentDetail };
