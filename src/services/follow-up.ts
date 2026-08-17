/**
 * Helpers para programar follow-ups (mensajes proactivos cuando el lead no
 * responde después de un tiempo).
 *
 * Todo se configura en el bloque `follow_ups:` de configuracion/bot.config.yaml:
 *
 *   - `cadence_hours: [3, 9]` → follow-up 1 a las +3h del último mensaje del
 *     bot, follow-up 2 a las +9h. Puedes poner 1, 2 o 3 intentos.
 *   - `window_start_hour` / `window_end_hour` → horario permitido de envío
 *     (ej. 7 a 21 = 7:00am a 9:00pm). Si el cálculo cae fuera, se pospone al
 *     próximo inicio de ventana.
 *   - `lost_after_hours` + `lost_stage` → opcional: cuántas horas después se
 *     marca el lead como perdido moviendo su opportunity a esa etapa del
 *     pipeline (requiere bloque `pipeline:` configurado).
 *
 * Respeto a la ventana WhatsApp 24h: si al momento de enviar ya pasaron más
 * de 23h desde el último mensaje del CLIENTE, el follow-up se omite (no se
 * puede mandar texto libre por WhatsApp fuera de la ventana).
 */

import { boss } from '../queue';
import { db } from '../db/client';
import { getConfig } from '../config';

const FOLLOW_UP_QUEUE = 'follow-up';
const MARK_LOST_QUEUE = 'mark-lead-lost';

const HOUR_MS = 3600 * 1000;

/**
 * Offset UTC de una timezone IANA en formato "-05:00", calculado con Intl.
 * Funciona para cualquier zona sin dependencias externas.
 */
function getZoneOffset(tz: string, atMs: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const raw =
    fmt.formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return '+00:00';
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`;
}

/** Convierte una fecha YYYY-MM-DD + hora local de la timezone a ms UTC. */
function zonedTimeToMs(yyyyMmDd: string, hour: number, tz: string): number {
  const offset = getZoneOffset(tz, Date.now());
  return new Date(`${yyyyMmDd}T${String(hour).padStart(2, '0')}:00:00${offset}`).getTime();
}

/** Devuelve { hour, dateStr } locales de la timezone para un instante dado. */
function zonedParts(targetMs: number, tz: string): { hour: number; dateStr: string } {
  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    partsFmt.formatToParts(new Date(targetMs)).map((p) => [p.type, p.value])
  );
  return {
    hour: parseInt(parts.hour, 10) % 24,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Ajusta la fecha-hora para caer dentro de la ventana de envío configurada.
 * Si el target ya está dentro, lo devuelve igual. Si está fuera, lo empuja
 * al próximo inicio de ventana (hoy o mañana según corresponda).
 */
export function clampToWindow(targetMs: number): number {
  const fu = getConfig().follow_ups;
  if (!fu) return targetMs;

  const { hour, dateStr } = zonedParts(targetMs, fu.timezone);

  // Caso 1: en ventana → no cambia nada
  if (hour >= fu.window_start_hour && hour < fu.window_end_hour) {
    return targetMs;
  }

  // Caso 2: antes del inicio → mover a hoy al inicio de la ventana
  if (hour < fu.window_start_hour) {
    return zonedTimeToMs(dateStr, fu.window_start_hour, fu.timezone);
  }

  // Caso 3: después del fin → mover a mañana al inicio de la ventana
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDateStr = next.toISOString().slice(0, 10);
  return zonedTimeToMs(nextDateStr, fu.window_start_hour, fu.timezone);
}

/**
 * Cancela cualquier follow-up / marca-lead-perdido que ya estuviera en cola
 * para este contacto (programado en un turno anterior). Se llama:
 *   - al inicio de scheduleFollowUps, antes de programar la tanda nueva.
 *   - justo después de un agendar_cita o escalar_a_humano exitoso, desde
 *     messageWorker.ts — ahí no se va a reprogramar nada más, así que hace
 *     falta cancelar explícito lo que hubiera quedado pendiente de antes.
 */
export async function cancelarFollowUpsPendientes(contactId: string): Promise<void> {
  if (!getConfig().follow_ups) return;
  try {
    const res = await db.query<{ id: string }>(
      `select id from pgboss.job
       where name in ('follow-up','mark-lead-lost')
         and state in ('created','retry','active')
         and data->>'contactId' = $1`,
      [contactId]
    );
    for (const row of res.rows) {
      await boss.cancel(row.id).catch(() => {});
    }
    if (res.rows.length > 0) {
      console.log(`[follow-up] cancelados ${res.rows.length} pendientes | contact=${contactId}`);
    }
  } catch (e) {
    console.warn(`[follow-up] cancelar pendientes falló: ${(e as Error).message}`);
  }
}

/**
 * Programa los follow-ups (uno por entrada de cadence_hours) + el job de
 * marca-lead-perdido (si está configurado) para un contacto, a partir del
 * momento del último mensaje del bot.
 *
 * Best-effort: si pg-boss falla, sólo loguea (no rompe el flujo de respuesta).
 */
export async function scheduleFollowUps(contactId: string, baseMs?: number): Promise<void> {
  const fu = getConfig().follow_ups;
  if (!fu) return;

  // Cancela cualquier tanda de follow-ups/marca-perdido que hubiera quedado
  // pendiente de un turno anterior de ESTA misma conversación. Sin esto, cada
  // turno agrega una tanda nueva sin quitar las viejas — el worker las filtra
  // igual con el chequeo "stale" (ver followUpWorker.ts), pero cancelarlas
  // acá evita acumular jobs y llamadas a la base de datos de más.
  await cancelarFollowUpsPendientes(contactId);

  const t0 = baseMs ?? Date.now();
  const jobs: Promise<unknown>[] = [];
  const logParts: string[] = [];

  fu.cadence_hours.forEach((hours, i) => {
    const attempt = i + 1;
    const fireMs = clampToWindow(t0 + hours * HOUR_MS);
    jobs.push(
      boss.send(
        FOLLOW_UP_QUEUE,
        { contactId, attempt, scheduledAt: t0 },
        { singletonKey: `${contactId}:fu${attempt}:${t0}`, startAfter: new Date(fireMs), retryLimit: 2 }
      )
    );
    logParts.push(`fu${attempt}=${new Date(fireMs).toISOString()}`);
  });

  if (fu.lost_after_hours && fu.lost_stage) {
    const lostMs = clampToWindow(t0 + fu.lost_after_hours * HOUR_MS);
    jobs.push(
      boss.send(
        MARK_LOST_QUEUE,
        { contactId, scheduledAt: t0 },
        { singletonKey: `${contactId}:lost:${t0}`, startAfter: new Date(lostMs), retryLimit: 2 }
      )
    );
    logParts.push(`lost=${new Date(lostMs).toISOString()}`);
  }

  try {
    await Promise.all(jobs);
    console.log(`[follow-up] programado | contact=${contactId} ${logParts.join(' ')}`);
  } catch (err) {
    console.warn(`[follow-up] schedule failed | contact=${contactId} err=${(err as Error).message}`);
  }
}

/**
 * Detecta si un mensaje entrante es respuesta a una plantilla de confirmación
 * de cita (botones "Sí asistiré" / "No asistiré"). Devuelve:
 *   'yes' → confirmó asistencia
 *   'no'  → no asistirá (hay que reagendar)
 *   null  → no es una respuesta de confirmación
 *
 * Normaliza acentos/mayúsculas. El keyword ancla es "asistir" (específico de
 * las plantillas de confirmación) para no confundir un "sí"/"no" de
 * conversación normal.
 */
export function detectAttendanceConfirmation(text: string): 'yes' | 'no' | null {
  if (!text) return null;
  const norm = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos
    .trim();

  if (!norm.includes('asistir')) return null;
  // "no asistire" / "no voy a asistir" → no
  if (/\bno\b/.test(norm)) return 'no';
  // "si asistire" / "asistire" / "claro que asistire" → yes
  return 'yes';
}

export { FOLLOW_UP_QUEUE, MARK_LOST_QUEUE, HOUR_MS };
