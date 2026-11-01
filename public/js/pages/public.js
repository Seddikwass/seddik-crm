// Pages publiques : accueil, connexion, inscription
import { html, raw, route, get, post, go, brand, logo, money, fail, formData, state, field, input, icon } from '../core.js';

const MODULES = [
  { ico: 'sales', title: 'Ventes', text: 'Du devis à la facture, sans ressaisie.', items: ['Devis, commandes, bons de livraison', 'Factures et avoirs numérotés', 'Timbre fiscal et montant en lettres', 'Impression et PDF en un clic'] },
  { ico: 'cash', title: 'Recouvrement', text: 'Sachez qui vous doit quoi, et depuis quand.', items: ['Balance âgée par client', 'Agenda des relances et promesses', 'Messages WhatsApp, e-mail, courrier', 'Chèques impayés et retenues à la source'] },
  { ico: 'box', title: 'Achats et stocks', text: 'Un stock juste, valorisé au coût moyen.', items: ['Commandes et réceptions fournisseurs', 'Factures fournisseurs et échéances', 'Mouvements et inventaires', 'Alertes de stock minimum'] },
  { ico: 'book', title: 'Comptabilité', text: 'Les écritures se passent toutes seules.', items: ['Journaux ventes, achats, banque, caisse', 'Grand livre et balance générale', 'Aide à la déclaration de TVA', 'Trésorerie et chèques en portefeuille'] },
];

route('/', async (view) => {
  if (state.me && state.me.user) return go(state.me.user.role === 'superadmin' ? '/admin' : '/tableau-de-bord');
  const [plans, info] = await Promise.all([get('/api/public/plans').catch(() => []), get('/api/public/info').catch(() => ({ trial_days: 14 }))]);
  const trial = info.trial_days || 14;
  view.innerHTML = String(html`<div class="public">
    <header class="pub-nav">${brand()}<div class="row"><a class="btn ghost" href="#/connexion">Se connecter</a><a class="btn primary" href="#/inscription">Essai gratuit</a></div></header>
    <section class="hero">
      <div>
        <h1>Toute la gestion de votre PME, au millime près.</h1>
        <p class="lead">Devis, factures avec timbre fiscal, relances clients, achats, stocks et comptabilité réunis dans un seul outil en ligne, pensé pour les entreprises tunisiennes.</p>
        <div class="cta"><a class="btn primary" href="#/inscription">Essayer gratuitement ${trial} jours</a><a class="btn" href="#tarifs" data-scroll>Voir les tarifs</a></div>
        <p class="muted small" style="margin-top:14px">Sans engagement, sans carte bancaire. Vos données restent consultables même après l'essai.</p>
      </div>
      <div class="invoice-card" aria-label="Exemple de facture">
        <div class="ic-head"><span>Facture FA26-00128</span><span>Échéance 30/11/2026</span></div>
        <div class="ic-line"><span>Climatiseur 12 000 BTU × 2, remise 10 %</span>${money(2700, { cur: false })}</div>
        <div class="ic-line"><span>Installation × 2</span>${money(300, { cur: false })}</div>
        <div class="ic-line"><span>TVA 19 %</span>${money(570, { cur: false })}</div>
        <div class="ic-line"><span>Timbre fiscal</span>${money(1, { cur: false })}</div>
        <div class="ic-total"><span class="text-2">Total TTC</span>${money(3571, { cls: 'amt-xl' })}</div>
        <span class="stamp">Réglée par chèque</span>
      </div>
    </section>
    <section class="section">
      <h2>Quatre modules qui partagent les mêmes données</h2>
      <p class="lead">Une facture validée met à jour le stock, l'encours du client et la comptabilité en même temps. Vous saisissez une fois.</p>
      <div class="modules">${MODULES.map((m) => html`<div class="module"><div class="ico">${icon(m.ico, 22)}</div><h3>${m.title}</h3><p>${m.text}</p><ul>${m.items.map((i) => html`<li>${i}</li>`)}</ul></div>`)}</div>
    </section>
    <section class="section" style="background:var(--bg)">
      <h2>Conforme aux usages tunisiens</h2>
      <p class="lead">TVA à 19 %, 13 % et 7 %, timbre fiscal sur chaque facture, retenue à la source sur les règlements, chèques et traites à échéance, matricule fiscal sur vos documents, montants en dinars à trois décimales. Le plan comptable proposé suit le système comptable tunisien et reste modifiable par votre comptable.</p>
    </section>
    <section class="section" id="tarifs">
      <h2>Des formules simples, en dinars</h2>
      <p class="lead">Chaque formule donne accès à tous les modules. Payez au mois ou à l'année (deux mois offerts), par carte bancaire, e-DINAR, virement ou D17.</p>
      <div class="pricing">${plans.map((p, i) => html`<div class="price ${i === 1 ? 'featured' : ''}">
        <h3>${p.name}</h3><p class="muted small">${p.description || ''}</p>
        <div class="amount">${money(p.price_month, { cls: 'amt-xl', cur: 'DT / mois' })}</div>
        <div class="muted small">ou ${money(p.price_year, { cur: 'DT' })} par an</div>
        <ul>${(p.features || []).map((f) => html`<li>${f}</li>`)}</ul>
        <a class="btn ${i === 1 ? 'primary' : ''}" href="#/inscription?formule=${p.code}">Commencer l'essai gratuit</a>
      </div>`)}</div>
    </section>
    <footer class="pub-foot"><span>© ${new Date().getFullYear()} SEDDIK CRM</span>
      ${info.contact_phone ? html`<span>Tél. ${info.contact_phone}</span>` : ''}${info.contact_email ? html`<span>${info.contact_email}</span>` : ''}</footer>
  </div>`);
  view.querySelector('[data-scroll]').onclick = (e) => { e.preventDefault(); document.getElementById('tarifs').scrollIntoView({ behavior: 'smooth' }); };
}, { public: true });

function authPage(view, title, sub, formHtml, footHtml) {
  view.innerHTML = String(html`<div class="auth-wrap"><div class="auth-card">
    <a href="#/">${brand()}</a>
    <h1>${title}</h1><p class="muted">${sub}</p>
    <form id="auth-form" class="grid" novalidate>${formHtml}</form>
    <p class="small" style="margin-top:18px">${footHtml}</p>
  </div></div>`);
  return view.querySelector('#auth-form');
}

route('/connexion', async (view) => {
  const form = authPage(view, 'Connexion', 'Accédez à l\'espace de votre entreprise.',
    html`${field('E-mail', input('email', '', 'type="email" autocomplete="email" required'))}
      ${field('Mot de passe', input('password', '', 'type="password" autocomplete="current-password" required'))}
      <button class="btn primary" type="submit">Se connecter</button>`,
    html`Pas encore de compte ? <a href="#/inscription">Créer l'espace de mon entreprise</a>`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      state.me = await post('/api/auth/login', formData(form));
      go(state.me.user.role === 'superadmin' ? '/admin' : '/tableau-de-bord');
    } catch (err) { fail(err); btn.disabled = false; }
  };
}, { public: true, guestOnly: true });

route('/inscription', async (view) => {
  const info = await get('/api/public/info').catch(() => ({ trial_days: 14 }));
  const form = authPage(view, 'Créer votre espace', `${info.trial_days || 14} jours d'essai gratuit, tous modules inclus.`,
    html`${field('Nom de l\'entreprise', input('company_name', '', 'required autocomplete="organization"'))}
      ${field('Votre nom complet', input('name', '', 'required autocomplete="name"'))}
      <div class="grid c2">${field('Téléphone', input('phone', '', 'type="tel" autocomplete="tel"'))}${field('Ville', input('city', '', 'autocomplete="address-level2"'))}</div>
      ${field('Matricule fiscal', input('tax_id', '', 'placeholder="1234567/A/M/000"'), 'facultatif')}
      ${field('E-mail', input('email', '', 'type="email" required autocomplete="email"'))}
      ${field('Mot de passe', input('password', '', 'type="password" required minlength="8" autocomplete="new-password"'), '8 caractères minimum')}
      <button class="btn primary" type="submit">Créer mon espace</button>`,
    html`Déjà inscrit ? <a href="#/connexion">Se connecter</a>`);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      state.me = await post('/api/auth/signup', formData(form));
      go('/tableau-de-bord?bienvenue=1');
    } catch (err) { fail(err); btn.disabled = false; }
  };
}, { public: true, guestOnly: true });

export { logo, raw };
