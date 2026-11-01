// Mouvements de stock
import { html, route, get, setTop, money, date, n, fmt3, qs, fail, table, downloadCsv, csvNum, icon, ref, combo, $ } from '../core.js';

const KINDS = { initial: 'Stock initial', livraison: 'Livraison client', vente: 'Vente (facture)', 'retour client': 'Retour client', réception: 'Réception fournisseur', achat: 'Achat (facture)', 'retour fournisseur': 'Retour fournisseur', inventaire: 'Inventaire', annulation: 'Annulation' };

route('/stock/mouvements', async (view, p, q) => {
  setTop('Mouvements de stock');
  const [summary, products] = await Promise.all([get('/api/stock/summary'), ref('products')]);
  const f = { product_id: q.article || '', from: '', to: '' };
  const sel = products.find((x) => x.id === Number(f.product_id));
  view.innerHTML = String(html`
    <div class="kpis" style="margin-bottom:18px">
      <div class="kpi"><div class="label">Valeur du stock</div><div class="value">${money(summary.value, { cls: 'amt-xl' })}</div><div class="sub">Au coût moyen pondéré</div></div>
      <a class="kpi ${summary.alerts ? 'alert' : ''}" href="#/articles?alertes=1" style="text-decoration:none;color:inherit"><div class="label">Sous le stock minimum</div><div class="value amt-xl">${summary.alerts}</div><div class="sub">sur ${summary.items} articles stockés</div></a>
      <div class="kpi"><div class="label">Stocks négatifs</div><div class="value amt-xl">${summary.negatives}</div><div class="sub">À corriger par un inventaire ou une réception</div></div>
    </div>
    <div class="toolbar"><div class="search">${icon('search')}<input id="f-prod" placeholder="Filtrer par article…" value="${sel ? sel.name : ''}"></div>
      <input type="date" id="f-from" aria-label="Du"><input type="date" id="f-to" aria-label="Au">
      <button class="btn" id="export">${icon('download', 16)} Exporter</button></div>
    <div class="panel" id="list"></div>`);
  let rows = [];
  const load = async () => {
    rows = await get('/api/stock/moves' + qs(f));
    $('#list', view).innerHTML = String(table({
      columns: [
        { label: 'Date', render: (r) => date(r.date) },
        { label: 'Article', render: (r) => html`<span class="strong">${r.product_name}</span><div class="muted small">${r.product_code}</div>` },
        { label: 'Mouvement', render: (r) => html`${KINDS[r.kind] || r.kind}${r.note ? html`<div class="muted small">${r.note}</div>` : ''}` },
        { label: 'Pièce', render: (r) => (r.document_id ? html`<a href="#/document/${r.document_id}">${r.ref}</a>` : r.ref || '') },
        { label: 'Quantité', align: 'r', render: (r) => html`<span style="color:${n(r.qty) < 0 ? 'var(--grenade)' : 'var(--olive)'};font-weight:600">${n(r.qty) > 0 ? '+' : ''}${fmt3(r.qty).replace(/,000$/, '')}</span> ${r.unit}` },
        { label: 'Coût unitaire', align: 'r', render: (r) => money(r.unit_cost, { cur: false }) },
      ], rows, empty: 'Aucun mouvement sur la période.',
    }));
  };
  const input = $('#f-prod', view);
  combo(input, { items: () => products, getLabel: (x) => x.name, getSub: (x) => x.code, onPick: (x) => { f.product_id = x.id; load().catch(fail); } });
  input.addEventListener('input', () => { if (!input.value) { f.product_id = ''; load().catch(fail); } });
  $('#f-from', view).onchange = (e) => { f.from = e.target.value; load().catch(fail); };
  $('#f-to', view).onchange = (e) => { f.to = e.target.value; load().catch(fail); };
  $('#export', view).onclick = () => downloadCsv('mouvements-stock.csv', ['Date', 'Code', 'Article', 'Mouvement', 'Pièce', 'Quantité', 'Coût unitaire'],
    rows.map((r) => [date(r.date), r.product_code, r.product_name, KINDS[r.kind] || r.kind, r.ref, csvNum(r.qty), csvNum(r.unit_cost)]));
  await load();
});
