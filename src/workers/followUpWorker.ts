/**
 * Worker que procesa los jobs de follow-up y de marca-lead-perdido.
 *
 * Cada job verifica que sigue siendo válido antes de ejecutar:
 *   - El cliente NO respondió desde que se programó.
 *   - El bot NO escribió un mensaje más nuevo (que disparó nuevos follow-ups).
 *   - Si hay `entry_stage` configurada: la opportunity sigue en esa etapa
 *     (no agendó, no escaló, no avanzó).
 *   - Estamos dentro de la ventana 24h de WhatsApp.
 *   - Estamos dentro del horario de envío (sino, se re-programa).
 *
 * El texto de cada follow-up se GENERA con Claude, dándole la conversación
 * real como contexto — así retoma exactamente lo que quedó pendiente (un
 * dato que faltaba, un horario sin confirmar) en vez de un mensaje genérico.
 * Si esa llamada falla, se usa como respaldo el mensaje PREDEFINIDO de
 * `follow_ups.messages` en bot.config.yaml (uno por intento de la cadencia,
 * soporta `{nombre}`).
 */

import { boss } from '../queue';
import { db } from '../db/client';
import { ChatMessage, GhlChannel } from '../types';
import { findContactOpportunity, moveOpportunityToStage, sendMessage } from '../services/ghl';
import { generateFollowUpMessage } from '../services/claude';
import { getConfig } from '../config';
import {
  FOLLOW_UP_QUEUE,
  MARK_LOST_QUEUE,
  HOUR_MS,
  clampToWindow,
} from '../services/follow-up';

interface FollowUpJobData {
  contactId: string;
  attempt: number;
  scheduledAt: number;
}

interface MarkLostJobData {
  contactId: string;
  scheduledAt: number;
}

/** Devuelve la hora actual en la timezone configurada como número (0-23). */
function nowHourInZone(tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10) % 24;
}

/**
 * Si estamos fuera del horario de envío, re-programa el mismo job al próximo
 * inicio de ventana y devuelve true (caller debería terminar sin enviar).
 */
async function deferIfOutOfWindow(
  queueName: string,
  data: FollowUpJobData | MarkLostJobData,
  contactId: string
): Promise<boolean> {
  const fu = getConfig().follow_ups;
  if (!fu) return false;

  const h = nowHourInZone(fu.timezone);
  if (h >= fu.window_start_hour && h < fu.window_end_hour) return false;

  const nextSlot = clampToWindow(Date.now() + 5 * 60 * 1000);
  await boss.send(queueName, data, {
    singletonKey: `${contactId}:defer:${data.scheduledAt}:${Date.now()}`,
    startAfter: new Date(nextSlot),
  });
  console.log(`[follow-up] fuera de ventana, re-programado a ${new Date(nextSlot).toISOString()} | contact=${contactId} queue=${queueName}`);
  return true;
}

/**
 * Renderiza el texto predefinido del follow-up. Soporta el placeholder
 * `{nombre}`: se reemplaza con el primer nombre del contacto, o se elimina
 * (limpiando espacios dobles) si no lo conocemos.
 */
export function renderFollowUpMessage(template: string, contactName: string | null): string {
  const firstName = (contactName ?? '').trim().split(/\s+/)[0] ?? '';
  let text = template.replace(/\{nombre\}/gi, firstName);
  if (!firstName) {
    // Sin nombre quedan huecos tipo "Hola , ..." — los limpiamos.
    text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
  }
  return text.trim();
}

/**
 * Resuelve el ID de una etapa del pipeline configurado a partir de su nombre.
 * Devuelve null si no hay pipeline o la etapa no está en bot.config.yaml.
 */
function stageIdByName(stageName: string): string | null {
  const cfg = getConfig();
  if (!cfg.pipeline) return null;
  return cfg.pipeline.stages.find((s) => s.name === stageName)?.id ?? null;
}

/**
 * Si hay `entry_stage` configurada, verifica que la opportunity del contacto
 * siga en esa etapa. Devuelve false cuando la opp ya avanzó (se agendó,
 * escaló, etc.) → el follow-up/mark-lost debe saltarse.
 */
async function stillInEntryStage(contactId: string): Promise<boolean> {
  const cfg = getConfig();
  const fu = cfg.follow_ups;
  if (!fu?.entry_stage || !cfg.pipeline) return true;

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return true;

  const entryId = stageIdByName(fu.entry_stage);
  if (!entryId) {
    console.warn(`[follow-up] entry_stage "${fu.entry_stage}" no está en pipeline.stages del yaml`);
    return true;
  }

  const opps = await findContactOpportunity(contactId, cfg.pipeline.id, locationId);
  const opp = opps[0];
  if (!opp) return true; // sin opportunity no hay señal — dejamos pasar

  if (opp.pipelineStageId !== entryId) {
    console.log(`[follow-up] opp ya está en otra etapa | contact=${contactId} stage=${opp.pipelineStageId.slice(0, 8)}`);
    return false;
  }
  return true;
}

async function handleFollowUp(data: FollowUpJobData): Promise<void> {
  const { contactId, attempt, scheduledAt } = data;
  const fu = getConfig().follow_ups;
  if (!fu) return;

  console.log(`[follow-up] fired | contact=${contactId} attempt=${attempt}`);

  // 1. Re-programar si estamos fuera de ventana
  if (await deferIfOutOfWindow(FOLLOW_UP_QUEUE, data, contactId)) return;

  // 2. Cargar conversación
  const r = await db.query(
    `SELECT messages, metadata, contact_name, follow_ups_sent, last_bot_message_at FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  if (r.rows.length === 0) {
    console.log(`[follow-up] sin conversación | contact=${contactId}`);
    return;
  }
  const { messages, metadata, contact_name, follow_ups_sent, last_bot_message_at } = r.rows[0];
  const history: ChatMessage[] = messages || [];

  // 3. Si el bot escribió DESPUÉS de programar este job, esta cadencia está stale
  const lastBotMs = last_bot_message_at ? new Date(last_bot_message_at).getTime() : 0;
  if (lastBotMs > scheduledAt + 60_000) {
    console.log(`[follow-up] stale (bot reescribió) | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 4. Si el cliente respondió desde scheduledAt, no hace falta el follow-up
  const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
  const lastUserMs = lastUserMsg ? new Date(lastUserMsg.ts).getTime() : 0;
  if (lastUserMs > scheduledAt) {
    console.log(`[follow-up] cliente respondió | contact=${contactId} attempt=${attempt}`);
    return;
  }

  // 5. Idempotencia: si ya enviamos un follow-up >= attempt, skip
  if ((follow_ups_sent ?? 0) >= attempt) {
    console.log(`[follow-up] ya enviado attempt=${attempt} | contact=${contactId}`);
    return;
  }

  // 6. Ventana WhatsApp 24h desde último mensaje del cliente
  const horasDesdeCliente = (Date.now() - lastUserMs) / HOUR_MS;
  if (horasDesdeCliente >= 23) {
    console.log(`[follow-up] fuera de ventana WhatsApp 24h (${horasDesdeCliente.toFixed(1)}h) | contact=${contactId}`);
    return;
  }

  // 7. Skip si la opportunity ya avanzó de etapa (agendó / escaló / etc.)
  if (!(await stillInEntryStage(contactId))) return;

  // 8. Generar el mensaje CONTEXTUAL con Claude (retoma lo que quedó
  // pendiente en la conversación real) — si falla, usa el predefinido del
  // yaml como respaldo, para nunca dejar de mandar el follow-up.
  const template = fu.messages[attempt - 1];
  if (!template) {
    console.warn(`[follow-up] no hay mensaje definido para attempt=${attempt} | contact=${contactId}`);
    return;
  }

  let text: string;
  try {
    const horasDesdeClienteReal = (Date.now() - lastUserMs) / HOUR_MS;
    text = await generateFollowUpMessage(history, attempt, fu.cadence_hours.length, horasDesdeClienteReal);
    if (!text) throw new Error('respuesta vacía');
    console.log(`[follow-up] generado contextual | contact=${contactId} attempt=${attempt}`);
  } catch (e) {
    console.warn(`[follow-up] generación contextual falló, uso respaldo del yaml: ${(e as Error).message}`);
    text = renderFollowUpMessage(template, contact_name ?? null);
  }

  if (!text) {
    console.log(`[follow-up] mensaje quedó vacío | contact=${contactId}`);
    return;
  }

  const channel: GhlChannel =
    ((metadata as { channel?: string } | null)?.channel as GhlChannel | undefined) ?? 'WhatsApp';

  await sendMessage(contactId, text, channel);

  // 9. Persistir: append al historial + incrementar contador + bump last_bot_message_at
  const now = new Date().toISOString();
  const newMessages = [...history, { role: 'assistant' as const, content: text, ts: now }];
  await db.query(
    `UPDATE conversations
     SET messages = $1::jsonb,
         follow_ups_sent = $2,
         last_bot_message_at = now(),
         last_activity = now()
     WHERE contact_id = $3`,
    [JSON.stringify(newMessages), attempt, contactId]
  );

  console.log(`[follow-up] enviado | contact=${contactId} attempt=${attempt} channel=${channel} chars=${text.length}`);
}

async function handleMarkLost(data: MarkLostJobData): Promise<void> {
  const { contactId, scheduledAt } = data;
  const cfg = getConfig();
  const fu = cfg.follow_ups;
  if (!fu?.lost_stage || !cfg.pipeline || !process.env.GHL_LOCATION_ID) return;

  console.log(`[mark-lost] fired | contact=${contactId}`);

  // 1. Cargar conversación
  const r = await db.query(
    `SELECT messages, last_bot_message_at FROM conversations WHERE contact_id = $1`,
    [contactId]
  );
  if (r.rows.length === 0) return;
  const { messages, last_bot_message_at } = r.rows[0];
  const history: ChatMessage[] = messages || [];

  // 2. Stale check: si el bot reescribió, el lead sigue activo
  const lastBotMs = last_bot_message_at ? new Date(last_bot_message_at).getTime() : 0;
  if (lastBotMs > scheduledAt + 60_000) {
    console.log(`[mark-lost] stale | contact=${contactId}`);
    return;
  }

  // 3. Si el cliente respondió después, skip
  const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
  const lastUserMs = lastUserMsg ? new Date(lastUserMsg.ts).getTime() : 0;
  if (lastUserMs > scheduledAt) {
    console.log(`[mark-lost] cliente respondió | contact=${contactId}`);
    return;
  }

  // 4. Solo movemos si sigue en la etapa de entrada (no pisamos etapas avanzadas)
  if (!(await stillInEntryStage(contactId))) {
    console.log(`[mark-lost] opp ya en otra etapa, skip | contact=${contactId}`);
    return;
  }

  const stageId = stageIdByName(fu.lost_stage);
  if (!stageId) {
    console.warn(`[mark-lost] lost_stage "${fu.lost_stage}" no está en pipeline.stages del yaml`);
    return;
  }

  const opps = await findContactOpportunity(contactId, cfg.pipeline.id, process.env.GHL_LOCATION_ID);
  if (opps.length === 0) {
    console.log(`[mark-lost] sin opportunity | contact=${contactId}`);
    return;
  }

  try {
    await moveOpportunityToStage(opps[0].id, stageId);
    console.log(`[mark-lost] OK | contact=${contactId} opp=${opps[0].id} → "${fu.lost_stage}"`);
  } catch (err) {
    console.warn(`[mark-lost] move failed | contact=${contactId}: ${(err as Error).message}`);
  }
}

export async function startFollowUpWorker(concurrency = 1): Promise<void> {
  await boss.work<FollowUpJobData>(
    FOLLOW_UP_QUEUE,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      try {
        await handleFollowUp(job.data);
      } catch (err) {
        console.error(`[follow-up] handler error: ${(err as Error).message}`);
        throw err;
      }
    }
  );

  await boss.work<MarkLostJobData>(
    MARK_LOST_QUEUE,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      try {
        await handleMarkLost(job.data);
      } catch (err) {
        console.error(`[mark-lost] handler error: ${(err as Error).message}`);
        throw err;
      }
    }
  );

  console.log(`[follow-up] worker started | concurrency=${concurrency}`);
}
