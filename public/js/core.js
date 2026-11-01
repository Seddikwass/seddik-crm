// SEDDIK CRM — noyau de l'interface (sans dépendance)
export const state = { me: null, cache: {} };

// ---------- Gabarits HTML sûrs ----------
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += val(vals[i]); });
  return new Safe(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function on(root, event, selector, fn) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  });
}

// ---------- Formats ----------
const nf3 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
export const n = (v) => Number(v) || 0;
export const fmt3 = (v) => nf3.format(n(v)).replace(/ | /g, ' ');
export const fmt0 = (v) => nf0.format(n(v)).replace(/ | /g, ' ');
export const fmt2 = (v) => nf2.format(n(v)).replace(/ | /g, ' ');
export function money(v, opts = {}) {
  const s = fmt3(v);
  const i = s.lastIndexOf(',');
  const cur = opts.cur === false ? '' : `<span class="cur">${opts.cur || 'DT'}</span>`;
  return raw(`<span class="amt${n(v) < -0.0005 && opts.neg !== false ? ' neg' : ''}${opts.cls ? ' ' + opts.cls : ''}">${esc(s.slice(0, i))}<span class="mil">${esc(s.slice(i))}</span>${cur}</span>`);
}
export const moneyText = (v) => fmt3(v) + ' DT';
export function date(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(d);
}
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const addDays = (d, k) => { const x = new Date((d || today()) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
export const monthStart = () => today().slice(0, 8) + '01';
export const yearStart = () => today().slice(0, 4) + '-01-01';

// ---------- Appels à l'API ----------
export async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* vide */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Erreur ${res.status}`);
    err.status = res.status; err.data = data;
    if (res.status === 401 && !path.startsWith('/api/auth/')) { state.me = null; go('/connexion'); }
    throw err;
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b || {});
export const put = (p, b) => api('PUT', p, b || {});
export const del = (p) => api('DELETE', p);
export const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString(); return s ? '?' + s : ''; };

// ---------- Notifications et fenêtres ----------
export function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3200);
}
export const fail = (e) => toast(e.message || String(e), 'error');

export function modal({ title, body, actions = [], wide = false, onOpen }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Fermer" data-close>×</button></div>
    <div class="modal-body">${val(body)}</div>
    ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-act="${i}" type="button">${esc(a.label)}</button>`).join('')}</div>` : ''}
  </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-close]').onclick = close;
  const m = { el: back.querySelector('.modal'), body: back.querySelector('.modal-body'), close };
  actions.forEach((a, i) => {
    back.querySelector(`[data-act="${i}"]`).onclick = async (ev) => {
      if (!a.onClick) return close();
      const btn = ev.currentTarget;
      btn.disabled = true;
      try { const r = await a.onClick(m); if (r !== false) close(); } catch (e) { fail(e); } finally { btn.disabled = false; }
    };
  });
  document.body.append(back);
  const first = back.querySelector('.modal-body input:not([type=hidden]), .modal-body select, .modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
  if (onOpen) onOpen(m);
  return m;
}
export function confirmBox(message, { ok = 'Confirmer', danger = false, title = 'Confirmation' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, body: html`<p>${message}</p>`,
      actions: [{ label: 'Annuler', onClick: () => { done = true; resolve(false); } }, { label: ok, kind: danger ? 'danger' : 'primary', onClick: () => { done = true; resolve(true); } }],
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}
export function formData(root) {
  const o = {};
  $$('[name]', root).forEach((el) => {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value.trim();
  });
  return o;
}

// ---------- Champs ----------
export const field = (label, input, hint = '', cls = '') => html`<label class="field ${cls}">${label}${hint ? html` <span class="hint">${hint}</span>` : ''}${input}</label>`;
export const input = (name, value = '', attrs = '') => raw(`<input name="${esc(name)}" value="${esc(value ?? '')}" ${attrs}>`);
export const select = (name, options, value, attrs = '') => raw(`<select name="${esc(name)}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
export const textarea = (name, value = '', attrs = '') => raw(`<textarea name="${esc(name)}" ${attrs}>${esc(value ?? '')}</textarea>`);

// Liste déroulante avec recherche
export function combo(inputEl, { items, getLabel, getSub, onPick, minChars = 0 }) {
  const wrap = inputEl.parentElement;
  wrap.classList.add('combo');
  let list = null; let idx = -1; let shown = [];
  const close = () => { if (list) list.remove(); list = null; idx = -1; };
  const render = () => {
    const q = inputEl.value.trim().toLowerCase();
    if (q.length < minChars) return close();
    const all = typeof items === 'function' ? items() : items;
    shown = all.filter((it) => !q || (getLabel(it) + ' ' + (getSub ? getSub(it) : '')).toLowerCase().includes(q)).slice(0, 40);
    if (!list) { list = document.createElement('div'); list.className = 'combo-list'; wrap.append(list); }
    list.innerHTML = shown.length ? shown.map((it, i) => `<div data-i="${i}" class="${i === idx ? 'on' : ''}"><span>${esc(getLabel(it))}</span>${getSub ? `<small>${esc(getSub(it))}</small>` : ''}</div>`).join('')
      : '<div class="muted">Aucun résultat</div>';
    list.onmousedown = (e) => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(shown[+d.dataset.i]); } };
  };
  const pick = (it) => { if (!it) return; inputEl.value = getLabel(it); close(); onPick(it); };
  inputEl.setAttribute('autocomplete', 'off');
  inputEl.addEventListener('focus', () => { inputEl.select(); idx = -1; render(); });
  inputEl.addEventListener('input', () => { idx = 0; render(); });
  inputEl.addEventListener('blur', () => setTimeout(close, 120));
  inputEl.addEventListener('keydown', (e) => {
    if (!list) return;
    if (e.key === 'ArrowDown') { idx = Math.min(shown.length - 1, idx + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (shown[idx]) { e.preventDefault(); pick(shown[idx]); } }
    else if (e.key === 'Escape') close();
  });
}

// ---------- Tableaux ----------
// columns: [{ label, key, render(row), align:'r', cls, foot }]
export function table({ columns, rows, href, empty, foot, stack = true, id = '' }) {
  if (!rows.length) return html`<div class="empty">${empty || 'Aucun élément.'}</div>`;
  return html`<div class="table-wrap"><table class="data ${stack ? 'stackable' : ''}" ${raw(id ? `id="${esc(id)}"` : '')}>
    <thead><tr>${columns.map((c) => html`<th class="${c.align || ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr class="${href ? 'click' : ''}" ${raw(href ? `data-href="${esc(href(r))}"` : '')}>${columns.map((c) => html`<td class="${c.align || ''} ${c.cls || ''}" data-label="${c.label}">${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`)}</tbody>
    ${foot ? html`<tfoot><tr>${columns.map((c, i) => html`<td class="${c.align || ''}" data-label="${c.label}">${foot[i] ?? ''}</td>`)}</tr></tfoot>` : ''}
  </table></div>`;
}
export function bindRowLinks(root) {
  on(root, 'click', 'tr[data-href]', (e, tr) => { if (!e.target.closest('a,button,input,select')) go(tr.dataset.href); });
}

// Export CSV (séparateur ; pour Excel FR)
export function downloadCsv(filename, headers, rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const csvNum = (v) => fmt3(v).replace(/ /g, '');
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// ---------- Montant en lettres (dinars / millimes) ----------
const U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const T = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
function below100(x) {
  if (x <= 16) return U[x];
  if (x < 20) return 'dix-' + U[x - 10];
  if (x < 70) { const t = Math.floor(x / 10); const u = x % 10; return T[t] + (u === 0 ? '' : u === 1 ? ' et un' : '-' + U[u]); }
  if (x < 80) return x === 71 ? 'soixante et onze' : 'soixante-' + below100(x - 60);
  if (x === 80) return 'quatre-vingts';
  return 'quatre-vingt-' + below100(x - 80);
}
function below1000(x) {
  const c = Math.floor(x / 100); const r = x % 100;
  let s = '';
  if (c === 1) s = 'cent'; else if (c > 1) s = U[c] + (r === 0 ? ' cents' : ' cent');
  if (r) s += (s ? ' ' : '') + below100(r);
  return s || 'zéro';
}
export function inWords(x) {
  x = Math.floor(Math.abs(x));
  if (x === 0) return 'zéro';
  const parts = [];
  const billions = Math.floor(x / 1e9); const millions = Math.floor((x % 1e9) / 1e6); const thousands = Math.floor((x % 1e6) / 1000); const rest = x % 1000;
  if (billions) parts.push(below1000(billions) + (billions > 1 ? ' milliards' : ' milliard'));
  if (millions) parts.push(below1000(millions) + (millions > 1 ? ' millions' : ' million'));
  if (thousands) parts.push(thousands === 1 ? 'mille' : below1000(thousands).replace(/cents$/, 'cent').replace(/vingts$/, 'vingt') + ' mille');
  if (rest) parts.push(below1000(rest));
  return parts.join(' ');
}
export function amountInWords(v) {
  const total = Math.round(Math.abs(n(v)) * 1000);
  const d = Math.floor(total / 1000); const m = total % 1000;
  let s = inWords(d) + (d > 1 ? ' dinars' : ' dinar');
  if (m) s += ' et ' + inWords(m) + (m > 1 ? ' millimes' : ' millime');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Icônes (traits simples) ----------
const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M7 8V3h10v5M7 17H4v-7h16v7h-3"/><path d="M7 14h10v7H7z"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M4 20h16"/>',
  upload: '<path d="M12 20V9m0 0-4 4m4-4 4 4M4 4h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  chat: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.3z"/>',
  sales: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
};
export const icon = (name, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
// Étoile à huit branches (khatem) — logo
export const logo = (size = 30) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">
  <rect x="9" y="9" width="22" height="22" rx="2" fill="#C27C12"/><rect x="9" y="9" width="22" height="22" rx="2" fill="#C27C12" transform="rotate(45 20 20)"/>
  <circle cx="20" cy="20" r="6.5" fill="#14283A"/><circle cx="20" cy="20" r="2.6" fill="#fff"/></svg>`);
export const brand = () => html`<div class="brand">${logo()}<div class="brand-name">SEDDIK CRM<span>Gestion pour entreprises tunisiennes</span></div></div>`;

// ---------- Routeur ----------
const routes = [];
export function route(pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler, opts });
}
export function go(path) { if (location.hash !== '#' + path) location.hash = path; else render(); }
export function currentPath() { return (location.hash.slice(1) || '/').split('?')[0]; }
export function hashQuery() { const q = location.hash.split('?')[1]; return Object.fromEntries(new URLSearchParams(q || '')); }

let layoutFn = null;
export function setLayout(fn) { layoutFn = fn; }
let renderToken = 0;
export async function render() {
  const path = currentPath();
  const token = ++renderToken;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      await layoutFn(r.opts, path, async (view) => {
        if (token !== renderToken) return;
        await r.handler(view, params, hashQuery());
      });
    } catch (e) {
      if (token !== renderToken) return;
      const view = $('#view');
      if (view && e.status !== 401) view.innerHTML = `<div class="panel"><div class="empty"><p>${esc(e.message)}</p><a class="btn" href="#/tableau-de-bord">Retour au tableau de bord</a></div></div>`;
    }
    return;
  }
  go('/');
}

// Titre et actions de la barre supérieure
export function setTop(title, actions = '') {
  document.title = `${title} – SEDDIK CRM`;
  const h = $('#top-title'); if (h) h.textContent = title;
  const a = $('#top-actions'); if (a) a.innerHTML = val(actions);
}

export const canEdit = () => state.me && state.me.user && state.me.user.role !== 'lecture' && state.me.subscription && state.me.subscription.access === 'ok';
export const isAdmin = () => state.me && state.me.user && ['owner', 'admin'].includes(state.me.user.role);

// Chargement des référentiels avec cache court
export async function ref(kind, force = false) {
  const c = state.cache[kind];
  if (!force && c && Date.now() - c.t < 30000) return c.data;
  const data = await get('/api/' + kind);
  state.cache[kind] = { t: Date.now(), data };
  return data;
}
export const clearRef = (kind) => { delete state.cache[kind]; };
