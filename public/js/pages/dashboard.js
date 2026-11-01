// Tableau de bord
import { html, raw, route, get, setTop, money, moneyText, date, n, fmt0, esc, bindRowLinks, canEdit, hashQuery } from '../core.js';
import { docLabel, statusChip } from './documents.js';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

// Histogramme simple (une série) avec info-bulle
export function barChart(points, { height = 220, color = '#1D63A3', valueLabel = (v) => v } = {}) {
  const W = 640; const H = height; const left = 46; const bottom = 26; const top = 12;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = niceStep(max / 4);
  const yMax = Math.ceil(max / step) * step;
  const band = (W - left) / points.length;
  const bw = Math.min(24, band * 0.6);
  const y = (v) => top + (H - top - bottom) * (1 - v / yMax);
  const ticks = [];
  for (let v = 0; v <= yMax + 0.001; v += step) ticks.push(v);
  const tickLabel = (v) => (yMax >= 10000 ? fmt0(v / 1000) + 'k' : fmt0(v));
  const bars = points.map((p, i) => {
    const x = left + band * i + (band - bw) / 2;
    const h = Math.max(0, y(0) - y(Math.max(0, p.value)));
    const r = Math.min(4, h);
    const path = h > 0 ? `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + bw - r} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + r} V${y(0)} Z` : '';
    return `<g class="bar" data-i="${i}"><rect x="${left + band * i}" y="${top}" width="${band}" height="${H - top - bottom}" fill="transparent"/>${path ? `<path d="${path}" fill="${color}"/>` : ''}
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#7A8896">${esc(p.label)}</text></g>`;
  }).join('');
  const grid = ticks.map((v) => `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="#E6EBF0" stroke-width="1"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#7A8896">${tickLabel(v)}</text>`).join('');
  const id = 'c' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const root = document.getElementById(id);
    if (!root) return;
    const tip = root.querySelector('.tip');
    root.querySelectorAll('.bar').forEach((g) => {
      const show = () => {
        const p = points[+g.dataset.i];
        tip.innerHTML = `${esc(p.full || p.label)} : <b>${valueLabel(p.value)}</b>`;
        const rect = g.getBoundingClientRect(); const box = root.getBoundingClientRect();
        tip.style.left = (rect.left - box.left + rect.width / 2) + 'px';
        tip.style.top = (y(Math.max(0, p.value)) / H * box.height) + 'px';
        tip.style.opacity = 1;
      };
      g.addEventListener('mouseenter', show);
      g.addEventListener('click', show);
      g.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
    });
  });
  return raw(`<div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogramme">${grid}${bars}</svg><div class="tip"></div></div>`);
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

route('/tableau-de-bord', async (view) => {
  const [d, company] = await Promise.all([get('/api/dashboard'), get('/api/company')]);
  setTop('Tableau de bord', canEdit() ? html`<a class="btn" href="#/nouveau/sale/devis">Nouveau devis</a><a class="btn primary" href="#/nouveau/sale/facture">Nouvelle facture</a>` : '');
  // Série des 12 derniers mois
  const now = new Date();
  const series = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = dt.toISOString().slice(0, 7);
    const row = d.series.find((s) => s.month === key && s.side === 'sale');
    series.push({ label: MONTHS[dt.getUTCMonth()], full: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`, value: row ? n(row.ht) : 0 });
  }
  const evo = d.ca.prev_month ? Math.round((d.ca.month - d.ca.prev_month) / Math.abs(d.ca.prev_month) * 100) : null;
  const isNew = !d.recent.length;
  const q = hashQuery();
  const profileIncomplete = !company.tax_id || !company.address;

  view.innerHTML = String(html`
    ${isNew || q.bienvenue ? html`<div class="panel" style="margin-bottom:18px"><div class="panel-body">
      <h2>Bienvenue dans SEDDIK CRM</h2>
      <p class="text-2">Trois étapes pour émettre votre première facture :</p>
      <ol style="margin:0;padding-left:20px;line-height:2">
        <li><a href="#/parametres/entreprise">Compléter les informations de l'entreprise</a> ${profileIncomplete ? html`<span class="muted small">(matricule fiscal, adresse, RIB : ils apparaissent sur vos factures)</span>` : html`<span class="chip paid">fait</span>`}</li>
        <li><a href="#/clients">Ajouter vos clients</a> et <a href="#/articles">vos articles</a>, ou les importer depuis Excel</li>
        <li><a href="#/nouveau/sale/facture">Créer une facture</a> ou <a href="#/nouveau/sale/devis">un devis</a></li>
      </ol></div></div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="label">Chiffre d'affaires HT du mois</div><div class="value">${money(d.ca.month, { cls: 'amt-xl' })}</div>
        <div class="sub">${evo === null ? html`Depuis le 1er janvier : ${money(d.ca.year)}` : html`${evo >= 0 ? '+' : ''}${evo} % par rapport au mois dernier`}</div></div>
      <a class="kpi ${n(d.receivables.overdue) > 0 ? 'alert' : ''}" href="#/recouvrement" style="text-decoration:none;color:inherit"><div class="label">Encours clients</div><div class="value">${money(d.receivables.total, { cls: 'amt-xl' })}</div>
        <div class="sub">${n(d.receivables.overdue) > 0 ? html`dont ${money(d.receivables.overdue)} échus (${d.receivables.overdue_count} facture${d.receivables.overdue_count > 1 ? 's' : ''})` : 'Aucune facture échue'}</div></a>
      <a class="kpi" href="#/compta/tresorerie" style="text-decoration:none;color:inherit"><div class="label">Trésorerie (banque et caisse)</div><div class="value">${money(d.treasury, { cls: 'amt-xl' })}</div>
        <div class="sub">Selon les règlements enregistrés</div></a>
      <a class="kpi" href="#/achats/facture" style="text-decoration:none;color:inherit"><div class="label">Dettes fournisseurs</div><div class="value">${money(d.payables.total, { cls: 'amt-xl' })}</div>
        <div class="sub">${n(d.payables.overdue) > 0 ? html`dont ${money(d.payables.overdue)} échus` : 'Rien d\'échu'}</div></a>
    </div>
    <div class="dash-grid">
      <div class="panel"><div class="panel-head"><h2>Ventes HT sur 12 mois</h2><span class="muted small">Factures moins avoirs validés</span></div>
        <div class="panel-body">${series.some((s) => s.value) ? barChart(series, { valueLabel: (v) => esc(moneyText(v)) }) : html`<p class="muted" style="margin:0">Aucune vente validée sur les 12 derniers mois. Le graphique se remplira avec vos premières factures.</p>`}</div></div>
      <div class="panel"><div class="panel-head"><h2>À traiter</h2></div><div class="panel-body">
        <ul class="list">
          <li><a href="#/recouvrement/relances">Relances prévues aujourd'hui</a><b>${d.reminders_todo}</b></li>
          <li><a href="#/ventes/facture?filtre=echues">Factures clients échues</a><b>${d.receivables.overdue_count}</b></li>
          <li><a href="#/ventes/devis?statut=valide">Devis en attente de réponse</a><span>${d.pipeline.quotes} pour ${money(d.pipeline.quotes_amount)}</span></li>
          <li><a href="#/ventes/commande?statut=valide">Commandes à livrer ou facturer</a><span>${d.pipeline.orders} pour ${money(d.pipeline.orders_amount)}</span></li>
          <li><a href="#/articles?alertes=1">Articles sous le stock minimum</a><b>${d.stock.alerts}</b></li>
          <li><span>Valeur du stock (coût moyen)</span>${money(d.stock.value)}</li>
        </ul></div></div>
    </div>
    <div class="dash-grid">
      <div class="panel"><div class="panel-head"><h2>Derniers documents</h2></div><div class="panel-body flush" id="recent">
        ${d.recent.length ? html`<table class="data stackable"><tbody>${d.recent.map((r) => html`<tr class="click" data-href="/document/${r.id}">
          <td data-label="Document"><span class="strong">${docLabel(r.side, r.type)}</span> ${r.number || html`<span class="muted">brouillon</span>`}</td>
          <td data-label="Tiers">${r.partner_name}</td><td data-label="Date">${date(r.date)}</td>
          <td data-label="Statut">${statusChip(r)}</td><td class="r" data-label="Montant">${money(r.total_ttc)}</td></tr>`)}</tbody></table>`
          : html`<div class="empty">Aucun document pour l'instant.</div>`}
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Plus gros encours</h2><a class="small" href="#/recouvrement">Balance âgée</a></div><div class="panel-body">
        ${d.debtors.length ? html`<ul class="list">${d.debtors.map((c) => html`<li><span><a href="#/clients/${c.id}">${c.name}</a>${n(c.days) > 0 ? html` <span class="chip late">${c.days} j de retard</span>` : ''}</span>${money(c.open)}</li>`)}</ul>`
          : html`<p class="muted">Aucun client ne vous doit d'argent.</p>`}
      </div></div>
    </div>`);
  bindRowLinks(view);
});

export { raw };
