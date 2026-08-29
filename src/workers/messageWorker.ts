import { boss, QUEUE_NAME } from '../queue';
import { MessageJobData, ChatMessage, GhlChannel } from '../types';
import { getClaudeResponse, splitMessage, AttachmentBlock } from '../services/claude';
import {
  sendMessage,
  fetchAsBase64,
  findContactOpportunity,
  moveOpportunityToStage,
  updateContactName,
  updateContactCustomField,
  createNote,
  getContact,
} from '../services/ghl';
import {
  getFreeSlots,
  createAppointment,
  getContactAppointments,
  addTagsToContact,
  FreeSlot,
} from '../services/ghl-calendar';
import { transcribirAudio } from '../services/whisper';
import { db } from '../db/client';
import { getConfig } from '../config';
import {
  scheduleFollowUps,
  detectAttendanceConfirmation,
  cancelarFollowUpsPendientes,
} from '../services/follow-up';

/**
 * Handler de tools — recibe el nombre de la tool que Claude llamó y el
 * contactId del mensaje en proceso (pasado via closure). Devuelve un string
 * (típicamente JSON) que Claude verá como tool_result.
 *
 * Por contrato: este handler NUNCA debe lanzar. Si algo falla, retorna un
 * JSON con `error` y un `message` legible para que el modelo decida cómo
 * reaccionar (típicamente "continúa la conversación normalmente").
 */
async function handleTool(
  name: string,
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  switch (name) {
    case 'mover_a_etapa':
      return handleMoverAEtapa(input, contactId);
    case 'consultar_disponibilidad':
      return handleConsultarDisponibilidad(input);
    case 'agendar_cita':
      return handleAgendarCita(input, contactId);
    case 'cliente_frecuente':
      return handleClienteFrecuente(contactId);
    case 'escalar_a_humano':
      return handleEscalarAHumano(input, contactId);
    case 'actualizar_campo':
      return handleActualizarCampo(input, contactId);
  }
  console.warn(`[tool] No implementada: ${name} input=${JSON.stringify(input)}`);
  return JSON.stringify({ error: 'tool_not_implemented', tool: name });
}

/**
 * Mueve automáticamente la opportunity del contacto a la etapa indicada por
 * NOMBRE (buscada en bot.config.yaml). Llamada desde los handlers cuando
 * ocurre un evento que dispara movimiento (cita agendada, escalación, etc).
 *
 * Best-effort: si falla, sólo loguea — no rompe el flujo del bot.
 */
async function autoMoveStage(contactId: string, stageName: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg.pipeline) return;

  const stage = cfg.pipeline.stages.find((s) => s.name === stageName);
  if (!stage) {
    console.warn(`[pipeline:auto] stage no configurada: "${stageName}"`);
    return;
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) return;

  try {
    const opps = await findContactOpportunity(contactId, cfg.pipeline.id, locationId);
    if (opps.length === 0) {
      console.warn(`[pipeline:auto] sin opportunity | contact=${contactId} → "${stageName}" (saltado)`);
      return;
    }
    const chosen = opps.length > 1
      ? [...opps].sort((a, b) => {
          const ka = a.updatedAt ?? a.createdAt ?? '';
          const kb = b.updatedAt ?? b.createdAt ?? '';
          return kb.localeCompare(ka);
        })[0]
      : opps[0];

    if (chosen.pipelineStageId === stage.id) {
      console.log(`[pipeline:auto] ya en "${stageName}" | contact=${contactId}`);
      return;
    }
    await moveOpportunityToStage(chosen.id, stage.id);
    console.log(`[pipeline:auto] movido | contact=${contactId} opp=${chosen.id} → "${stageName}"`);
  } catch (err) {
    console.warn(`[pipeline:auto] error | contact=${contactId} → "${stageName}": ${(err as Error).message}`);
  }
}

// ─── Calendar tools ──────────────────────────────────────────────────────────

/**
 * Determina qué agenda(s) consultar según el motivo y la preferencia explícita.
 * - agenda="any" o ausente → aplica routing por palabras clave del motivo,
 *   luego el default del routing.
 * - agenda="<key>" → solo esa.
 */
function resolveAgendas(motivo: string, agendaParam?: string): string[] {
  const cfg = getConfig();
  if (!cfg.calendars) return [];
  const allKeys = Object.keys(cfg.calendars.agendas);
  const validate = (keys: string[]): string[] =>
    keys.filter((k) => cfg.calendars!.agendas[k]);
  const fromRoute = (route: string | string[]): string[] => {
    if (Array.isArray(route)) return validate(route);
    if (route === 'any') return allKeys;
    return validate([route]);
  };

  if (agendaParam && agendaParam !== 'any' && cfg.calendars.agendas[agendaParam]) {
    return [agendaParam];
  }

  const lower = motivo.toLowerCase();
  for (const [keyword, route] of Object.entries(cfg.calendars.routing)) {
    if (keyword === 'default') continue;
    if (lower.includes(keyword)) {
      const resolved = fromRoute(route);
      if (resolved.length > 0) return resolved;
    }
  }

  const defaultRoute = cfg.calendars.routing.default ?? 'any';
  const resolved = fromRoute(defaultRoute);
  return resolved.length > 0 ? resolved : allKeys;
}

function extractHour(iso: string): number {
  const m = iso.match(/T(\d{2}):/);
  return m ? parseInt(m[1], 10) : -1;
}

function formatSlotHuman(iso: string, timezone: string): { fecha: string; hora: string } {
  const d = new Date(iso);
  const fecha = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  const hora = new Intl.DateTimeFormat('es', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return { fecha, hora };
}

async function handleConsultarDisponibilidad(input: Record<string, unknown>): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : undefined;
  const desdeFecha = typeof input.desde_fecha === 'string' ? input.desde_fecha : undefined;
  const horario = typeof input.horario_preferido === 'string' ? input.horario_preferido : 'cualquiera';
  const cantidad = typeof input.cantidad === 'number' && input.cantidad > 0
    ? Math.min(input.cantidad, 10)
    : 4;

  const agendaKeys = resolveAgendas(motivo, agenda);
  if (agendaKeys.length === 0) {
    return JSON.stringify({ error: 'no_agendas_resolved', motivo });
  }

  // Rango: 7 días desde desdeFecha (o ahora). En timestamps ms para GHL.
  const start = desdeFecha
    ? new Date(`${desdeFecha}T00:00:00`)
    : new Date();
  if (isNaN(start.getTime())) {
    return JSON.stringify({ error: 'invalid_date', desde_fecha: desdeFecha });
  }
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Consulta en paralelo todos los calendarios resueltos.
  const allSlots: (FreeSlot & { agenda: string })[] = [];
  await Promise.all(
    agendaKeys.map(async (key) => {
      const ag = cfg.calendars!.agendas[key];
      try {
        const slots = await getFreeSlots(
          ag.calendar_id,
          start.getTime(),
          end.getTime(),
          cfg.calendars!.timezone
        );
        for (const s of slots) allSlots.push({ ...s, agenda: key });
      } catch (err) {
        console.warn(`[tool:consultar_disponibilidad] ${key} error: ${(err as Error).message}`);
      }
    })
  );

  // Filtro por horario_preferido (mañana < 12, tarde >= 14, cualquiera = todo).
  const filtered = allSlots.filter((s) => {
    const h = extractHour(s.iso);
    if (horario === 'mañana') return h < 12;
    if (horario === 'tarde') return h >= 14;
    return true;
  });

  // Orden cronológico + dedup por iso (por si dos agendas comparten un slot).
  const seen = new Set<string>();
  const unique = filtered
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .filter((s) => {
      if (seen.has(s.iso)) return false;
      seen.add(s.iso);
      return true;
    })
    .slice(0, cantidad);

  if (unique.length === 0) {
    return JSON.stringify({
      ok: true,
      slots: [],
      message: 'No hay disponibilidad en el rango consultado. Sugiere otro día o pregunta por otra preferencia.',
    });
  }

  const formatted = unique.map((s) => {
    const human = formatSlotHuman(s.iso, cfg.calendars!.timezone);
    const ag = cfg.calendars!.agendas[s.agenda];
    return {
      slot_iso: s.iso,
      agenda: s.agenda,
      agenda_nombre: ag.name,
      fecha: human.fecha,
      hora: human.hora,
    };
  });

  console.log(`[tool:consultar_disponibilidad] motivo="${motivo}" agendas=[${agendaKeys.join(',')}] returned=${formatted.length}`);
  return JSON.stringify({ ok: true, slots: formatted });
}

async function handleAgendarCita(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.calendars) {
    return JSON.stringify({ error: 'calendars_not_configured' });
  }

  const slotIso = typeof input.slot_iso === 'string' ? input.slot_iso : '';
  const agenda = typeof input.agenda === 'string' ? input.agenda : '';
  const nombreCompleto = typeof input.nombre_completo === 'string' ? input.nombre_completo.trim() : '';
  const motivo = typeof input.motivo === 'string' ? input.motivo : 'Cita';

  if (!slotIso || !agenda || !nombreCompleto) {
    return JSON.stringify({
      error: 'missing_params',
      message: 'Faltan datos obligatorios: slot_iso, agenda o nombre_completo.',
    });
  }

  const ag = cfg.calendars.agendas[agenda];
  if (!ag) {
    return JSON.stringify({ error: 'invalid_agenda', agenda });
  }

  // Límite de negocio OPCIONAL (calendars.max_active_appointments): si está
  // configurado, la 2da+ cita debe ser a nombre de una persona distinta a la
  // anterior (ej. un familiar agendando desde el mismo número).
  const maxActivas = cfg.calendars.max_active_appointments;
  let activas: Awaited<ReturnType<typeof getContactAppointments>> = [];
  if (maxActivas) {
    const existentes = await getContactAppointments(contactId);
    const now = Date.now();
    activas = existentes.filter((a) => {
      const t = new Date(a.startTime).getTime();
      const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
      return !isNaN(t) && t > now && !cancelada;
    });

    if (activas.length >= maxActivas) {
      return JSON.stringify({
        error: 'limite_de_citas',
        message:
          `Este contacto ya tiene ${maxActivas} cita(s) activa(s) agendada(s) — es el máximo permitido por este medio. ` +
          'Explícale con calidez que ya tiene el máximo de citas apartadas, y que si necesita una adicional debe ' +
          'contactar directamente al negocio.',
      });
    }

    if (activas.length >= 1) {
      const nombreExistente = (activas[activas.length - 1].title ?? '').split(' - ')[0].trim().toLowerCase();
      if (nombreExistente && nombreExistente === nombreCompleto.toLowerCase()) {
        return JSON.stringify({
          error: 'nombre_duplicado',
          message:
            `Este contacto ya tiene una cita agendada a nombre de "${activas[activas.length - 1].title?.split(' - ')[0]}". ` +
            'Si esta nueva cita es para la MISMA persona, dile que ya tiene una cita agendada y pregúntale ' +
            'si prefiere reagendar esa en vez de crear otra. Si es para una persona DISTINTA (ej. un ' +
            'familiar), pídele el nombre completo de esa otra persona y vuelve a llamar agendar_cita con ese nombre.',
        });
      }
    }
  }

  // endTime = startTime + duration_minutes
  const start = new Date(slotIso);
  if (isNaN(start.getTime())) {
    return JSON.stringify({ error: 'invalid_slot_iso', slot_iso: slotIso });
  }
  const end = new Date(start.getTime() + cfg.calendars.duration_minutes * 60 * 1000);

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  // Actualiza el nombre del contacto SOLO si todavía no tiene uno — así no se
  // pisa la identidad original cuando una 2da cita es de otra persona (ej. un
  // familiar agendado desde el mismo número de WhatsApp).
  try {
    const contacto = await getContact(contactId);
    if (!contacto?.firstName) {
      await updateContactName(contactId, nombreCompleto);
    }
  } catch (err) {
    console.warn(`[tool:agendar_cita] getContact/updateContactName failed: ${(err as Error).message}`);
  }

  try {
    const created = await createAppointment({
      calendarId: ag.calendar_id,
      locationId,
      contactId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      title: `${nombreCompleto} - ${motivo}`,
    });

    const human = formatSlotHuman(slotIso, cfg.calendars.timezone);

    // Nota informativa para el equipo, con los datos completos de la cita.
    await createNote(
      contactId,
      `📅 Nueva cita agendada por ${cfg.bot.name}\n` +
        `Contacto: ${nombreCompleto}\n` +
        `Motivo: ${motivo}\n` +
        `Agenda: ${ag.name}\n` +
        `Fecha: ${human.fecha} ${human.hora}`
    ).catch((err) => console.warn(`[tool:agendar_cita] note failed: ${(err as Error).message}`));

    // Si hay detail_field_id configurado: campo con el detalle completo,
    // listo para insertar como merge field en un Workflow de notificación
    // al equipo (ej. WhatsApp/push al dueño del negocio).
    if (cfg.calendars.detail_field_id) {
      await updateContactCustomField(
        contactId,
        cfg.calendars.detail_field_id,
        `Contacto: ${nombreCompleto} | Motivo: ${motivo} | Agenda: ${ag.name} | Fecha: ${human.fecha} ${human.hora}`
      ).catch((err) => console.warn(`[tool:agendar_cita] detail_field_id failed: ${(err as Error).message}`));
    }

    // Si hay notify_tag configurado: tag para que un Workflow de GHL
    // notifique al equipo (Internal Notification, no SMS).
    if (cfg.calendars.notify_tag) {
      await addTagsToContact(contactId, [cfg.calendars.notify_tag]).catch((err) =>
        console.warn(`[tool:agendar_cita] notify_tag failed: ${(err as Error).message}`)
      );
    }

    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    if (cfg.calendars.booked_stage) {
      autoMoveStage(contactId, cfg.calendars.booked_stage).catch(() => {});
    }

    // Ya tiene cita — cancela cualquier follow-up/marca-perdido que hubiera
    // quedado pendiente de antes de agendar.
    cancelarFollowUpsPendientes(contactId).catch(() => {});

    console.log(`[tool:agendar_cita] OK | contact=${contactId} appt=${created.id} agenda=${agenda} ${slotIso}`);
    return JSON.stringify({
      ok: true,
      appointment_id: created.id,
      agenda: ag.name,
      fecha_humana: human.fecha,
      hora_humana: human.hora,
    });
  } catch (err) {
    console.error(`[tool:agendar_cita] error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message:
        'No se pudo crear la cita. Probablemente el slot ya no está disponible. ' +
        'Vuelve a llamar consultar_disponibilidad y ofrece nuevas opciones.',
    });
  }
}

async function handleClienteFrecuente(contactId: string): Promise<string> {
  const appts = await getContactAppointments(contactId);

  // Solo cuentan appointments pasadas (no futuras ni slots bloqueados).
  const now = Date.now();
  const past = appts.filter((a) => {
    const t = new Date(a.startTime).getTime();
    return !isNaN(t) && t < now;
  });

  const lastDate = past
    .map((a) => a.startTime)
    .sort()
    .reverse()[0];

  return JSON.stringify({
    ok: true,
    es_recurrente: past.length > 0,
    total_citas_pasadas: past.length,
    ultima_cita: lastDate ?? null,
  });
}

async function handleEscalarAHumano(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.escalation) {
    return JSON.stringify({ error: 'escalation_not_configured' });
  }

  const motivoEscalacion = typeof input.motivo_escalacion === 'string'
    ? input.motivo_escalacion
    : 'sin motivo especificado';

  try {
    await addTagsToContact(contactId, [cfg.escalation.tag]);
    await createNote(
      contactId,
      `[ESCALACIÓN AUTOMÁTICA] El bot identificó que este contacto necesita atención humana. Motivo: ${motivoEscalacion}`
    );
    // Auto-mueve la opportunity a la etapa configurada (best-effort).
    if (cfg.escalation.stage) {
      autoMoveStage(contactId, cfg.escalation.stage).catch(() => {});
    }
    // Ya lo tiene un humano — cancela follow-ups/marca-perdido pendientes.
    cancelarFollowUpsPendientes(contactId).catch(() => {});
    console.log(`[tool:escalar_a_humano] OK | contact=${contactId} motivo="${motivoEscalacion}"`);
    return JSON.stringify({ ok: true });
  } catch (err) {
    console.error(`[tool:escalar_a_humano] error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo notificar al equipo automáticamente. Continúa la conversación con calidez.',
    });
  }
}

/**
 * Guarda un valor en un campo personalizado del contacto.
 *
 * Defensas:
 *   - El SDK ya validó que `campo` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si cambió en runtime.
 *   - Best-effort: si la API de GHL falla, el modelo recibe un error string
 *     y sigue conversando sin mencionarlo.
 */
async function handleActualizarCampo(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.custom_fields) {
    // Defensa: la tool no debería estar registrada si no hay custom_fields.
    return JSON.stringify({ error: 'custom_fields_not_configured' });
  }

  const campo = typeof input.campo === 'string' ? input.campo : '';
  const valor = typeof input.valor === 'string' ? input.valor.trim() : '';

  const field = cfg.custom_fields.fields.find((f) => f.name === campo);
  if (!field) {
    console.warn(`[tool:actualizar_campo] campo inválido: "${campo}"`);
    return JSON.stringify({
      error: 'invalid_field',
      message: `Campo "${campo}" no existe. Válidos: ${cfg.custom_fields.fields.map((f) => f.name).join(', ')}`,
    });
  }
  if (!valor) {
    return JSON.stringify({ error: 'empty_value', message: 'El valor no puede estar vacío.' });
  }

  try {
    await updateContactCustomField(contactId, field.id, valor);
    console.log(`[tool:actualizar_campo] OK | contact=${contactId} campo="${campo}" valor="${valor.slice(0, 60)}"`);
    return JSON.stringify({ ok: true, campo, valor });
  } catch (err) {
    console.error(`[tool:actualizar_campo] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo guardar el campo. Continúa la conversación normalmente.',
    });
  }
}

/**
 * Mueve la opportunity activa del contacto a la etapa que pidió el modelo.
 *
 * Defensas:
 *   - El SDK ya validó que `etapa` está en el enum del input_schema.
 *   - Re-validamos contra el yaml por si el yaml cambió en runtime.
 *   - Si no hay opportunity en el pipeline, devolvemos un error que le dice
 *     al modelo que siga conversando sin mencionarlo.
 *   - Idempotencia: si la opp ya está en la etapa target, no llamamos PUT.
 *   - Si hay múltiples opportunities en el pipeline (raro), movemos la más
 *     reciente y logueamos warning con todos los IDs.
 */
async function handleMoverAEtapa(
  input: Record<string, unknown>,
  contactId: string
): Promise<string> {
  const cfg = getConfig();
  if (!cfg.pipeline) {
    // Defensa: la tool no debería estar registrada si no hay pipeline.
    return JSON.stringify({ error: 'pipeline_not_configured' });
  }

  const etapa = typeof input.etapa === 'string' ? input.etapa : '';
  const target = cfg.pipeline.stages.find((s) => s.name === etapa);
  if (!target) {
    console.warn(`[tool:mover_a_etapa] etapa inválida: "${etapa}"`);
    return JSON.stringify({
      error: 'invalid_stage',
      message: `Etapa "${etapa}" no existe. Válidas: ${cfg.pipeline.stages.map((s) => s.name).join(', ')}`,
    });
  }

  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    console.error('[tool:mover_a_etapa] falta GHL_LOCATION_ID en env');
    return JSON.stringify({ error: 'config_error', message: 'GHL_LOCATION_ID no configurado' });
  }

  const opps = await findContactOpportunity(contactId, cfg.pipeline.id, locationId);

  if (opps.length === 0) {
    console.warn(`[tool:mover_a_etapa] sin opportunity | contact=${contactId} pipeline=${cfg.pipeline.id}`);
    return JSON.stringify({
      error: 'no_opportunity',
      message:
        `El contacto no tiene oportunidad activa en el pipeline "${cfg.pipeline.name}". ` +
        `Continúa la conversación normalmente sin mencionar este error.`,
    });
  }

  let chosen = opps[0];
  if (opps.length > 1) {
    chosen = [...opps].sort((a, b) => {
      const ka = a.updatedAt ?? a.createdAt ?? '';
      const kb = b.updatedAt ?? b.createdAt ?? '';
      return kb.localeCompare(ka);
    })[0];
    console.warn(
      `[tool:mover_a_etapa] múltiples opps (${opps.length}) | contact=${contactId} ` +
        `ids=[${opps.map((o) => o.id).join(',')}] usando más reciente=${chosen.id}`
    );
  }

  if (chosen.pipelineStageId === target.id) {
    console.log(`[tool:mover_a_etapa] ya en "${target.name}" | opp=${chosen.id}`);
    return JSON.stringify({ ok: true, already_in_stage: true, stage: target.name });
  }

  // Nunca mover hacia atrás a una etapa MANUAL (las que el modelo puede
  // elegir libremente) a un contacto que ya está en una etapa AUTO (las que
  // solo mueve el código, ej. al agendar o escalar — `when: "AUTO: ..."` en
  // bot.config.yaml). Evita que el bot "retroceda" el pipeline solo porque
  // el contacto le sigue escribiendo después de haber cerrado el ciclo.
  const etapaActual = cfg.pipeline.stages.find((s) => s.id === chosen.pipelineStageId);
  const esAuto = (s?: { when: string }) => s?.when.trim().toUpperCase().startsWith('AUTO');
  if (esAuto(etapaActual) && !esAuto(target)) {
    console.log(
      `[tool:mover_a_etapa] bloqueado regreso a etapa manual | contact=${contactId} etapa_actual="${etapaActual!.name}" target="${target.name}"`
    );
    return JSON.stringify({
      ok: true,
      blocked: true,
      message: `El contacto ya está en "${etapaActual!.name}" (etapa automática), no se mueve hacia atrás a "${target.name}". Continúa la conversación normalmente sin mencionar esto.`,
    });
  }

  try {
    await moveOpportunityToStage(chosen.id, target.id);
    console.log(
      `[tool:mover_a_etapa] OK | contact=${contactId} opp=${chosen.id} ` +
        `from=${chosen.pipelineStageId} to=${target.id} (${target.name})`
    );
    return JSON.stringify({ ok: true, moved_to: target.name });
  } catch (err) {
    console.error(`[tool:mover_a_etapa] API error: ${(err as Error).message}`);
    return JSON.stringify({
      error: 'api_error',
      message: 'No se pudo mover la oportunidad. Continúa la conversación normalmente.',
    });
  }
}

export async function startMessageWorker(concurrency = 5) {
  await boss.work<MessageJobData>(
    QUEUE_NAME,
    { teamSize: concurrency, teamConcurrency: concurrency },
    async (job) => {
      if (!job) return;
      const { contactId, phone, contactName, message, channel } = job.data;

      console.log(`[worker] Processing | contact=${contactId} channel=${channel ?? 'unknown'}`);

      // 1. Claim atómico del mensaje pendiente — previene race condition
      // entre reintentos. Usa CTE para capturar el valor antes de limpiarlo.
      const claimResult = await db.query(
        `WITH claimed AS (
           SELECT id, messages, pending_message, pending_attachments, metadata
           FROM conversations WHERE contact_id = $1
         )
         UPDATE conversations c
         SET pending_message = NULL, pending_at = NULL,
             pending_attachments = '[]'::jsonb
         FROM claimed
         WHERE c.id = claimed.id
         RETURNING claimed.id, claimed.messages, claimed.pending_message,
                   claimed.pending_attachments, claimed.metadata`,
        [contactId]
      );

      let conversation = claimResult.rows[0];

      if (!conversation) {
        const inserted = await db.query(
          `INSERT INTO conversations (contact_id, phone, contact_name, messages)
           VALUES ($1, $2, $3, '[]'::jsonb)
           RETURNING id, messages, pending_message, metadata`,
          [contactId, phone, contactName ?? null]
        );
        conversation = inserted.rows[0];
      }

      const messageToProcess = conversation.pending_message ?? message;
      if (!messageToProcess) {
        console.log(`[worker] Skipped duplicate | contact=${contactId}`);
        return;
      }

      const history: ChatMessage[] = conversation.messages ?? [];

      // 2. Procesar attachments pendientes
      // - Imágenes y PDFs van como bloques a Claude Vision
      // - Audios se transcriben con Whisper y reemplazan el placeholder
      const pendingAttachments = (conversation.pending_attachments ?? []) as Array<{ url: string; kind: string }>;
      const attachmentBlocks: AttachmentBlock[] = [];
      let messageForClaude = messageToProcess;

      for (const att of pendingAttachments) {
        const data = await fetchAsBase64(att.url);
        if (!data) continue;

        if (att.kind === 'image' || att.kind === 'pdf') {
          attachmentBlocks.push({
            kind: att.kind,
            base64: data.base64,
            mimeType: data.mimeType,
          });
        } else if (att.kind === 'audio') {
          const ext = att.url.split('?')[0].split('.').pop()?.toLowerCase() ?? 'ogg';
          const transcripcion = await transcribirAudio({
            base64: data.base64,
            mimeType: data.mimeType,
            ext,
          });
          if (transcripcion) {
            const placeholder = '[el contacto envió un audio]';
            const replacement = `[audio transcrito]: ${transcripcion}`;
            if (messageForClaude.includes(placeholder)) {
              messageForClaude = messageForClaude.replace(placeholder, replacement);
            } else {
              messageForClaude += `\n${replacement}`;
            }
            console.log(`[whisper] transcrito (${transcripcion.length} chars): ${transcripcion.slice(0, 80)}`);
          } else {
            console.warn('[worker] No se pudo transcribir audio');
          }
        }
      }

      // 3. Llamar a Claude
      // El contactId se pasa al handler via closure — lo necesitan las tools
      // para saber a qué contacto pertenece la opportunity/cita.
      //
      // El canal del entrante viene del job; si falta (jobs viejos), cae al
      // metadata.channel persistido por el webhook, y por último a WhatsApp.
      //
      // Si Claude falla (ej. error de red), restauramos el pending_message
      // que ya habíamos claimeado y propagamos el error para que pg-boss
      // reintente el job — así el mensaje NO se pierde.
      const metaChannel =
        (conversation.metadata as { channel?: string } | null)?.channel as GhlChannel | undefined;
      const inboundChannel: GhlChannel = channel ?? metaChannel ?? 'WhatsApp';

      let replyText: string;
      let toolCalls: Array<{ toolName: string }>;
      try {
        const result = await getClaudeResponse(
          history,
          messageForClaude,
          async (toolName, input) => handleTool(toolName, input, contactId),
          inboundChannel,
          attachmentBlocks
        );
        replyText = result.text;
        toolCalls = result.toolCalls;
      } catch (err) {
        console.error(`[worker] Claude falló, restaurando pending y reintentando | contact=${contactId}: ${(err as Error).message}`);
        await db.query(
          `UPDATE conversations
           SET pending_message = CASE
                 WHEN pending_message IS NULL OR pending_message = '' THEN $2
                 ELSE $2 || E'\\n' || pending_message
               END,
               pending_at = now()
           WHERE id = $1`,
          [conversation.id, messageToProcess]
        ).catch((e) => console.error(`[worker] restore pending falló: ${e.message}`));
        throw err; // pg-boss reintenta (retryLimit)
      }

      // 4. Guardar historial (máx 100 entradas)
      const MAX_STORED_MESSAGES = 100;
      const now = new Date().toISOString();
      const newMessages: ChatMessage[] = [
        ...history,
        { role: 'user' as const, content: messageForClaude, ts: now },
        { role: 'assistant' as const, content: replyText, ts: now },
      ].slice(-MAX_STORED_MESSAGES);

      const hasReply = !!replyText && replyText.trim().length > 0;

      await db.query(
        `UPDATE conversations
         SET messages = $1::jsonb,
             last_activity = now(),
             last_bot_message_at = CASE WHEN $3::boolean THEN now() ELSE last_bot_message_at END,
             follow_ups_sent = CASE WHEN $3::boolean THEN 0 ELSE follow_ups_sent END
         WHERE id = $2`,
        [JSON.stringify(newMessages), conversation.id, hasReply]
      );

      // 5. Enviar respuesta por el mismo canal del entrante
      if (hasReply) {
        const parts = splitMessage(replyText);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 800));
          await sendMessage(contactId, parts[i], inboundChannel);
        }

        // 6. Programar follow-ups (solo si hay bloque follow_ups: en el yaml).
        // Se suprimen cuando la conversación ya "cerró":
        //  - agendó cita en ESTE turno, o ya tiene una cita activa de un turno anterior
        //  - escaló a humano en ESTE turno, o ya está en la etapa de escalation.stage
        //  - confirmó asistencia a una plantilla de recordatorio ("Sí asistiré")
        //
        // Importante: la cita/escalación de turnos ANTERIORES se revisa contra el
        // estado real (GHL), no solo contra las tools usadas en este turno — si no,
        // un simple "gracias" después de agendar reprograma follow-ups innecesarios
        // para alguien que ya tiene su cita apartada.
        if (getConfig().follow_ups) {
          const usedTools = new Set(toolCalls.map((t) => t.toolName));
          // OJO: `mover_a_etapa` NO cuenta como cierre, aunque lo parezca. Las
          // etapas de cierre van marcadas `AUTO:` en el yaml y por eso están
          // ocultas del enum que ve el modelo (ver buildTools en
          // services/claude.ts) — así que esa tool solo puede mover a etapas
          // manuales, o sea a etapas de conversación EN CURSO. Cuando estaba
          // en esta lista, el bot de Dr. Romero daba por cerrado cada turno en
          // que el modelo movía a "En conversación" (o sea casi todos): 36 de
          // 36 turnos salieron "no programado", cero follow-ups y cero leads
          // movidos a "No contestó" en semanas. El cierre real de un turno
          // anterior ya se verifica abajo contra el estado vivo de GHL.
          let yaCerrado =
            usedTools.has('agendar_cita') ||
            usedTools.has('escalar_a_humano');

          if (!yaCerrado && getConfig().calendars) {
            try {
              const citas = await getContactAppointments(contactId);
              const now = Date.now();
              yaCerrado = citas.some((a) => {
                const t = new Date(a.startTime).getTime();
                const cancelada = (a.appointmentStatus ?? '').toLowerCase().includes('cancel');
                return !isNaN(t) && t > now && !cancelada;
              });
            } catch (e) {
              console.warn(`[follow-up] check citas falló: ${(e as Error).message}`);
            }
          }

          const escalationStageName = getConfig().escalation?.stage;
          if (!yaCerrado && getConfig().pipeline && escalationStageName) {
            const locationId = process.env.GHL_LOCATION_ID;
            if (locationId) {
              try {
                const opps = await findContactOpportunity(contactId, getConfig().pipeline!.id, locationId);
                const escaladaStage = getConfig().pipeline!.stages.find((s) => s.name === escalationStageName);
                yaCerrado = !!escaladaStage && opps.some((o) => o.pipelineStageId === escaladaStage.id);
              } catch (e) {
                console.warn(`[follow-up] check escalacion falló: ${(e as Error).message}`);
              }
            }
          }

          const confirmType = detectAttendanceConfirmation(messageToProcess);
          const suppressFollowUp = yaCerrado || confirmType === 'yes';

          if (suppressFollowUp) {
            console.log(
              `[follow-up] no programado (conversación cerrada) | contact=${contactId} ` +
                `tools=[${[...usedTools].join(',')}] confirm=${confirmType ?? '-'}`
            );
          } else {
            scheduleFollowUps(contactId).catch((e) =>
              console.warn(`[follow-up] schedule failed: ${e.message}`)
            );
          }
        }
      } else {
        console.warn(`[worker] Empty reply | contact=${contactId}`);
      }

      console.log(
        `[worker] Done | contact=${contactId} tools=[${toolCalls.map((t) => t.toolName).join(',')}]`
      );
    }
  );

  console.log(`[worker] Started | concurrency=${concurrency}`);
}
