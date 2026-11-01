'use strict';
// SEDDIK CRM — serveur web (Node.js, sans dépendance externe)
const http = require('http');
const path = require('path');
const { App } = require('./lib/http');
const { migrate, SCHEMA } = require('./src/db');

const app = new App();
app.get('/api/health', async () => ({ ok: true, app: 'SEDDIK CRM', time: new Date().toISOString() }));
require('./src/auth').register(app);
require('./src/partners').register(app);
require('./src/documents').register(app);
require('./src/finance').register(app);
require('./src/accounting').register(app);
require('./src/billing').register(app);
app.static(path.join(__dirname, 'public'));

const PORT = Number(process.env.PORT || 3000);

async function start() {
  for (let attempt = 1; ; attempt++) {
    try { await migrate(); break; } catch (e) {
      console.error(`Base de données indisponible (tentative ${attempt}) :`, e.message);
      if (attempt >= 10) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    app.handle(req, res);
  });
  server.listen(PORT, () => console.log(`SEDDIK CRM en ligne sur le port ${PORT} (schéma ${SCHEMA})`));
}

start().catch((e) => { console.error(e); process.exit(1); });
