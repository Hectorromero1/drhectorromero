import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { webhookRouter } from './routes/webhook';
import { startMessageWorker } from './workers/messageWorker';
import { startFollowUpWorker } from './workers/followUpWorker';
import { boss, barrerPendientes, QUEUE_NAME } from './queue';
import { db } from './db/client';
import { SCHEMA_SQL } from './db/schema';
import { getConfig } from './config';
import { warnIfApiKeysLookSwapped } from './env';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);

// Endpoint de admin para debugging — listar las últimas conversaciones.
//
// Va detrás de un token porque devuelve datos de contactos reales (nombre e id
// de GHL de cada persona que le ha escrito al bot). Estuvo abierto a internet
// y cualquiera con la URL podía descargar la lista completa — es el E70 de la
// skill `errores-bot`, que se encontró en producción el 22/09/2026.
//
// Falla CERRADO: sin `ADMIN_TOKEN` seteado nadie entra. Y no tumba el proceso
// al arrancar a propósito: dejar sin WhatsApp a un negocio por una variable
// que solo afecta a un endpoint de debugging sería peor que el hueco.
function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    console.warn('[admin] Rechazado — falta ADMIN_TOKEN en el entorno');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const provided = req.header('x-admin-token') ?? '';
  // Comparación de tiempo constante: un `!==` filtra el token carácter a
  // carácter ante quien pueda medir la respuesta.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn(`[admin] Rechazado | ua="${req.header('user-agent') ?? 'unknown'}"`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/admin/conversations', requireAdminToken, async (_req, res) => {
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

  warnIfApiKeysLookSwapped();

  await db.query('SELECT 1');
  console.log('[db] Connected');

  // Migraciones idempotentes (IF NOT EXISTS) — corren en cada arranque
  await db.query(SCHEMA_SQL);
  console.log('[db] Migrations applied');

  // Sin este listener, un error de conexión de pg-boss (ej. "Connection
  // terminated due to connection timeout") se emite como 'error' sin nadie
  // escuchando y tumba el proceso. Railway lo reinicia, pero solo unas veces
  // seguidas (restartPolicyMaxRetries): una caída de la base de unos minutos
  // podía dejar el bot apagado hasta que alguien lo prendiera a mano (E172).
  // Con el listener, pg-boss loguea y el worker sigue en el siguiente ciclo.
  boss.on('error', (err) => {
    console.error('[queue] pg-boss error:', err.message);
  });

  await boss.start();
  console.log('[queue] pg-boss started');

  await startMessageWorker(config.behavior.worker_concurrency);

  // El worker de follow-ups solo arranca si hay bloque follow_ups: en el yaml.
  if (config.follow_ups) {
    await startFollowUpWorker(1);
  }

  // Barredor de mensajes que se quedaron sin turno (E150), cada minuto.
  setInterval(() => {
    barrerPendientes((sql, params) => db.query(sql, params)).catch(() => {});
  }, 60_000);

  // Perro guardián (E172): si hay mensajes que ya debían procesarse hace más
  // de 10 minutos y siguen sin tomar, el worker está muerto aunque el proceso
  // viva. Se sale con código 1 para que Railway reinicie (restartPolicy
  // ON_FAILURE). Mejor un reinicio que un fin de semana mudo con /health en verde.
  setInterval(async () => {
    try {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM pgboss.job
          WHERE name = $1 AND state IN ('created', 'retry')
            AND startafter < now() - interval '10 minutes'`,
        [QUEUE_NAME]
      );
      const atorados = Number(r.rows[0]?.n ?? 0);
      if (atorados > 0) {
        console.error(`[watchdog] ${atorados} mensaje(s) sin procesar hace más de 10 min — el worker no está tomando la cola, se reinicia el proceso`);
        process.exit(1);
      }
    } catch (err) {
      console.warn(`[watchdog] no se pudo revisar la cola: ${(err as Error).message}`);
    }
  }, 5 * 60_000);

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
