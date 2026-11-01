// Clients, fournisseurs, articles + import CSV
import {
  html, raw, esc, route, get, post, put, del, go, setTop, money, moneyText, date, today, n, fmt3, fmt2, qs, toast, fail, modal, confirmBox, table, bindRowLinks,
  downloadCsv, csvNum, parseCsv, icon, canEdit, clearRef, $, on, formData, field, input, select, textarea,
} from '../core.js';
import { statusChip, docLabel } from './documents.js';
import { openPaymentModal, openReminderModal, waLink, METHODS } from './recovery.js';

const CFG = {
  customers: { path: 'clients', title: 'Clients', one: 'client', side: 'sale', api: 'customers' },
  suppliers: { path: 'fournisseurs', title: 'Fournisseurs', one: 'fournisseur', side: 'purchase', api: 'suppliers' },
};

function partnerForm(p = {}, kind = 'customers') {
  return html`<form class="grid" id="pt-form" autocomplete="off">
    <div class="grid c3">${field('Nom ou raison sociale', input('name', p.name, 'required'), '', 'span-2')}${field('Code', input('code', p.code, 'placeholder="automatique"'))}</div>
    <div class="grid c3">${field('Matricule fiscal', input('tax_id', p.tax_id))}${field('Téléphone', input('phone', p.phone, 'type="tel"'))}${field('WhatsApp', input('whatsapp', p.whatsapp, 'type="tel"'), 'si différent')}</div>
    <div class="grid c3">${field('E-mail', input('email', p.email, 'type="email"'))}${field('Contact', input('contact', p.contact), 'nom de l\'interlocuteur')}${field('Ville', input('city', p.city))}</div>
    ${field('Adresse', input('address', p.address))}
    <div class="grid c3">${field('Délai de paiement (jours)', input('terms', p.terms ?? 30, 'type="number" min="0"'))}
      ${kind === 'customers' ? field('Plafond d\'encours (DT)', input('credit_limit', p.credit_limit ? fmt3(p.credit_limit) : '', 'class="num" inputmode="decimal"'), '0 = aucun') : html`<div></div>`}
      ${p.id ? html`<label class="check" style="align-self:end"><input type="checkbox" name="active" ${p.active !== false ? raw('checked') : ''}> Actif</label>` : html`<div></div>`}</div>
    ${field('Notes internes', textarea('notes', p.notes, 'rows="2"'))}
  </form>`;
}
const cleanPartner = (f) => ({ ...f, credit_limit: String(f.credit_limit || '').replace(/\s/g, '').replace(',', '.') || 0 });

export function quickPartner(side, onCreated) {
  const kind = side === 'sale' ? 'customers' : 'suppliers';
  modal({
    title: side === 'sale' ? 'Nouveau client' : 'Nouveau fournisseur', wide: true, body: partnerForm({}, kind),
    actions: [{ label: 'Annuler' }, { label: 'Créer', kind: 'primary', onClick: async (m) => {
      const p = await post('/api/' + kind, cleanPartner(formData($('#pt-form', m.el))));
      clearRef(kind); toast(`${p.name} créé`); onCreated(p);
    } }],
  });
}

// ---------- Import CSV ----------
const IMPORT_MAP = {
  customers: { code: ['code', 'code client', 'référence', 'reference'], name: ['nom', 'name', 'raison sociale', 'client', 'société', 'societe'], tax_id: ['matricule', 'matricule fiscal', 'mf', 'tax_id'], address: ['adresse', 'address'], city: ['ville', 'city'], phone: ['téléphone', 'telephone', 'tel', 'tél', 'phone', 'gsm', 'mobile'], whatsapp: ['whatsapp'], email: ['email', 'e-mail', 'mail'], contact: ['contact', 'interlocuteur'], terms: ['délai', 'delai', 'délai de paiement', 'terms'], credit_limit: ['plafond', 'credit_limit', 'plafond encours'] },
  products: { code: ['code', 'référence', 'reference', 'ref', 'code article'], name: ['désignation', 'designation', 'nom', 'libellé', 'libelle', 'article', 'name'], family: ['famille', 'catégorie', 'categorie', 'family'], unit: ['unité', 'unite', 'unit'], kind: ['type', 'nature', 'kind'], sale_price: ['prix de vente', 'prix vente', 'pv', 'prix ht', 'prix', 'sale_price'], purchase_price: ['prix d\'achat', 'prix achat', 'pa', 'coût', 'cout', 'purchase_price'], vat_rate: ['tva', 'taux tva', 'vat', 'vat_rate'], stock: ['stock', 'quantité', 'quantite', 'qté', 'qte'], min_stock: ['stock min', 'stock minimum', 'min_stock', 'seuil'] },
};
IMPORT_MAP.suppliers = IMPORT_MAP.customers;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function openImport(kind, onDone) {
  const map = IMPORT_MAP[kind];
  const label = { customers: 'clients', suppliers: 'fournisseurs', products: 'articles' }[kind];
  const m = modal({
    title: `Importer des ${label}`, wide: true,
    body: html`<p>Depuis Excel ou Sage, enregistrez votre liste au format <b>CSV</b>, puis choisissez le fichier. La première ligne doit contenir les titres de colonnes.</p>
      <p class="small muted">Colonnes reconnues : ${Object.values(map).map((a) => a[0]).join(', ')}. Une ligne dont le code existe déjà met la fiche à jour.</p>
      <div class="row"><input type="file" id="csv-file" accept=".csv,.txt,text/csv" style="height:auto;padding:8px"><button class="btn small" id="tpl">${icon('download', 16)} Modèle de fichier</button></div>
      <div id="csv-preview" style="margin-top:14px"></div>`,
    actions: [{ label: 'Annuler' }, { label: 'Importer', kind: 'primary', onClick: async () => {
      if (!rows.length) throw new Error('Choisissez un fichier contenant au moins une ligne.');
      const r = await post('/api/import/' + kind, { rows });
      toast(`${r.created} créé${r.created > 1 ? 's' : ''}, ${r.updated} mis à jour${r.errors.length ? `, ${r.errors.length} ligne(s) ignorée(s)` : ''}`, r.errors.length ? '' : 'success');
      if (r.errors.length) modal({ title: 'Lignes ignorées', body: html`<ul>${r.errors.map((e) => html`<li>${e}</li>`)}</ul>` });
      clearRef(kind); onDone();
    } }],
  });
  let rows = [];
  $('#tpl', m.el).onclick = () => downloadCsv(`modele-${label}.csv`, Object.values(map).map((a) => a[0]), [[]]);
  $('#csv-file', m.el).onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    const data = parseCsv(text);
    if (data.length < 2) { $('#csv-preview', m.el).innerHTML = '<p class="muted">Fichier vide.</p>'; return; }
    const headers = data[0].map(norm);
    const colFor = {};
    for (const [key, names] of Object.entries(map)) { const i = headers.findIndex((h) => names.includes(h)); if (i >= 0) colFor[key] = i; }
    rows = data.slice(1).map((r) => Object.fromEntries(Object.entries(colFor).map(([k, i]) => [k, (r[i] || '').trim()])));
    const keys = Object.keys(colFor);
    $('#csv-preview', m.el).innerHTML = keys.length ? String(html`<p><b>${rows.length}</b> ligne(s) lue(s). Aperçu :</p>${table({ stack: false, columns: keys.map((k) => ({ label: map[k][0], key: k })), rows: rows.slice(0, 5) })}`)
      : '<p class="muted">Aucune colonne reconnue : vérifiez les titres de la première ligne.</p>';
  };
}

// ---------- Listes clients / fournisseurs ----------
function partnerList(kind) {
  const c = CFG[kind];
  route('/' + c.path, async (view) => {
    setTop(c.title, canEdit() ? html`<button class="btn" id="import">${icon('upload', 16)} Importer</button><button class="btn primary" id="new">${icon('plus', 16)} Nouveau ${c.one}</button>` : '');
    view.innerHTML = String(html`<div class="toolbar"><div class="search">${icon('search')}<input id="f-q" placeholder="Nom, code, téléphone, ville…"></div>
      <label class="check"><input type="checkbox" id="f-all"> Afficher les inactifs</label><button class="btn" id="export">${icon('download', 16)} Exporter</button></div>
      <div class="panel" id="list"></div>`);
    let rows = [];
    const f = { q: '', active: '' };
    const load = async () => {
      rows = await get(`/api/${c.api}` + qs(f));
      $('#list', view).innerHTML = String(table({
        columns: [
          { label: 'Code', render: (r) => html`<span class="muted">${r.code}</span>` },
          { label: 'Nom', render: (r) => html`<span class="strong">${r.name}</span>${!r.active ? html` <span class="chip off">Inactif</span>` : ''}${r.tax_id ? html`<div class="muted small">MF ${r.tax_id}</div>` : ''}` },
          { label: 'Ville', key: 'city' },
          { label: 'Téléphone', key: 'phone' },
          { label: 'Délai', align: 'r', render: (r) => `${r.terms} j` },
          { label: kind === 'customers' ? 'Encours' : 'Solde dû', align: 'r', render: (r) => (n(r.balance) ? html`${money(r.balance)}${n(r.credit_limit) > 0 && n(r.balance) > n(r.credit_limit) ? html`<div class="small" style="color:var(--grenade)">au-delà du plafond</div>` : ''}` : html`<span class="muted">—</span>`) },
        ], rows, href: (r) => `/${c.path}/${r.id}`,
        foot: rows.length ? [`${rows.length}`, '', '', '', '', money(rows.reduce((s, r) => s + n(r.balance), 0))] : null,
        empty: html`<p>Aucun ${c.one} pour l'instant.</p>${canEdit() ? html`<button class="btn primary" data-new>Ajouter un ${c.one}</button>` : ''}`,
      }));
    };
    let timer;
    $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; load().catch(fail); }, 250); };
    $('#f-all', view).onchange = (e) => { f.active = e.target.checked ? 'all' : ''; load().catch(fail); };
    $('#export', view).onclick = () => downloadCsv(`${c.path}.csv`, ['code', 'nom', 'matricule fiscal', 'adresse', 'ville', 'téléphone', 'whatsapp', 'email', 'contact', 'délai', 'plafond', 'encours'],
      rows.map((r) => [r.code, r.name, r.tax_id, r.address, r.city, r.phone, r.whatsapp, r.email, r.contact, r.terms, csvNum(r.credit_limit), csvNum(r.balance)]));
    const create = () => quickPartner(c.side, (p) => go(`/${c.path}/${p.id}`));
    on(view, 'click', '[data-new]', create);
    const nb = document.getElementById('new'); if (nb) nb.onclick = create;
    const ib = document.getElementById('import'); if (ib) ib.onclick = () => openImport(kind, () => load().catch(fail));
    bindRowLinks(view);
    await load();
  });

  // Fiche
  route(`/${c.path}/:id`, async (view, p, q) => {
    const tab = q.onglet || 'releve';
    const t = await get(`/api/${c.api}/${p.id}`);
    const isC = kind === 'customers';
    const acts = [];
    if (canEdit()) {
      acts.push(html`<button class="btn" id="edit">Modifier la fiche</button>`);
      if (isC) acts.push(html`<a class="btn" href="#/nouveau/sale/devis?tiers=${t.id}">Devis</a><a class="btn" href="#/nouveau/sale/facture?tiers=${t.id}">Facture</a>`);
      else acts.push(html`<a class="btn" href="#/nouveau/purchase/commande?tiers=${t.id}">Commande</a><a class="btn" href="#/nouveau/purchase/facture?tiers=${t.id}">Facture fournisseur</a>`);
      acts.push(html`<button class="btn success" id="pay">${isC ? 'Encaisser' : 'Payer'}</button>`);
    }
    setTop(t.name, acts);
    const wa = t.whatsapp || t.phone;
    view.innerHTML = String(html`<div class="stack">
      <div class="panel"><div class="panel-body row between" style="align-items:flex-start">
        <dl class="dl">
          <dt>Code</dt><dd>${t.code}</dd>
          ${t.tax_id ? html`<dt>Matricule fiscal</dt><dd>${t.tax_id}</dd>` : ''}
          ${t.address || t.city ? html`<dt>Adresse</dt><dd>${[t.address, t.city].filter(Boolean).join(', ')}</dd>` : ''}
          ${t.contact ? html`<dt>Contact</dt><dd>${t.contact}</dd>` : ''}
          <dt>Délai de paiement</dt><dd>${t.terms} jours</dd>
          ${isC && n(t.credit_limit) ? html`<dt>Plafond d'encours</dt><dd>${money(t.credit_limit)}</dd>` : ''}
          ${t.notes ? html`<dt>Notes</dt><dd>${t.notes}</dd>` : ''}
        </dl>
        <div style="text-align:right">
          <div class="muted small">${isC ? 'Encours' : 'Solde dû'}</div>${money(t.balance, { cls: 'amt-xl' })}
          <div class="row" style="justify-content:flex-end;margin-top:10px">
            ${t.phone ? html`<a class="btn small" href="tel:${t.phone}">${icon('phone', 16)} ${t.phone}</a>` : ''}
            ${wa ? html`<a class="btn small" target="_blank" rel="noopener" href="${waLink(wa, 'Bonjour,')}">${icon('chat', 16)} WhatsApp</a>` : ''}
            ${t.email ? html`<a class="btn small" href="mailto:${t.email}">${icon('mail', 16)} E-mail</a>` : ''}
            ${isC && n(t.balance) > 0 && canEdit() ? html`<button class="btn small primary" id="remind">Relancer</button>` : ''}
          </div>
        </div>
      </div></div>
      <div class="tabs">
        <a href="#/${c.path}/${t.id}?onglet=releve" class="${tab === 'releve' ? 'on' : ''}">Relevé de compte</a>
        <a href="#/${c.path}/${t.id}?onglet=documents" class="${tab === 'documents' ? 'on' : ''}">Documents</a>
        <a href="#/${c.path}/${t.id}?onglet=reglements" class="${tab === 'reglements' ? 'on' : ''}">${isC ? 'Règlements' : 'Paiements'}</a>
        ${isC ? html`<a href="#/${c.path}/${t.id}?onglet=relances" class="${tab === 'relances' ? 'on' : ''}">Relances</a>` : ''}
      </div>
      <div class="panel" id="tab"><div class="loading">Chargement…</div></div>
    </div>`);
    const box = $('#tab', view);
    if (tab === 'releve') {
      const st = await get(`/api/${c.api}/${t.id}/statement`);
      box.innerHTML = String(html`<div class="panel-head"><span class="muted small">Factures, avoirs et règlements, du plus ancien au plus récent</span><button class="btn small" id="st-print">${icon('print', 16)} Imprimer le relevé</button></div>${table({
        columns: [
          { label: 'Date', render: (l) => date(l.date) },
          { label: 'Opération', render: (l) => (l.kind === 'document' ? html`<a href="#/document/${l.id}">${l.label}</a>${l.due_date ? html`<div class="muted small">échéance ${date(l.due_date)}${n(l.open) > 0.0005 && isC ? html`, reste ${money(l.open, { cur: false })}` : ''}</div>` : ''}` : l.label) },
          { label: 'Débit', align: 'r', render: (l) => (n(l.debit) ? money(l.debit, { cur: false }) : '') },
          { label: 'Crédit', align: 'r', render: (l) => (n(l.credit) ? money(l.credit, { cur: false }) : '') },
          { label: 'Solde', align: 'r', render: (l) => money(l.balance) },
        ], rows: st.lines, empty: 'Aucune opération.',
      })}`);
      $('#st-print', view).onclick = async () => {
        const co = await get('/api/company');
        const w = window.open('', '_blank');
        if (!w) return fail(new Error('Autorisez les fenêtres pour imprimer.'));
        w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Relevé ${esc(t.name)}</title><style>body{font:13px/1.5 system-ui,sans-serif;max-width:190mm;margin:14mm auto;color:#111}table{width:100%;border-collapse:collapse}th,td{padding:6px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}h1{font-size:20px}</style></head><body>
          <b>${esc(co.name)}</b><br>${esc(co.address || '')} ${esc(co.city || '')}<h1>Relevé de compte – ${esc(t.name)}</h1><p>Au ${date(new Date().toISOString())}</p>
          <table><tr><th>Date</th><th>Opération</th><th class="r">Débit</th><th class="r">Crédit</th><th class="r">Solde</th></tr>
          ${st.lines.map((l) => `<tr><td>${date(l.date)}</td><td>${esc(l.label)}</td><td class="r">${n(l.debit) ? fmt3(l.debit) : ''}</td><td class="r">${n(l.credit) ? fmt3(l.credit) : ''}</td><td class="r">${fmt3(l.balance)}</td></tr>`).join('')}
          </table><p style="text-align:right;font-size:15px"><b>Solde : ${moneyText(st.balance)}</b></p><script>window.print()<\/script></body></html>`);
        w.document.close();
      };
    } else if (tab === 'documents') {
      const docs = await get('/api/documents' + qs({ side: c.side, partner_id: t.id }));
      box.innerHTML = String(table({
        columns: [
          { label: 'Document', render: (d) => html`<span class="strong">${docLabel(c.side, d.type)}</span> ${d.number || 'brouillon'}` },
          { label: 'Date', render: (d) => date(d.date) }, { label: 'Statut', render: (d) => statusChip(d) },
          { label: 'Total TTC', align: 'r', render: (d) => money(d.total_ttc) },
        ], rows: docs, href: (d) => '/document/' + d.id, empty: 'Aucun document.',
      }));
    } else if (tab === 'reglements') {
      const pays = await get('/api/payments' + qs({ side: isC ? 'in' : 'out', partner_id: t.id }));
      box.innerHTML = String(table({
        columns: [{ label: 'N°', key: 'number' }, { label: 'Date', render: (r) => date(r.date) }, { label: 'Mode', render: (r) => `${METHODS[r.method] || r.method}${r.reference ? ' n° ' + r.reference : ''}` },
          { label: 'Statut', render: (r) => (r.status === 'valide' ? '' : r.status === 'impaye' ? html`<span class="chip bad">Impayé</span>` : html`<span class="chip off">Annulé</span>`) },
          { label: 'Montant', align: 'r', render: (r) => money(r.amount) }], rows: pays, empty: 'Aucun règlement.',
      }));
    } else {
      const rem = await get('/api/reminders' + qs({ customer_id: t.id }));
      box.innerHTML = String(table({
        columns: [{ label: 'Date', render: (r) => date(r.date) }, { label: 'Canal', key: 'channel' }, { label: 'Niveau', render: (r) => ['', 'Amiable', 'Ferme', 'Mise en demeure'][r.level] },
          { label: 'Compte rendu', render: (r) => r.note || '' }, { label: 'Promesse', render: (r) => (r.promise_date ? html`${date(r.promise_date)} ${r.promise_amount ? money(r.promise_amount) : ''}` : '') },
          { label: 'Par', render: (r) => r.user_name || '' }], rows: rem, empty: 'Aucune relance.',
      }));
    }
    bindRowLinks(view);
    const top = document.getElementById('top-actions');
    const eb = top.querySelector('#edit');
    if (eb) eb.onclick = () => modal({
      title: `Modifier ${t.name}`, wide: true, body: partnerForm(t, kind),
      actions: [{ label: 'Supprimer', kind: 'danger', onClick: async () => {
        if (!(await confirmBox(`Supprimer ${t.name} ? S'il a des documents, la fiche sera seulement désactivée.`, { ok: 'Supprimer', danger: true }))) return false;
        const r = await del(`/api/${c.api}/${t.id}`); clearRef(c.api);
        toast(r.archived ? 'Fiche désactivée (des documents y sont liés)' : 'Fiche supprimée'); go('/' + c.path);
      } }, { label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => {
        await put(`/api/${c.api}/${t.id}`, cleanPartner(formData($('#pt-form', m.el)))); clearRef(c.api); toast('Fiche enregistrée'); go(location.hash.slice(1));
      } }],
    });
    const pb = top.querySelector('#pay');
    if (pb) pb.onclick = () => openPaymentModal({ side: isC ? 'in' : 'out', partner_id: t.id, partner_name: t.name, onDone: () => go(location.hash.slice(1)) });
    const rb = view.querySelector('#remind');
    if (rb) rb.onclick = () => openReminderModal({ customer: t, onDone: () => go(location.hash.slice(1)) });
  });
}
partnerList('customers');
partnerList('suppliers');

// ---------- Articles ----------
function productForm(p = {}) {
  return html`<form class="grid" id="pr-form" autocomplete="off">
    <div class="grid c3">${field('Désignation', input('name', p.name, 'required'), '', 'span-2')}${field('Code', input('code', p.code, 'placeholder="automatique"'))}</div>
    <div class="grid c3">${field('Type', select('kind', [['stock', 'Article stocké'], ['service', 'Service']], p.kind || 'stock'))}${field('Famille', input('family', p.family))}${field('Unité', input('unit', p.unit || 'U'), 'U, kg, m, h…')}</div>
    <div class="grid c3">${field('Prix de vente HT', input('sale_price', p.sale_price !== undefined ? fmt3(p.sale_price) : '', 'class="num" inputmode="decimal"'))}
      ${field('Prix d\'achat HT', input('purchase_price', p.purchase_price !== undefined ? fmt3(p.purchase_price) : '', 'class="num" inputmode="decimal"'))}
      ${field('TVA', select('vat_rate', [[19, '19 %'], [13, '13 %'], [7, '7 %'], [0, '0 % (exonéré)']], p.vat_rate !== undefined ? n(p.vat_rate) : 19))}</div>
    <div class="grid c3">${p.id ? html`<div>${field('Stock actuel', raw(`<input value="${fmt3(p.stock)}" disabled class="num">`), 'modifiable par inventaire')}</div>` : field('Stock initial', input('stock', '', 'class="num" inputmode="decimal"'))}
      ${field('Stock minimum', input('min_stock', p.min_stock ? fmt3(p.min_stock) : '', 'class="num" inputmode="decimal"'), 'alerte en dessous')}
      ${p.id ? html`<label class="check" style="align-self:end"><input type="checkbox" name="active" ${p.active !== false ? raw('checked') : ''}> Actif</label>` : html`<div></div>`}</div>
  </form>`;
}
const cleanNum = (o, keys) => { keys.forEach((k) => { if (o[k] !== undefined) o[k] = String(o[k]).replace(/\s/g, '').replace(',', '.'); }); return o; };

export function openProduct(p, onDone) {
  const actions = [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => {
    const f = cleanNum(formData($('#pr-form', m.el)), ['sale_price', 'purchase_price', 'stock', 'min_stock']);
    if (p && p.id) await put('/api/products/' + p.id, f); else await post('/api/products', f);
    clearRef('products'); toast('Article enregistré'); onDone();
  } }];
  if (p && p.id) actions.unshift({ label: 'Supprimer', kind: 'danger', onClick: async () => {
    if (!(await confirmBox(`Supprimer ${p.name} ? S'il est utilisé dans des documents, il sera seulement désactivé.`, { ok: 'Supprimer', danger: true }))) return false;
    const r = await del('/api/products/' + p.id); clearRef('products'); toast(r.archived ? 'Article désactivé' : 'Article supprimé'); onDone();
  } });
  modal({ title: p && p.id ? p.name : 'Nouvel article', wide: true, body: productForm(p || {}), actions });
}

route('/articles', async (view, p, q) => {
  setTop('Articles et services', canEdit() ? html`<button class="btn" id="import">${icon('upload', 16)} Importer</button><button class="btn primary" id="new">${icon('plus', 16)} Nouvel article</button>` : '');
  view.innerHTML = String(html`<div class="toolbar"><div class="search">${icon('search')}<input id="f-q" placeholder="Désignation, code, famille…"></div>
    <label class="check"><input type="checkbox" id="f-alerts" ${q.alertes ? raw('checked') : ''}> Sous le stock minimum</label>
    <label class="check"><input type="checkbox" id="f-all"> Inactifs</label>
    <button class="btn" id="export">${icon('download', 16)} Exporter</button></div><div class="panel" id="list"></div>`);
  const f = { q: '', alerts: q.alertes ? 1 : '', active: '' };
  let rows = [];
  const load = async () => {
    rows = await get('/api/products' + qs(f));
    $('#list', view).innerHTML = String(table({
      columns: [
        { label: 'Code', render: (r) => html`<span class="muted">${r.code}</span>` },
        { label: 'Désignation', render: (r) => html`<span class="strong">${r.name}</span>${!r.active ? html` <span class="chip off">Inactif</span>` : ''}<div class="muted small">${[r.family, r.kind === 'service' ? 'Service' : null].filter(Boolean).join(', ')}</div>` },
        { label: 'Prix de vente HT', align: 'r', render: (r) => money(r.sale_price, { cur: false }) },
        { label: 'TVA', align: 'r', render: (r) => fmt2(r.vat_rate) + ' %' },
        { label: 'Coût moyen', align: 'r', render: (r) => (r.kind === 'stock' ? money(r.avg_cost, { cur: false }) : '') },
        { label: 'Stock', align: 'r', render: (r) => (r.kind === 'stock' ? html`<span class="${n(r.stock) <= n(r.min_stock) ? 'chip ' + (n(r.stock) <= 0 ? 'bad' : 'late') : ''}">${fmt3(r.stock).replace(/,000$/, '')} ${r.unit}</span>` : html`<span class="muted">—</span>`) },
        { label: '', render: (r) => (canEdit() && r.kind === 'stock' ? html`<button class="btn small" data-inv="${r.id}">Inventaire</button>` : '') },
      ], rows, href: (r) => '#' + r.id,
      empty: html`<p>Aucun article.</p>${canEdit() ? html`<button class="btn primary" data-new>Créer un article</button>` : ''}`,
    }));
  };
  on(view, 'click', 'tr[data-href]', (e, tr) => {
    if (e.target.closest('button')) return;
    const pr = rows.find((r) => r.id === Number(tr.dataset.href.slice(1)));
    if (canEdit()) openProduct(pr, () => load().catch(fail)); else go('/stock/mouvements?article=' + pr.id);
  });
  on(view, 'click', '[data-inv]', (e, b) => {
    const pr = rows.find((r) => r.id === Number(b.dataset.inv));
    modal({
      title: `Inventaire : ${pr.name}`,
      body: html`<form id="inv-form" class="grid"><p>Stock théorique : <b>${fmt3(pr.stock)} ${pr.unit}</b></p>
        ${field('Quantité comptée', input('counted', '', 'class="num" inputmode="decimal" required'))}${field('Date', input('date', today(), 'type="date"'))}${field('Motif', input('note', '', 'placeholder="Casse, erreur de saisie…"'))}</form>`,
      actions: [{ label: 'Annuler' }, { label: 'Enregistrer l\'écart', kind: 'primary', onClick: async (m) => {
        const fd = formData($('#inv-form', m.el));
        const r = await post('/api/stock/adjust', { product_id: pr.id, counted: String(fd.counted).replace(',', '.'), date: fd.date, note: fd.note });
        toast(r.delta ? `Écart de ${fmt3(r.delta)} enregistré` : 'Aucun écart'); clearRef('products'); load().catch(fail);
      } }],
    });
  });
  let timer;
  $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value; load().catch(fail); }, 250); };
  $('#f-alerts', view).onchange = (e) => { f.alerts = e.target.checked ? 1 : ''; load().catch(fail); };
  $('#f-all', view).onchange = (e) => { f.active = e.target.checked ? 'all' : ''; load().catch(fail); };
  $('#export', view).onclick = () => downloadCsv('articles.csv', ['code', 'désignation', 'famille', 'unité', 'type', 'prix de vente', 'prix d\'achat', 'tva', 'stock', 'stock min', 'coût moyen'],
    rows.map((r) => [r.code, r.name, r.family, r.unit, r.kind, csvNum(r.sale_price), csvNum(r.purchase_price), fmt2(r.vat_rate), csvNum(r.stock), csvNum(r.min_stock), csvNum(r.avg_cost)]));
  const create = () => openProduct(null, () => load().catch(fail));
  on(view, 'click', '[data-new]', create);
  const nb = document.getElementById('new'); if (nb) nb.onclick = create;
  const ib = document.getElementById('import'); if (ib) ib.onclick = () => openImport('products', () => load().catch(fail));
  await load();
});

export { raw, moneyText };
