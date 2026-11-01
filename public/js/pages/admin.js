// Console de la plateforme SEDDIK CRM (super-administrateur)
import { html, raw, esc, route, get, post, put, go, setTop, money, date, n, fmt3, qs, toast, fail, modal, confirmBox, table, bindRowLinks, icon, $, on, formData, field, input, select, textarea } from '../core.js';
import { barChart } from './dashboard.js';

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const METHOD = { konnect: 'En ligne (Konnect)', virement: 'Virement', d17: 'D17', versement: 'Versement', especes: 'Espèces', cheque: 'Chèque' };
const PAY_STATUS = { pending: ['En attente', 'late'], paid: ['Validé', 'paid'], rejected: ['Refusé', 'bad'], failed: ['Échoué', 'bad'] };
const subChip = (s) => (s.access === 'suspended' ? html`<span class="chip bad">Suspendu</span>` : s.access === 'expired' ? html`<span class="chip bad">Expiré</span>`
  : s.is_trial ? html`<span class="chip late">Essai, ${s.days_left} j</span>` : html`<span class="chip paid">Abonné, ${s.days_left} j</span>`);

route('/admin', async (view) => {
  setTop('Vue d\'ensemble de la plateforme');
  const o = await get('/api/admin/overview');
  const now = new Date();
  const series = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const row = o.signups.find((s) => s.month === d.toISOString().slice(0, 7));
    series.push({ label: MONTHS[d.getUTCMonth()], full: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, value: row ? row.n : 0 });
  }
  view.innerHTML = String(html`<div class="kpis">
      <div class="kpi"><div class="label">Revenu mensuel récurrent estimé</div><div class="value">${money(o.stats.mrr, { cls: 'amt-xl' })}</div><div class="sub">${o.stats.paying} entreprise${o.stats.paying > 1 ? 's' : ''} abonnée${o.stats.paying > 1 ? 's' : ''}</div></div>
      <div class="kpi"><div class="label">Encaissé ce mois</div><div class="value">${money(o.revenue.month, { cls: 'amt-xl' })}</div><div class="sub">Depuis janvier : ${money(o.revenue.year)}</div></div>
      <a class="kpi" href="#/admin/entreprises" style="text-decoration:none;color:inherit"><div class="label">Entreprises inscrites</div><div class="value amt-xl">${o.stats.total}</div><div class="sub">${o.stats.trial} en essai, ${o.stats.expired} expirées, ${o.stats.suspended} suspendues</div></a>
      <a class="kpi ${o.pending ? 'alert' : ''}" href="#/admin/paiements" style="text-decoration:none;color:inherit"><div class="label">Paiements à valider</div><div class="value amt-xl">${o.pending}</div><div class="sub">Virements, D17, versements déclarés</div></a>
    </div>
    <div class="dash-grid">
      <div class="panel"><div class="panel-head"><h2>Nouvelles entreprises par mois</h2></div><div class="panel-body">${barChart(series, { valueLabel: (v) => `${v} inscription${v > 1 ? 's' : ''}` })}</div></div>
      <div class="panel"><div class="panel-head"><h2>Se terminent sous 7 jours</h2></div><div class="panel-body">
        ${o.expiring.length ? html`<ul class="list">${o.expiring.map((c) => html`<li><a href="#/admin/entreprise/${c.id}">${c.name}</a>${subChip(c.sub)}</li>`)}</ul>` : html`<p class="muted" style="margin:0">Aucun abonnement ne se termine cette semaine.</p>`}
      </div></div>
    </div>`);
}, { admin: true });

route('/admin/entreprises', async (view) => {
  setTop('Entreprises clientes');
  view.innerHTML = String(html`<div class="toolbar"><div class="search">${icon('search')}<input id="f-q" placeholder="Nom, e-mail, téléphone, matricule…"></div></div><div class="panel" id="list"></div>`);
  const load = async (q = '') => {
    const rows = await get('/api/admin/companies' + qs({ q }));
    $('#list', view).innerHTML = String(table({
      columns: [
        { label: 'Entreprise', render: (c) => html`<span class="strong">${c.name}</span><div class="muted small">${[c.city, c.tax_id].filter(Boolean).join(', ')}</div>` },
        { label: 'Responsable', render: (c) => (c.owner ? html`${c.owner.name}<div class="muted small">${c.owner.email}${c.owner.phone ? ', ' + c.owner.phone : ''}</div>` : '') },
        { label: 'Formule', key: 'plan_code' }, { label: 'Abonnement', render: (c) => subChip(c.subscription) },
        { label: 'Fin', render: (c) => date(c.subscription.ends_at) }, { label: 'Utilisateurs', align: 'r', key: 'users' }, { label: 'Documents', align: 'r', key: 'documents' },
        { label: 'Inscrite le', render: (c) => date(c.created_at) }, { label: 'Dernière connexion', render: (c) => date(c.last_login) },
      ], rows, href: (c) => '/admin/entreprise/' + c.id, empty: 'Aucune entreprise.',
    }));
  };
  let timer;
  $('#f-q', view).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value).catch(fail), 250); };
  bindRowLinks(view);
  await load();
}, { admin: true });

route('/admin/entreprise/:id', async (view, p) => {
  const c = await get('/api/admin/companies/' + p.id);
  const plans = await get('/api/admin/plans');
  setTop(c.name, html`<button class="btn" data-ext="30">+30 jours</button><button class="btn" data-ext="365">+1 an</button>
    ${c.status === 'suspended' ? html`<button class="btn success" id="unsuspend">Réactiver</button>` : html`<button class="btn danger" id="suspend">Suspendre</button>`}`);
  const toLocal = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  view.innerHTML = String(html`<div class="stack">
    <div class="grid c2">
      <div class="panel"><div class="panel-head"><h2>Abonnement</h2>${subChip(c.subscription)}</div><form class="panel-body grid" id="sub-form">
        <div class="grid c2">${field('Formule', select('plan_code', plans.map((pl) => [pl.code, pl.name]), c.plan_code))}${field('Statut', select('status', [['trial', 'Essai'], ['active', 'Actif'], ['suspended', 'Suspendu']], c.status))}</div>
        <div class="grid c2">${field('Fin de l\'essai', input('trial_ends_at', toLocal(c.trial_ends_at), 'type="date"'))}${field('Payé jusqu\'au', input('paid_until', toLocal(c.paid_until), 'type="date"'))}</div>
        <div><button class="btn primary" type="submit">Enregistrer</button></div></form></div>
      <div class="panel"><div class="panel-head"><h2>Coordonnées</h2></div><div class="panel-body"><dl class="dl">
        <dt>Matricule fiscal</dt><dd>${c.tax_id || '—'}</dd><dt>Adresse</dt><dd>${[c.address, c.city].filter(Boolean).join(', ') || '—'}</dd>
        <dt>Téléphone</dt><dd>${c.phone || '—'}</dd><dt>E-mail</dt><dd>${c.email || '—'}</dd><dt>Inscrite le</dt><dd>${date(c.created_at)}</dd></dl></div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Utilisateurs</h2></div>${table({
      columns: [{ label: 'Nom', render: (u) => html`<span class="strong">${u.name}</span>${!u.active ? html` <span class="chip off">Désactivé</span>` : ''}` }, { label: 'E-mail', key: 'email' }, { label: 'Téléphone', key: 'phone' }, { label: 'Rôle', key: 'role' },
        { label: 'Dernière connexion', render: (u) => date(u.last_login) }, { label: '', render: (u) => html`<button class="btn small" data-pw="${u.id}">Nouveau mot de passe</button>` }],
      rows: c.users,
    })}</div>
    <div class="panel"><div class="panel-head"><h2>Paiements</h2></div>${table({
      columns: [{ label: 'Date', render: (r) => date(r.created_at) }, { label: 'Formule', render: (r) => `${r.plan_code}, ${r.months} mois` }, { label: 'Mode', render: (r) => METHOD[r.method] || r.method },
        { label: 'Référence', key: 'reference' }, { label: 'Statut', render: (r) => html`<span class="chip ${PAY_STATUS[r.status][1]}">${PAY_STATUS[r.status][0]}</span>` }, { label: 'Montant', align: 'r', render: (r) => money(r.amount) }],
      rows: c.payments, empty: 'Aucun paiement.',
    })}</div>
    <div class="panel" style="border-color:#F0C9C5"><div class="panel-head"><h2 style="color:var(--grenade)">Supprimer l'entreprise</h2></div>
      <div class="panel-body row between">
        <p class="text-2" style="margin:0;max-width:62ch">Efface définitivement ${c.name}, ${c.users.length === 1 ? 'son utilisateur' : `ses ${c.users.length} utilisateurs`} et toutes ses données : clients, fournisseurs, articles, documents, règlements, relances, comptabilité et historique d'abonnement. Pour seulement bloquer l'accès, utilisez plutôt « Suspendre ».</p>
        <button class="btn danger" id="delete-company">${icon('trash', 16)} Supprimer l'entreprise</button>
      </div></div>
    </div>`);
  const reload = () => go('/admin/entreprise/' + c.id);
  $('#delete-company', view).onclick = () => {
    const k = c.counts || {};
    const m = modal({
      title: `Supprimer ${c.name}`,
      body: html`<div class="notice warn" style="margin-bottom:14px">Cette action est définitive : les données ne pourront pas être récupérées.</div>
        <p>Seront supprimés : ${c.users.length} utilisateur${c.users.length > 1 ? 's' : ''}, ${k.customers || 0} client${k.customers > 1 ? 's' : ''}, ${k.suppliers || 0} fournisseur${k.suppliers > 1 ? 's' : ''}, ${k.products || 0} article${k.products > 1 ? 's' : ''}, ${k.documents || 0} document${k.documents > 1 ? 's' : ''}, ${k.payments || 0} règlement${k.payments > 1 ? 's' : ''}, ainsi que la comptabilité et l'historique d'abonnement.</p>
        <form id="del-form" class="grid" onsubmit="return false">${field(html`Pour confirmer, saisissez le nom de l'entreprise : <b>${c.name}</b>`, input('confirm', '', 'autocomplete="off" spellcheck="false"'))}</form>`,
      actions: [{ label: 'Annuler' }, { label: 'Supprimer définitivement', kind: 'danger', onClick: async (mm) => {
        const r = await post(`/api/admin/companies/${c.id}/delete`, formData($('#del-form', mm.el)));
        toast(`${r.name} a été supprimée`, 'success');
        go('/admin/entreprises');
      } }],
    });
    const btn = m.el.querySelector('[data-act="1"]');
    const box = m.el.querySelector('[name=confirm]');
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    btn.disabled = true;
    box.addEventListener('input', () => { btn.disabled = norm(box.value) !== norm(c.name); });
  };
  $('#sub-form', view).onsubmit = async (e) => { e.preventDefault(); try { await put('/api/admin/companies/' + c.id, formData(e.target)); toast('Abonnement mis à jour'); reload(); } catch (err) { fail(err); } };
  const top = document.getElementById('top-actions');
  on(top, 'click', '[data-ext]', async (e, b) => { try { await post(`/api/admin/companies/${c.id}/extend`, { days: Number(b.dataset.ext) }); toast('Abonnement prolongé'); reload(); } catch (err) { fail(err); } });
  const sus = top.querySelector('#suspend');
  if (sus) sus.onclick = async () => { if (await confirmBox(`Suspendre ${c.name} ? Ses utilisateurs ne pourront plus accéder à leurs données.`, { ok: 'Suspendre', danger: true })) { await put('/api/admin/companies/' + c.id, { status: 'suspended' }).catch(fail); reload(); } };
  const uns = top.querySelector('#unsuspend');
  if (uns) uns.onclick = async () => { await put('/api/admin/companies/' + c.id, { status: c.paid_until ? 'active' : 'trial' }).catch(fail); reload(); };
  on(view, 'click', '[data-pw]', (e, b) => modal({
    title: 'Nouveau mot de passe', body: html`<form id="pw-form" class="grid">${field('Mot de passe provisoire', input('password', '', 'type="text" minlength="8" required'), 'à communiquer à l\'utilisateur')}</form>`,
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => { await put(`/api/admin/users/${b.dataset.pw}/password`, formData($('#pw-form', m.el))); toast('Mot de passe modifié'); } }],
  }));
}, { admin: true });

route('/admin/paiements', async (view) => {
  setTop('Paiements des abonnements');
  const load = async () => {
    const rows = await get('/api/admin/payments');
    view.innerHTML = String(html`<div class="panel">${table({
      columns: [
        { label: 'Date', render: (r) => date(r.created_at) },
        { label: 'Entreprise', render: (r) => html`<a href="#/admin/entreprise/${r.company_id}">${r.company_name}</a>` },
        { label: 'Formule', render: (r) => `${r.plan_code}, ${r.months} mois` },
        { label: 'Mode', render: (r) => html`${METHOD[r.method] || r.method}${r.reference ? html`<div class="muted small">${r.reference}</div>` : ''}${r.note ? html`<div class="muted small">${r.note}</div>` : ''}` },
        { label: 'Statut', render: (r) => html`<span class="chip ${PAY_STATUS[r.status][1]}">${PAY_STATUS[r.status][0]}</span>` },
        { label: 'Montant', align: 'r', render: (r) => money(r.amount) },
        { label: '', render: (r) => (r.status === 'pending' ? html`<div class="row" style="justify-content:flex-end"><button class="btn small success" data-ok="${r.id}">Valider</button><button class="btn small danger" data-no="${r.id}">Refuser</button></div>` : '') },
      ], rows, empty: 'Aucun paiement pour l\'instant.',
    })}</div><p class="small muted" style="margin-top:10px">Valider un paiement prolonge l'abonnement de l'entreprise de la durée payée et applique la formule choisie.</p>`);
  };
  on(view, 'click', '[data-ok]', async (e, b) => {
    if (!(await confirmBox('Confirmez-vous avoir reçu ce paiement ?', { ok: 'Valider le paiement' }))) return;
    try { await post(`/api/admin/payments/${b.dataset.ok}/approve`); toast('Paiement validé, abonnement prolongé', 'success'); load(); } catch (err) { fail(err); }
  });
  on(view, 'click', '[data-no]', (e, b) => modal({
    title: 'Refuser le paiement', body: html`<form id="rj" class="grid">${field('Motif', input('note', '', 'placeholder="Virement non reçu…"'))}</form>`,
    actions: [{ label: 'Annuler' }, { label: 'Refuser', kind: 'danger', onClick: async (m) => { await post(`/api/admin/payments/${b.dataset.no}/reject`, formData($('#rj', m.el))); toast('Paiement refusé'); load(); } }],
  }));
  await load();
}, { admin: true });

route('/admin/formules', async (view) => {
  setTop('Formules et prix');
  const plans = await get('/api/admin/plans');
  view.innerHTML = String(html`<div class="panel">${table({
    columns: [{ label: 'Formule', render: (p) => html`<span class="strong">${p.name}</span>${!p.active ? html` <span class="chip off">Masquée</span>` : ''}<div class="muted small">${p.description || ''}</div>` },
      { label: 'Prix mensuel', align: 'r', render: (p) => money(p.price_month) }, { label: 'Prix annuel', align: 'r', render: (p) => money(p.price_year) },
      { label: 'Utilisateurs', align: 'r', key: 'max_users' }, { label: '', render: (p) => html`<button class="btn small" data-edit="${p.code}">Modifier</button>` }],
    rows: plans,
  })}</div><p class="small muted" style="margin-top:10px">Les prix s'appliquent aux prochains paiements. Les abonnements en cours ne changent pas.</p>`);
  on(view, 'click', '[data-edit]', (e, b) => {
    const p = plans.find((x) => x.code === b.dataset.edit);
    modal({
      title: `Formule ${p.name}`, wide: true,
      body: html`<form id="pl" class="grid"><div class="grid c2">${field('Nom', input('name', p.name, 'required'))}${field('Utilisateurs inclus', input('max_users', p.max_users, 'type="number" min="1"'))}</div>
        ${field('Description', input('description', p.description))}
        <div class="grid c2">${field('Prix mensuel (DT)', input('price_month', fmt3(p.price_month), 'class="num" inputmode="decimal"'))}${field('Prix annuel (DT)', input('price_year', fmt3(p.price_year), 'class="num" inputmode="decimal"'))}</div>
        ${field('Avantages affichés', textarea('features', (p.features || []).join('\n'), 'rows="5"'), 'un par ligne')}
        <label class="check"><input type="checkbox" name="active" ${p.active ? raw('checked') : ''}> Proposée aux clients</label></form>`,
      actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => {
        const f = formData($('#pl', m.el));
        f.price_month = String(f.price_month).replace(/\s/g, '').replace(',', '.'); f.price_year = String(f.price_year).replace(/\s/g, '').replace(',', '.');
        await put('/api/admin/plans/' + p.code, f); toast('Formule enregistrée'); go('/admin/formules');
      } }],
    });
  });
}, { admin: true });

route('/admin/reglages', async (view) => {
  setTop('Réglages de la plateforme');
  const s = await get('/api/admin/settings');
  view.innerHTML = String(html`<form id="st" class="stack">
    <div class="panel"><div class="panel-head"><h2>Essai gratuit et contact</h2></div><div class="panel-body grid c2">
      ${field('Durée de l\'essai (jours)', input('trial_days', s.trial_days, 'type="number" min="0"'))}${field('E-mail de contact', input('contact_email', s.contact_email, 'type="email"'))}
      ${field('Téléphone', input('contact_phone', s.contact_phone))}${field('WhatsApp', input('contact_whatsapp', s.contact_whatsapp))}</div></div>
    <div class="panel"><div class="panel-head"><h2>Coordonnées de paiement affichées aux clients</h2></div><div class="panel-body grid c2">
      ${field('Banque', input('bank_name', s.bank_name))}${field('Titulaire du compte', input('bank_holder', s.bank_holder))}
      ${field('RIB', input('bank_rib', s.bank_rib), '', 'span-2')}${field('Numéro D17', input('d17_phone', s.d17_phone))}
      ${field('Consigne', input('payment_note', s.payment_note))}</div></div>
    <div class="panel"><div class="panel-head"><h2>Paiement en ligne Konnect</h2>${s.konnect_enabled ? html`<span class="chip paid">Activé (${s.konnect_env === 'production' ? 'réel' : 'test'})</span>` : html`<span class="chip off">Non configuré</span>`}</div>
      <div class="panel-body"><p class="text-2" style="margin:0">Pour accepter la carte bancaire et e-DINAR, ouvrez un compte marchand sur Konnect, puis ajoutez les variables KONNECT_API_KEY, KONNECT_WALLET_ID et KONNECT_ENV=production dans les réglages du service sur Render. Le bouton « Payer en ligne » apparaît alors automatiquement chez vos clients.</p></div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Enregistrer</button></div>
  </form>`);
  $('#st', view).onsubmit = async (e) => { e.preventDefault(); try { await put('/api/admin/settings', formData(e.target)); toast('Réglages enregistrés', 'success'); } catch (err) { fail(err); } };
}, { admin: true });

export { esc, n };
