import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { webhookRouter } from './routes/webhook';
import { startMessageWorker } from './workers/messageWorker';
import { startFollowUpWorker } from './workers/followUpWorker';
import { boss } from './queue';
import { db } from './db/client';
import { SCHEMA_SQL } from './db/schema';
import { getConfig } from './config';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);

// Endpoint de admin para debugging — listar las últimas conversaciones
app.get('/admin/conversations', async (_req, res) => {
  const result = await db.query(
    'SELECT contact_id, contact_name, last_activity FROM conversations ORDER BY last_activity DESC LIMIT 20'
  );
  res.json(result.rows);
});

// Middleware global de errores — captura cualquier error async de las rutas
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Cargar y validar configuracion/bot.config.yaml antes que nada — si tiene
  // un error, mejor fallar acá con un mensaje claro que más adelante.
  const config = getConfig();
  console.log(`[config] Loaded for bot=${config.bot.name} (${config.business.name})`);

  await db.query('SELECT 1');
  console.log('[db] Connected');

  // Migraciones idempotentes (IF NOT EXISTS) — corren en cada arranque
  await db.query(SCHEMA_SQL);
  console.log('[db] Migrations applied');

  await boss.start();
  console.log('[queue] pg-boss started');

  await startMessageWorker(config.behavior.worker_concurrency);

  // El worker de follow-ups solo arranca si hay bloque follow_ups: en el yaml.
  if (config.follow_ups) {
    await startFollowUpWorker(1);
  }

  app.listen(PORT, () => {
    console.log(`[server] ${config.bot.name} listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

// Graceful shutdown — Railway manda SIGTERM antes de matar el contenedor.
// Deja que los jobs activos terminen antes de apagarse.
async function shutdown() {
  console.log('[shutdown] Stopping worker and queue...');
  await boss.stop({ graceful: true, timeout: 30000 });
  await db.end();
  console.log('[shutdown] Done.');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
