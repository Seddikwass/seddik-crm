// Paramètres : entreprise, utilisateurs, abonnement, compte
import {
  html, raw, esc, route, get, post, put, go, setTop, money, moneyText, date, n, fmt3, toast, fail, modal, table, icon, isAdmin, state, $, $$, on, formData, field, input, select, textarea,
} from '../core.js';
import { refreshMe } from '../main.js';

const ROLES = { owner: 'Propriétaire', admin: 'Administrateur', user: 'Utilisateur', lecture: 'Lecture seule' };
const PREFIX_LABELS = { devis: 'Devis', commande: 'Commandes clients', livraison: 'Bons de livraison', facture: 'Factures', avoir: 'Avoirs', p_commande: 'Commandes fournisseurs', p_reception: 'Bons de réception', p_facture: 'Factures fournisseurs', p_avoir: 'Avoirs fournisseurs', reglement_in: 'Règlements clients', reglement_out: 'Paiements fournisseurs' };
const ACCOUNT_LABELS = { client: 'Clients', fournisseur: 'Fournisseurs', vente_marchandises: 'Ventes de marchandises', vente_services: 'Prestations de services', achat_marchandises: 'Achats de marchandises', achat_services: 'Achats de services', tva_collectee: 'TVA collectée', tva_deductible: 'TVA déductible', timbre_vente: 'Timbre fiscal sur ventes', timbre_achat: 'Timbre fiscal sur achats', banque: 'Banque', caisse: 'Caisse', retenue: 'Retenues à la source subies', retenue_a_payer: 'Retenues à la source à payer' };
const PAY_STATUS = { pending: ['En attente de validation', 'late'], paid: ['Validé', 'paid'], rejected: ['Refusé', 'bad'], failed: ['Échoué', 'bad'] };
const tabs = (cur) => html`<div class="tabs">${[['entreprise', 'Entreprise'], ['utilisateurs', 'Utilisateurs'], ['abonnement', 'Abonnement'], ['compte', 'Mon compte']]
  .map(([k, l]) => html`<a href="#/parametres/${k}" class="${cur === k ? 'on' : ''}">${l}</a>`)}</div>`;

route('/parametres/:tab', async (view, p, q) => {
  const tab = p.tab;
  const isSuper = state.me.user.role === 'superadmin';
  if (isSuper && tab !== 'compte') return go('/admin');
  setTop('Paramètres');
  if (tab === 'entreprise') return company(view);
  if (tab === 'utilisateurs') return users(view);
  if (tab === 'abonnement') return billing(view, q);
  return account(view, isSuper);
});

async function company(view) {
  const c = await get('/api/company');
  view.innerHTML = String(html`${tabs('entreprise')}<form id="co-form" class="stack">
    <div class="panel"><div class="panel-head"><h2>Identité</h2><span class="muted small">Ces informations apparaissent sur vos devis et factures</span></div><div class="panel-body grid">
      <div class="grid c3">${field('Raison sociale', input('name', c.name, 'required'), '', 'span-2')}${field('Forme juridique', input('legal_form', c.legal_form, 'placeholder="SARL, SA, SUARL…"'))}</div>
      <div class="grid c3">${field('Matricule fiscal', input('tax_id', c.tax_id))}${field('Registre du commerce', input('rc', c.rc))}${field('Site web', input('website', c.website))}</div>
      <div class="grid c3">${field('Adresse', input('address', c.address), '', 'span-2')}${field('Ville', input('city', c.city))}</div>
      <div class="grid c3">${field('Téléphone', input('phone', c.phone))}${field('E-mail', input('email', c.email, 'type="email"'))}<div></div></div>
      <div class="grid c3">${field('Banque', input('bank_name', c.bank_name))}${field('RIB', input('rib', c.rib), 'imprimé sur les factures', 'span-2')}</div>
      ${field('Pied de page des documents', textarea('invoice_footer', c.invoice_footer, 'rows="2"'), 'vide = identité de l\'entreprise')}
    </div></div>
    <div class="panel"><div class="panel-head"><h2>Facturation</h2></div><div class="panel-body grid c3">
      ${field('Timbre fiscal par facture (DT)', input('timbre', fmt3(c.timbre), 'class="num" inputmode="decimal"'))}
      ${field('Délai de paiement par défaut (jours)', input('default_terms', c.default_terms, 'type="number" min="0"'), 'pour les nouveaux clients')}
    </div></div>
    <details class="panel"><summary class="panel-head" style="cursor:pointer"><h2>Numérotation des documents</h2><span class="muted small">Préfixe + année + numéro, ex. FA26-00001</span></summary><div class="panel-body grid c4">
      ${Object.entries(PREFIX_LABELS).map(([k, l]) => field(l, input('prefix_' + k, (c.prefixes || {})[k], 'maxlength="6"')))}
    </div></details>
    <details class="panel"><summary class="panel-head" style="cursor:pointer"><h2>Comptes utilisés pour les écritures automatiques</h2><span class="muted small">À ajuster avec votre expert-comptable</span></summary><div class="panel-body grid c4">
      ${Object.entries(ACCOUNT_LABELS).map(([k, l]) => field(l, input('acc_' + k, (c.accounts_map || {})[k], 'inputmode="numeric"')))}
    </div></details>
    ${isAdmin() ? html`<div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Enregistrer les paramètres</button></div>` : html`<p class="muted">Seuls les administrateurs peuvent modifier ces paramètres.</p>`}
  </form>`);
  if (!isAdmin()) $$('#co-form input, #co-form textarea', view).forEach((el) => { el.disabled = true; });
  $('#co-form', view).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    const body = { prefixes: {}, accounts_map: {} };
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith('prefix_')) { if (v) body.prefixes[k.slice(7)] = v.toUpperCase(); }
      else if (k.startsWith('acc_')) { if (v) body.accounts_map[k.slice(4)] = v; }
      else body[k] = v;
    }
    body.timbre = String(body.timbre).replace(/\s/g, '').replace(',', '.');
    try { await put('/api/company', body); toast('Paramètres enregistrés', 'success'); await refreshMe(); go('/parametres/entreprise'); } catch (err) { fail(err); }
  };
}

async function users(view) {
  const data = await get('/api/users');
  const active = data.users.filter((u) => u.active).length;
  if (isAdmin()) setTop('Paramètres', html`<button class="btn primary" id="new">${icon('plus', 16)} Ajouter un utilisateur</button>`);
  view.innerHTML = String(html`${tabs('utilisateurs')}
    <p class="text-2">${active} utilisateur${active > 1 ? 's' : ''} actif${active > 1 ? 's' : ''} sur ${data.max_users} inclus dans votre formule.</p>
    <div class="panel">${table({
      columns: [
        { label: 'Nom', render: (u) => html`<span class="strong">${u.name}</span>${!u.active ? html` <span class="chip off">Désactivé</span>` : ''}` },
        { label: 'E-mail', key: 'email' }, { label: 'Rôle', render: (u) => ROLES[u.role] || u.role },
        { label: 'Dernière connexion', render: (u) => (u.last_login ? date(u.last_login) : html`<span class="muted">Jamais</span>`) },
        { label: '', render: (u) => (isAdmin() && u.role !== 'owner' ? html`<button class="btn small" data-edit="${u.id}">Modifier</button>` : '') },
      ], rows: data.users,
    })}</div>
    <p class="small muted" style="margin-top:12px">Administrateur : tout, y compris les paramètres et l'abonnement. Utilisateur : saisie de tous les documents. Lecture seule : consultation uniquement.</p>`);
  const roleOpts = Object.entries(ROLES).filter(([k]) => k !== 'owner');
  const nb = document.getElementById('new');
  if (nb) nb.onclick = () => modal({
    title: 'Nouvel utilisateur',
    body: html`<form id="us-form" class="grid">${field('Nom complet', input('name', '', 'required'))}${field('E-mail', input('email', '', 'type="email" required'))}
      <div class="grid c2">${field('Téléphone', input('phone', ''))}${field('Rôle', select('role', roleOpts, 'user'))}</div>
      ${field('Mot de passe provisoire', input('password', '', 'type="text" minlength="8" required'), 'à communiquer à la personne')}</form>`,
    actions: [{ label: 'Annuler' }, { label: 'Créer l\'utilisateur', kind: 'primary', onClick: async (m) => { await post('/api/users', formData($('#us-form', m.el))); toast('Utilisateur créé', 'success'); users(view); } }],
  });
  on(view, 'click', '[data-edit]', (e, b) => {
    const u = data.users.find((x) => x.id === Number(b.dataset.edit));
    modal({
      title: u.name,
      body: html`<form id="us-form" class="grid">${field('Nom complet', input('name', u.name, 'required'))}
        <div class="grid c2">${field('Téléphone', input('phone', u.phone))}${field('Rôle', select('role', roleOpts, u.role))}</div>
        ${field('Nouveau mot de passe', input('password', '', 'type="text" minlength="8"'), 'laisser vide pour ne pas changer')}
        <label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> Compte actif</label></form>`,
      actions: [{ label: 'Annuler' }, { label: 'Enregistrer', kind: 'primary', onClick: async (m) => { await put('/api/users/' + u.id, formData($('#us-form', m.el))); toast('Utilisateur enregistré'); users(view); } }],
    });
  });
}

async function billing(view, q) {
  const b = await get('/api/billing');
  const s = b.subscription;
  const current = b.plans.find((p) => p.code === s.plan_code);
  let period = 'year';
  const notices = { ok: ['Paiement reçu : votre abonnement est activé. Merci !', 'success'], echec: ['Le paiement n\'a pas abouti. Vous pouvez réessayer ou payer par virement.', 'error'], attente: ['Paiement en cours de traitement par la banque.', ''], verification: ['Nous n\'avons pas pu vérifier le paiement pour l\'instant. Rechargez la page dans quelques minutes.', ''] };
  if (q.paiement && notices[q.paiement]) { toast(...notices[q.paiement]); if (q.paiement === 'ok') refreshMe().catch(() => {}); }
  const statusText = s.access === 'suspended' ? html`<span class="chip bad">Suspendu</span>` : s.access === 'expired' ? html`<span class="chip bad">Expiré</span>` : s.is_trial ? html`<span class="chip late">Essai gratuit</span>` : html`<span class="chip paid">Actif</span>`;
  view.innerHTML = String(html`${tabs('abonnement')}<div class="stack">
    <div class="panel"><div class="panel-body row between">
      <div><div class="row">${statusText}<h2>Formule ${current ? current.name : s.plan_code}</h2></div>
        <p class="text-2" style="margin:8px 0 0">${s.access === 'expired' ? html`Expiré depuis le ${date(s.ends_at)}. Vos données sont conservées : renouvelez pour reprendre la saisie.` : html`${s.is_trial ? 'Essai' : 'Abonnement'} valable jusqu'au <b>${date(s.ends_at)}</b> (${s.days_left} jour${s.days_left > 1 ? 's' : ''}).`}
          ${b.users} utilisateur${b.users > 1 ? 's' : ''} actif${b.users > 1 ? 's' : ''}.</p></div>
    </div></div>
    <div class="row between"><h2>${s.is_trial || s.access !== 'ok' ? 'Choisir une formule' : 'Renouveler ou changer de formule'}</h2>
      <div class="seg" id="period"><button data-v="month">Mensuel</button><button data-v="year" class="on">Annuel, 2 mois offerts</button></div></div>
    <div class="pricing" id="plans"></div>
    <div class="panel"><div class="panel-head"><h2>Historique des paiements</h2></div>${table({
      columns: [{ label: 'Date', render: (r) => date(r.created_at) }, { label: 'Formule', render: (r) => `${(b.plans.find((p) => p.code === r.plan_code) || {}).name || r.plan_code}, ${r.months === 12 ? '12 mois' : r.months + ' mois'}` },
        { label: 'Mode', render: (r) => (r.method === 'konnect' ? 'Paiement en ligne' : b.methods[r.method] || r.method) }, { label: 'Référence', key: 'reference' },
        { label: 'Statut', render: (r) => html`<span class="chip ${PAY_STATUS[r.status] ? PAY_STATUS[r.status][1] : ''}">${PAY_STATUS[r.status] ? PAY_STATUS[r.status][0] : r.status}</span>` },
        { label: 'Montant', align: 'r', render: (r) => money(r.amount) }],
      rows: b.payments, empty: 'Aucun paiement pour l\'instant.',
    })}</div>
    ${b.payment_info.contact_phone || b.payment_info.contact_whatsapp || b.payment_info.contact_email ? html`<p class="muted small">Une question sur votre abonnement ? ${[b.payment_info.contact_phone && 'Tél. ' + b.payment_info.contact_phone, b.payment_info.contact_whatsapp && 'WhatsApp ' + b.payment_info.contact_whatsapp, b.payment_info.contact_email].filter(Boolean).join(', ')}</p>` : ''}
  </div>`);
  const drawPlans = () => {
    $('#plans', view).innerHTML = String(html`${b.plans.map((p) => html`<div class="price ${p.code === s.plan_code ? 'featured' : ''}">
      <h3>${p.name}${p.code === s.plan_code ? html` <span class="chip ok">Formule actuelle</span>` : ''}</h3><p class="muted small">${p.description || ''}</p>
      <div class="amount">${money(period === 'year' ? p.price_year : p.price_month, { cls: 'amt-xl', cur: period === 'year' ? 'DT / an' : 'DT / mois' })}</div>
      <ul>${(p.features || []).map((f) => html`<li>${f}</li>`)}</ul>
      ${isAdmin() ? html`<button class="btn ${p.code === s.plan_code ? 'primary' : ''}" data-plan="${p.code}">${p.code === s.plan_code && !s.is_trial ? 'Renouveler' : 'Choisir ' + p.name}</button>` : html`<p class="small muted">Demandez à un administrateur de votre entreprise.</p>`}
    </div>`)}`);
  };
  drawPlans();
  on($('#period', view), 'click', 'button', (e, btn) => { period = btn.dataset.v; $$('#period button', view).forEach((x) => x.classList.toggle('on', x === btn)); drawPlans(); });
  on(view, 'click', '[data-plan]', (e, btn) => {
    const plan = b.plans.find((p) => p.code === btn.dataset.plan);
    const amount = period === 'year' ? plan.price_year : plan.price_month;
    if (b.users > plan.max_users) return fail(new Error(`La formule ${plan.name} est limitée à ${plan.max_users} utilisateurs : désactivez-en d'abord ${b.users - plan.max_users}.`));
    const pi = b.payment_info;
    const manual = Object.entries(b.methods);
    modal({
      title: `Formule ${plan.name}, ${period === 'year' ? '12 mois' : '1 mois'}`, wide: true,
      body: html`<p>Montant à régler : ${money(amount, { cls: 'amt-xl' })}</p>
        ${b.konnect ? html`<div class="panel" style="margin-bottom:14px"><div class="panel-body row between"><div><h3>Payer en ligne</h3><p class="small muted" style="margin:4px 0 0">Carte bancaire, e-DINAR ou portefeuille Konnect. Activation immédiate.</p></div>
          <button class="btn primary" id="pay-online">Payer ${moneyText(amount)}</button></div></div>` : ''}
        <div class="panel"><div class="panel-body grid">
          <h3>Virement, versement ou D17</h3>
          ${pi.bank_rib ? html`<dl class="dl"><dt>Banque</dt><dd>${pi.bank_name || ''}</dd><dt>Titulaire</dt><dd>${pi.bank_holder || ''}</dd><dt>RIB</dt><dd><b>${pi.bank_rib}</b></dd>${pi.d17_phone ? html`<dt>D17</dt><dd>${pi.d17_phone}</dd>` : ''}</dl>` : html`<p class="muted">Contactez-nous pour obtenir les coordonnées de paiement${pi.contact_phone ? ' au ' + pi.contact_phone : ''}.</p>`}
          ${pi.note ? html`<p class="small muted" style="margin:0">${pi.note}</p>` : ''}
          <form id="decl" class="grid c2">${field('Mode', select('method', manual, 'virement'))}${field('Référence du paiement', input('reference', '', 'required placeholder="N° de virement, de reçu…"'))}${field('Commentaire', input('note', ''), '', 'span-2')}</form>
          <p class="small muted" style="margin:0">Votre abonnement est activé dès que nous avons vérifié le paiement, en général le jour même.</p>
        </div></div>`,
      actions: [{ label: 'Annuler' }, { label: 'Déclarer mon paiement', kind: 'primary', onClick: async (m) => {
        await post('/api/billing/declare', { plan_code: plan.code, period, ...formData($('#decl', m.el)) });
        toast('Paiement déclaré : il sera validé après vérification.', 'success'); billing(view, {});
      } }],
      onOpen: (m) => {
        const po = $('#pay-online', m.el);
        if (po) po.onclick = async () => {
          po.disabled = true;
          try { const r = await post('/api/billing/konnect', { plan_code: plan.code, period }); location.href = r.payUrl; } catch (err) { fail(err); po.disabled = false; }
        };
      },
    });
  });
}

async function account(view, isSuper) {
  const u = state.me.user;
  view.innerHTML = String(html`${isSuper ? '' : tabs('compte')}<div class="grid c2">
    <form class="panel" id="pf"><div class="panel-head"><h2>Profil</h2></div><div class="panel-body grid">
      ${field('Nom complet', input('name', u.name, 'required'))}${field('Téléphone', input('phone', u.phone))}${field('E-mail de connexion', raw(`<input value="${esc(u.email)}" disabled>`))}
      <div><button class="btn primary" type="submit">Enregistrer</button></div></div></form>
    <form class="panel" id="pw"><div class="panel-head"><h2>Mot de passe</h2></div><div class="panel-body grid">
      ${field('Mot de passe actuel', input('current', '', 'type="password" required autocomplete="current-password"'))}
      ${field('Nouveau mot de passe', input('next', '', 'type="password" required minlength="8" autocomplete="new-password"'), '8 caractères minimum')}
      <div><button class="btn primary" type="submit">Changer le mot de passe</button></div></div></form>
  </div>`);
  $('#pf', view).onsubmit = async (e) => { e.preventDefault(); try { await put('/api/auth/profile', formData(e.target)); toast('Profil enregistré'); await refreshMe(); go('/parametres/compte'); } catch (err) { fail(err); } };
  $('#pw', view).onsubmit = async (e) => { e.preventDefault(); try { await post('/api/auth/password', formData(e.target)); toast('Mot de passe modifié', 'success'); e.target.reset(); } catch (err) { fail(err); } };
}

export { n, textarea };
