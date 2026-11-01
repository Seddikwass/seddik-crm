// SEDDIK CRM — point d'entrée : coquille, navigation, garde d'authentification
import { state, html, raw, $, get, post, go, render, setLayout, brand, icon, currentPath, date, toast } from './core.js';
import './pages/public.js';
import './pages/dashboard.js';
import './pages/documents.js';
import './pages/partners.js';
import './pages/recovery.js';
import './pages/stock.js';
import './pages/accounting.js';
import './pages/settings.js';
import './pages/admin.js';

const NAV = [
  { items: [['Tableau de bord', '/tableau-de-bord']] },
  { title: 'Ventes', items: [['Devis', '/ventes/devis'], ['Commandes clients', '/ventes/commande'], ['Bons de livraison', '/ventes/livraison'], ['Factures', '/ventes/facture'], ['Avoirs', '/ventes/avoir'], ['Clients', '/clients']] },
  { title: 'Recouvrement', items: [['Encours et balance âgée', '/recouvrement'], ['Agenda des relances', '/recouvrement/relances', 'todo'], ['Règlements clients', '/reglements/in']] },
  { title: 'Achats', items: [['Commandes fournisseurs', '/achats/commande'], ['Bons de réception', '/achats/reception'], ['Factures fournisseurs', '/achats/facture'], ['Avoirs fournisseurs', '/achats/avoir'], ['Fournisseurs', '/fournisseurs'], ['Paiements fournisseurs', '/reglements/out']] },
  { title: 'Stocks', items: [['Articles et services', '/articles'], ['Mouvements de stock', '/stock/mouvements']] },
  { title: 'Comptabilité', items: [['Trésorerie', '/compta/tresorerie'], ['Écritures', '/compta/ecritures'], ['Grand livre', '/compta/grand-livre'], ['Balance générale', '/compta/balance'], ['Déclaration de TVA', '/compta/tva'], ['Plan comptable', '/compta/plan']] },
  { title: 'Paramètres', items: [['Entreprise', '/parametres/entreprise'], ['Utilisateurs', '/parametres/utilisateurs'], ['Abonnement', '/parametres/abonnement'], ['Mon compte', '/parametres/compte']] },
];
const ADMIN_NAV = [
  { title: 'Plateforme', items: [['Vue d\'ensemble', '/admin'], ['Entreprises clientes', '/admin/entreprises'], ['Paiements', '/admin/paiements'], ['Formules et prix', '/admin/formules'], ['Réglages', '/admin/reglages'], ['Mon compte', '/parametres/compte']] },
];

async function loadMe(force = false) {
  if (!state.me || force) state.me = await get('/api/auth/me');
  return state.me;
}
export async function refreshMe() { await loadMe(true); renderShell(true); }

async function logout() {
  await post('/api/auth/logout');
  state.me = { user: null }; state.cache = {};
  go('/');
}

let shellKind = null;
function navHtml() {
  const isSuper = state.me.user.role === 'superadmin';
  const groups = isSuper ? ADMIN_NAV : NAV;
  return groups.map((g) => html`<div class="nav-group">${g.title ? html`<div class="nav-title">${g.title}</div>` : ''}
    <nav class="nav">${g.items.map(([label, path, badge]) => html`<a href="#${path}" data-path="${path}">${label}${badge ? raw(`<span class="count hidden" data-badge="${badge}"></span>`) : ''}</a>`)}</nav></div>`);
}

function banner() {
  const s = state.me.subscription;
  if (!s) return '';
  if (s.access === 'suspended') return html`<div class="banner danger">Le compte de votre entreprise est suspendu. Contactez SEDDIK CRM pour le réactiver.</div>`;
  if (s.access === 'expired') return html`<div class="banner danger"><span>Votre abonnement a expiré : vos données restent consultables, la saisie est bloquée.</span><a class="btn small" href="#/parametres/abonnement">Renouveler l'abonnement</a></div>`;
  if (s.is_trial) return html`<div class="banner ${s.days_left <= 3 ? 'warn' : 'info'}"><span>Essai gratuit : ${s.days_left} jour${s.days_left > 1 ? 's' : ''} restant${s.days_left > 1 ? 's' : ''} (jusqu'au ${date(s.ends_at)}).</span><a class="btn small" href="#/parametres/abonnement">Choisir une formule</a></div>`;
  if (s.days_left <= 7) return html`<div class="banner warn"><span>Votre abonnement se termine le ${date(s.ends_at)}.</span><a class="btn small" href="#/parametres/abonnement">Renouveler</a></div>`;
  return '';
}

function renderShell(force = false) {
  const kind = state.me.user.role === 'superadmin' ? 'admin' : 'company';
  if (!force && shellKind === kind && $('#view')) return;
  shellKind = kind;
  const company = state.me.company;
  document.body.innerHTML = String(html`<div class="shell">
    <aside class="sidebar" id="sidebar">
      ${brand()}
      ${navHtml()}
      <div class="sidebar-foot">
        <div>${company ? company.name : 'Administration de la plateforme'}</div>
        <div>${state.me.user.name}</div>
        <a href="#" id="logout">Se déconnecter</a>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="menu-btn" id="menu-btn" aria-label="Ouvrir le menu">${icon('menu', 22)}</button>
        <h1 id="top-title"></h1>
        <div class="actions" id="top-actions"></div>
      </header>
      <div id="banner">${banner()}</div>
      <main class="view" id="view"></main>
    </div>
  </div>`);
  $('#logout').onclick = (e) => { e.preventDefault(); logout(); };
  $('#menu-btn').onclick = () => document.body.classList.toggle('nav-open');
  if (kind === 'company') updateBadges();
}

export async function updateBadges() {
  try {
    const todo = await get('/api/reminders?todo=1');
    const b = document.querySelector('[data-badge="todo"]');
    if (b) { b.textContent = todo.length; b.classList.toggle('hidden', !todo.length); }
  } catch (e) { /* silencieux */ }
}

function markActive(path) {
  let best = null;
  document.querySelectorAll('.nav a[data-path]').forEach((a) => {
    a.classList.remove('active');
    const p = a.dataset.path;
    if (path === p || path.startsWith(p + '/')) { if (!best || p.length > best.dataset.path.length) best = a; }
  });
  if (best) best.classList.add('active');
}

setLayout(async (opts, path, renderView) => {
  await loadMe();
  const logged = !!(state.me && state.me.user);
  if (opts.public) {
    if (opts.guestOnly && logged) return go(state.me.user.role === 'superadmin' ? '/admin' : '/tableau-de-bord');
    shellKind = null;
    document.body.innerHTML = '<div id="view"></div>';
    window.scrollTo(0, 0);
    return renderView($('#view'));
  }
  if (!logged) return go('/connexion');
  const isSuper = state.me.user.role === 'superadmin';
  if (isSuper && !opts.admin && !path.startsWith('/parametres/compte')) return go('/admin');
  if (!isSuper && opts.admin) return go('/tableau-de-bord');
  if (opts.bare) {
    shellKind = null;
    document.body.innerHTML = '<div id="view"></div>';
    return renderView($('#view'));
  }
  renderShell();
  markActive(path);
  // Nouveaux éléments à chaque page : les écouteurs de la page précédente disparaissent
  for (const id of ['view', 'top-actions']) {
    const old = document.getElementById(id);
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
  }
  const view = $('#view');
  view.innerHTML = '<div class="loading">Chargement…</div>';
  window.scrollTo(0, 0);
  await renderView(view);
});

document.body.addEventListener('click', (e) => {
  if (document.body.classList.contains('nav-open') && (e.target.closest('.nav a') || !e.target.closest('.sidebar, .menu-btn'))) document.body.classList.remove('nav-open');
});
window.addEventListener('hashchange', render);
window.addEventListener('unhandledrejection', (e) => { if (e.reason && e.reason.status !== 401) toast(e.reason.message || 'Erreur', 'error'); });
render();

