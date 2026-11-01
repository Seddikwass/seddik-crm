# SEDDIK CRM

Gestion commerciale et comptable en ligne pour les entreprises tunisiennes, vendue par abonnement.

## Modules

- **Ventes** : devis → commande → bon de livraison → facture → avoir, numérotation automatique, timbre fiscal, TVA 19 / 13 / 7 %, montant en lettres, impression PDF, envoi WhatsApp ou e-mail.
- **Recouvrement** : balance âgée, agenda des relances (amiable, ferme, mise en demeure), promesses de paiement, règlements avec retenue à la source, chèques et traites à échéance, impayés.
- **Achats et stocks** : commandes et réceptions fournisseurs, factures fournisseurs, coût moyen pondéré, inventaires, alertes de stock minimum.
- **Comptabilité** : écritures automatiques (journaux VT, AC, BQ, CA), saisie manuelle (OD), grand livre, balance générale, aide à la déclaration de TVA, trésorerie, plan comptable modifiable.
- **Abonnements** : essai gratuit, formules Essentiel / Pro / Entreprise, paiement en ligne Konnect (carte, e-DINAR) ou virement / D17 validé par l'administrateur, accès en lecture seule à l'expiration.
- **Console de la plateforme** : entreprises clientes, paiements à valider, prix des formules, réglages.

Chaque entreprise ne voit que ses propres données.

## Technique

Node.js ≥ 20 sans aucune dépendance externe (serveur HTTP, client PostgreSQL et sécurité écrits dans `lib/`), base PostgreSQL, interface en modules JavaScript natifs dans `public/`.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Chaîne de connexion PostgreSQL |
| `DB_SCHEMA` | Schéma PostgreSQL utilisé (défaut `public`) ; permet de partager une base |
| `SESSION_SECRET` | Clé secrète des sessions (longue et aléatoire) |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | Compte administrateur de la plateforme, créé au premier démarrage |
| `APP_URL` | Adresse publique du site (pour le retour de paiement Konnect) |
| `KONNECT_API_KEY`, `KONNECT_WALLET_ID`, `KONNECT_ENV` | Paiement en ligne Konnect (`KONNECT_ENV=production` pour les vrais paiements) |

## Lancer en local

```
DATABASE_URL=postgres://user:motdepasse@localhost:5432/seddik SESSION_SECRET=... node server.js
```

Le schéma de la base est créé automatiquement au démarrage.
