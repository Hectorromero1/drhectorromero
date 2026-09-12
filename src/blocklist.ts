/**
 * Lista negra de contactos que el bot NUNCA debe atender.
 *
 * Para qué sirve: cortar en seco una conversación que no debe existir — el
 * caso típico es otro bot al otro lado del WhatsApp. Dos bots conversando se
 * responden infinitamente entre sí, queman tokens y ensucian el pipeline de
 * GHL con un lead que no es una persona.
 *
 * El corte es TOTAL y silencioso:
 *   - el webhook descarta el entrante antes de tocar la base o la cola
 *   - el worker de mensajes descarta cualquier job que ya estuviera en cola
 *   - el worker de follow-ups nunca manda un proactivo a estos contactos
 *
 * Silencioso a propósito: cualquier respuesta (aunque sea "adiós") le da al
 * otro bot algo a qué contestar.
 *
 * Cómo agregar más contactos:
 *   - permanente → agrega el número a BLOQUEADOS aquí abajo y haz push
 *   - temporal / sin deploy → env var BLOCKED_NUMBERS en Railway, separada
 *     por comas: "3326305903, 8112345678". Acepta también contactIds de GHL.
 */

import { db } from './db/client';

/** Números y contactIds bloqueados de forma permanente (en código). */
const BLOQUEADOS: string[] = [
  // Bot al otro lado — se enganchó en un loop infinito con el agente.
  '3326305903',
];

/**
 * Normaliza un teléfono a sus últimos 10 dígitos, que es lo único estable
 * entre formatos: GHL manda "+523326305903", el CRM guarda "3326305903" y
 * a veces llega "52 1 33 2630 5903" con el 1 de móvil viejo de México.
 */
function normalizarTelefono(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  return digitos.length > 10 ? digitos.slice(-10) : digitos;
}

function entradasConfiguradas(): string[] {
  const desdeEnv = (process.env.BLOCKED_NUMBERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...BLOQUEADOS, ...desdeEnv];
}

/** Teléfonos bloqueados, normalizados (solo entradas de >= 10 dígitos). */
function telefonosBloqueados(): Set<string> {
  return new Set(
    entradasConfiguradas()
      .map(normalizarTelefono)
      .filter((d) => d.length === 10)
  );
}

/** ContactIds de GHL bloqueados (entradas que no son un teléfono). */
function contactIdsBloqueados(): Set<string> {
  return new Set(entradasConfiguradas().filter((e) => normalizarTelefono(e).length !== 10));
}

/** ¿Este teléfono está bloqueado? Chequeo sincrónico, sin tocar la base. */
export function telefonoBloqueado(phone?: string | null): boolean {
  if (!phone) return false;
  const norm = normalizarTelefono(phone);
  return norm.length === 10 && telefonosBloqueados().has(norm);
}

/**
 * ¿Este contacto está bloqueado? Chequeo sincrónico: sirve donde ya tenemos
 * el teléfono a la mano (webhook, job de la cola).
 */
export function contactoBloqueado(contactId?: string | null, phone?: string | null): boolean {
  if (contactId && contactIdsBloqueados().has(contactId)) return true;
  return telefonoBloqueado(phone);
}

// El follow-up worker solo tiene el contactId, así que ahí sí hay que ir a la
// base por el teléfono. Se cachea porque el teléfono de un contacto no cambia.
const cacheTelefonoPorContacto = new Map<string, string | null>();

/** Igual que contactoBloqueado, pero resuelve el teléfono desde la base. */
export async function contactoBloqueadoAsync(contactId: string): Promise<boolean> {
  if (contactIdsBloqueados().has(contactId)) return true;

  if (!cacheTelefonoPorContacto.has(contactId)) {
    try {
      const res = await db.query<{ phone: string | null }>(
        `SELECT phone FROM conversations WHERE contact_id = $1`,
        [contactId]
      );
      cacheTelefonoPorContacto.set(contactId, res.rows[0]?.phone ?? null);
    } catch (err) {
      // Si la base falla no bloqueamos de más: el gate del webhook ya filtró
      // el entrante, esto es defensa en profundidad.
      console.warn(`[blocklist] no se pudo resolver teléfono | contact=${contactId}: ${(err as Error).message}`);
      return false;
    }
  }

  return telefonoBloqueado(cacheTelefonoPorContacto.get(contactId) ?? null);
}
