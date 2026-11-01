'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('../lib/pg');
const { hashPassword } = require('../lib/security');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://seddik:S3cret!pass@127.0.0.1:5433/seddik';
const SCHEMA = (process.env.DB_SCHEMA || 'public').replace(/[^a-z0-9_]/gi, '');

const db = new Pool(DATABASE_URL, { max: Number(process.env.DB_POOL || 5), searchPath: SCHEMA === 'public' ? undefined : SCHEMA + ',public' });

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
// Date du jour (AAAA-MM-JJ) dans le fuseau de l'application (Tunisie par défaut)
const TZ = process.env.APP_TZ || 'Africa/Tunis';
const localToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const DEFAULT_PREFIXES = {
  devis: 'DV', commande: 'BC', livraison: 'BL', facture: 'FA', avoir: 'AV',
  p_commande: 'CF', p_reception: 'BR', p_facture: 'FF', p_avoir: 'AF',
  reglement_in: 'RG', reglement_out: 'DC',
};

// Comptes par défaut (référentiel tunisien) — modifiables dans Paramètres > Comptabilité
const DEFAULT_ACCOUNTS_MAP = {
  client: '411', fournisseur: '401',
  vente_marchandises: '707', vente_services: '706',
  achat_marchandises: '607', achat_services: '604',
  tva_collectee: '43661', tva_deductible: '43662',
  timbre_vente: '43663', timbre_achat: '661',
  banque: '532', caisse: '541', retenue: '4353', retenue_a_payer: '4371',
};

const DEFAULT_CHART = [
  ['101', 'Capital social'], ['1061', 'Réserves'], ['12', 'Résultats reportés'], ['13', 'Résultat de l\'exercice'],
  ['1641', 'Emprunts auprès des établissements financiers'],
  ['2232', 'Matériel et outillage'], ['2234', 'Matériel de transport'], ['2238', 'Matériel informatique et mobilier de bureau'],
  ['37', 'Stocks de marchandises'],
  ['401', 'Fournisseurs d\'exploitation'], ['403', 'Fournisseurs - effets à payer'], ['409', 'Fournisseurs débiteurs (avances)'],
  ['411', 'Clients'], ['413', 'Clients - effets à recevoir'], ['416', 'Clients douteux ou litigieux'], ['419', 'Clients créditeurs (avances)'],
  ['421', 'Personnel - rémunérations dues'], ['4353', 'État, retenues à la source subies'], ['4341', 'État, impôt sur les sociétés'],
  ['43661', 'État, TVA collectée'], ['43662', 'État, TVA déductible'], ['43663', 'État, droit de timbre à payer'],
  ['4371', 'État, retenues à la source à payer'], ['453', 'Sécurité sociale (CNSS)'], ['471', 'Comptes d\'attente'],
  ['5111', 'Chèques à encaisser'], ['5112', 'Effets à l\'encaissement'], ['532', 'Banques'], ['541', 'Caisse'],
  ['601', 'Achats de matières premières'], ['604', 'Achats d\'études et prestations de services'], ['607', 'Achats de marchandises'],
  ['6061', 'Achats de fournitures non stockables (eau, énergie)'], ['613', 'Locations'], ['615', 'Entretien et réparations'],
  ['616', 'Primes d\'assurance'], ['622', 'Honoraires'], ['624', 'Transports'], ['625', 'Déplacements, missions et réceptions'],
  ['626', 'Frais postaux et de télécommunications'], ['627', 'Services bancaires'], ['640', 'Salaires et compléments de salaires'],
  ['647', 'Charges sociales légales'], ['651', 'Charges d\'intérêts'], ['661', 'Impôts, taxes et versements assimilés'],
  ['681', 'Dotations aux amortissements et provisions'],
  ['701', 'Ventes de produits finis'], ['706', 'Prestations de services'], ['707', 'Ventes de marchandises'],
  ['709', 'Rabais, remises et ristournes accordés'], ['731', 'Produits financiers'], ['75', 'Autres gains ordinaires'],
];

const DEFAULT_PLANS = [
  { code: 'essentiel', name: 'Essentiel', description: 'Pour les indépendants et très petites entreprises', price_month: 39, price_year: 390, max_users: 2, sort: 1,
    features: ['2 utilisateurs', 'Ventes, factures et avoirs', 'Recouvrement et relances', 'Achats et stocks', 'Comptabilité et TVA'] },
  { code: 'pro', name: 'Pro', description: 'Pour les PME qui veulent piloter toute leur gestion', price_month: 79, price_year: 790, max_users: 5, sort: 2,
    features: ['5 utilisateurs', 'Tous les modules', 'Balance âgée et agenda de relances', 'Grand livre, balance, aide TVA', 'Import Excel / CSV'] },
  { code: 'entreprise', name: 'Entreprise', description: 'Pour les équipes plus grandes', price_month: 149, price_year: 1490, max_users: 20, sort: 3,
    features: ['20 utilisateurs', 'Tous les modules', 'Accompagnement à la mise en place', 'Support prioritaire'] },
];

const DEFAULT_PLATFORM = {
  trial_days: 14,
  contact_phone: '',
  contact_whatsapp: '',
  contact_email: '',
  bank_name: '',
  bank_rib: '',
  bank_holder: '',
  d17_phone: '',
  payment_note: 'Indiquez le nom de votre entreprise dans le libellé du virement.',
};

async function migrate() {
  if (SCHEMA !== 'public') await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);

  const { rows } = await db.query('SELECT count(*)::int AS n FROM plans');
  if (!rows[0].n) {
    for (const p of DEFAULT_PLANS) {
      await db.query('INSERT INTO plans (code, name, description, price_month, price_year, max_users, features, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p.code, p.name, p.description, p.price_month, p.price_year, p.max_users, JSON.stringify(p.features), p.sort]);
    }
  }
  await db.query(`INSERT INTO platform_settings (key, value) VALUES ('platform', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(DEFAULT_PLATFORM)]);

  const email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  if (email && password) {
    const ex = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!ex.rows.length) {
      await db.query(`INSERT INTO users (company_id, name, email, password_hash, role) VALUES (NULL, 'Administrateur SEDDIK CRM', $1, $2, 'superadmin')`,
        [email, hashPassword(password)]);
      console.log('Compte super-administrateur créé :', email);
    }
  }
}

async function platformSettings() {
  const { rows } = await db.query(`SELECT value FROM platform_settings WHERE key = 'platform'`);
  return Object.assign({}, DEFAULT_PLATFORM, rows[0] ? rows[0].value : {});
}

// Numérotation séquentielle par entreprise, clé et année
async function nextNumber(c, companyId, key, prefix, date) {
  const year = new Date(date || Date.now()).getUTCFullYear();
  const { rows } = await c.query(
    `INSERT INTO counters (company_id, key, year, value) VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_id, key, year) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [companyId, key, year]);
  return `${prefix}${String(year).slice(2)}-${String(rows[0].value).padStart(5, '0')}`;
}

async function seedCompany(c, companyId) {
  for (const [code, name] of DEFAULT_CHART) {
    await c.query('INSERT INTO accounts (company_id, code, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [companyId, code, name]);
  }
}

module.exports = { db, migrate, round3, localToday, nextNumber, seedCompany, platformSettings, DEFAULT_PREFIXES, DEFAULT_ACCOUNTS_MAP, SCHEMA };
