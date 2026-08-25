import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, GhlChannel } from '../types';
import { buildSystemPrompt } from '../prompts/system';
import { getConfig } from '../config';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60000,
});

/**
 * Lista de herramientas que Claude puede usar.
 *
 * Se construye DINÁMICAMENTE desde configuracion/bot.config.yaml:
 * - Si hay bloque `pipeline:` → se registra `mover_a_etapa` con un `enum` de
 *   los nombres de las etapas configuradas (defensa anti-alucinación).
 *   Las etapas cuya regla `when` empieza con "AUTO" NO se le dan al modelo —
 *   esas las mueve el código (ej. al agendar cita), no la conversación.
 * - Si hay bloque `calendars:` → se registran `consultar_disponibilidad`,
 *   `agendar_cita` y `cliente_frecuente`.
 * - Si hay bloque `escalation:` → se registra `escalar_a_humano`.
 * - Si hay bloque `custom_fields:` → se registra `actualizar_campo` con un
 *   `enum` de los nombres de los campos configurados.
 *
 * Para agregar más herramientas en el futuro, agrega su definición acá y su
 * handler en workers/messageWorker.ts.
 */
function buildTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  const cfg = getConfig();

  if (cfg.pipeline) {
    const manualStages = cfg.pipeline.stages.filter(
      (s) => !s.when.trim().toUpperCase().startsWith('AUTO')
    );

    if (manualStages.length > 0) {
      const stageNames = manualStages.map((s) => s.name);
      const stagesDesc = manualStages
        .map((s) => `- "${s.name}": ${s.when}`)
        .join('\n');

      tools.push({
        name: 'mover_a_etapa',
        description:
          `Mueve al contacto a otra etapa del pipeline "${cfg.pipeline.name}" de GoHighLevel. ` +
          `Úsala SOLO cuando la conversación cumple literalmente una de estas reglas:\n${stagesDesc}\n\n` +
          `Llámala UNA sola vez por turno. No menciones la llamada al contacto.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            etapa: {
              type: 'string',
              enum: stageNames,
              description: 'Nombre exacto de la etapa destino (debe estar en el enum).',
            },
          },
          required: ['etapa'],
        },
      });
    }
  }

  if (cfg.calendars) {
    const agendaKeys = Object.keys(cfg.calendars.agendas);
    const agendaEnum = [...agendaKeys, 'any'];
    const agendasDesc = agendaKeys
      .map((k) => `"${k}" = ${cfg.calendars!.agendas[k].name}`)
      .join(', ');

    // Hint de routing por palabras clave del motivo (si el dueño lo configuró).
    const routingEntries = Object.entries(cfg.calendars.routing).filter(
      ([k]) => k !== 'default'
    );
    const routingDesc = routingEntries.length
      ? '\nRouting por motivo: ' +
        routingEntries
          .map(([kw, route]) => `si el motivo contiene "${kw}" → ${JSON.stringify(route)}`)
          .join('; ') +
        '.'
      : '';

    tools.push({
      name: 'consultar_disponibilidad',
      description:
        'Consulta horarios de cita disponibles en GoHighLevel. Úsala cuando el contacto ' +
        'quiera agendar o pregunte por horarios. Devuelve una lista de slots crudos ' +
        'con fecha/hora/agenda — tú decides cómo presentarlos (idealmente 2 opciones ' +
        'con doble alternativa).\n\n' +
        `Agendas configuradas: ${agendasDesc}. Usa "any" cuando no haya preferencia clara.${routingDesc}\n` +
        'Si el contacto rechaza las opciones, vuelve a llamar con desde_fecha más adelante.',
      input_schema: {
        type: 'object' as const,
        properties: {
          motivo: {
            type: 'string',
            description: 'Motivo de la cita tal como lo describió el contacto (ej: "valoración", "asesoría", "demo").',
          },
          agenda: {
            type: 'string',
            enum: agendaEnum,
            description: 'Qué agenda consultar. "any" = cualquiera disponible.',
          },
          desde_fecha: {
            type: 'string',
            description: 'Fecha mínima a partir de la cual buscar, en formato YYYY-MM-DD. Si el contacto dijo un día específico, ponlo acá. Si no, omítelo.',
          },
          horario_preferido: {
            type: 'string',
            enum: ['mañana', 'tarde', 'cualquiera'],
            description: 'Preferencia de horario. "mañana" filtra slots antes de 12pm, "tarde" después de 2pm.',
          },
          cantidad: {
            type: 'number',
            description: 'Cuántos slots devolver. Default 4. Útil pedir más cuando el contacto rechaza varias opciones.',
          },
        },
        required: ['motivo'],
      },
    });

    tools.push({
      name: 'agendar_cita',
      description:
        'Crea la cita en GoHighLevel (se sincroniza con Google Calendar si el calendario está conectado). ' +
        'Úsala SOLO después de que el contacto haya confirmado un slot específico Y te haya dado su nombre completo. ' +
        'El slot_iso debe ser EXACTAMENTE uno de los iso que devolvió consultar_disponibilidad — no inventes horarios.',
      input_schema: {
        type: 'object' as const,
        properties: {
          slot_iso: {
            type: 'string',
            description: 'Fecha y hora ISO de un slot devuelto por consultar_disponibilidad (ej: "2026-05-25T14:00:00-05:00").',
          },
          agenda: {
            type: 'string',
            enum: agendaKeys,
            description: 'Agenda en la que se crea la cita. Debe coincidir con la del slot.',
          },
          nombre_completo: {
            type: 'string',
            description: 'Nombre y apellido del contacto, como lo dictó.',
          },
          motivo: {
            type: 'string',
            description: 'Motivo de la cita (valoración, asesoría, demo, etc.).',
          },
        },
        required: ['slot_iso', 'agenda', 'nombre_completo', 'motivo'],
      },
    });

    tools.push({
      name: 'cliente_frecuente',
      description:
        'Consulta el historial de citas del contacto en GoHighLevel para saber si ya fue cliente antes. ' +
        'Llámala cuando el contacto diga algo tipo "ya soy cliente", "ya fui antes", o cuando ' +
        'tengas duda. Devuelve cuántas citas pasadas tiene y cuándo fue la última.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    });
  }

  if (cfg.escalation) {
    tools.push({
      name: 'escalar_a_humano',
      description:
        'Notifica al equipo humano que el contacto necesita atención de una persona. ' +
        'Úsala cuando: el contacto pide hablar con alguien, está molesto, es una urgencia, ' +
        'o detectes algo fuera de tu alcance. Agrega un tag y una nota en GHL — el equipo lo ve ahí. ' +
        'Después de llamarla, dile al contacto con calidez que ya notificaste al equipo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          motivo_escalacion: {
            type: 'string',
            description: 'Por qué escalas, en 1 frase corta (ej: "pide hablar con persona", "queja fuerte", "caso complejo").',
          },
        },
        required: ['motivo_escalacion'],
      },
    });
  }

  if (cfg.custom_fields) {
    const fieldNames = cfg.custom_fields.fields.map((f) => f.name);
    const fieldsDesc = cfg.custom_fields.fields
      .map((f) => `- "${f.name}": ${f.when}`)
      .join('\n');

    tools.push({
      name: 'actualizar_campo',
      description:
        'Guarda un dato en un campo personalizado del contacto en GoHighLevel. ' +
        `Úsala cuando la conversación cumple literalmente una de estas reglas:\n${fieldsDesc}\n\n` +
        'Guarda el valor tal como lo dijo el contacto (limpio, sin comillas ni comentarios tuyos). ' +
        'Puedes llamarla varias veces en un turno si el contacto dio varios datos. ' +
        'No le menciones al contacto que estás guardando nada — es interno.',
      input_schema: {
        type: 'object' as const,
        properties: {
          campo: {
            type: 'string',
            enum: fieldNames,
            description: 'Nombre exacto del campo a actualizar (debe estar en el enum).',
          },
          valor: {
            type: 'string',
            description: 'El valor a guardar, como string (ej: "500 USD", "Bogotá", "2026-08-15").',
          },
        },
        required: ['campo', 'valor'],
      },
    });
  }

  return tools;
}

export const TOOLS: Anthropic.Tool[] = buildTools();

/**
 * Genera contexto temporal (hoy + día de la semana) en la timezone del negocio.
 * Se mete como bloque system NO cacheado — cambia cada día y rompería el cache.
 * Solo se agrega si hay calendars o follow_ups (que son quienes razonan fechas).
 */
function getDateContext(): string {
  const cfg = getConfig();
  const tz = cfg.calendars?.timezone ?? cfg.follow_ups?.timezone ?? 'America/Bogota';
  const now = new Date();
  const human = new Intl.DateTimeFormat('es', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return `<contexto_temporal>\nHoy es ${human} (${iso}). Timezone del negocio: ${tz}.\nCuando el contacto diga "mañana", "el viernes", "el próximo lunes", etc., calcula la fecha relativa a este día. Si dice un día con número (ej: "viernes 25"), verifica que el día de la semana y el número coincidan antes de confirmar.\n</contexto_temporal>`;
}

/**
 * Mapea el canal técnico (GhlChannel) a una etiqueta que el modelo usa para
 * decidir si pedir o no número de teléfono antes de agendar/cerrar.
 *
 * - whatsapp_known_number → el bot ya tiene el número (WhatsApp/SMS).
 * - no_phone_yet → entró por canal sin teléfono (FB/IG/Live_Chat/GMB/Email).
 *   El bot DEBE pedir un número antes de agendar o pasar a ventas.
 */
function describeChannel(channel: GhlChannel): string {
  switch (channel) {
    case 'WhatsApp':
    case 'SMS':
      return 'whatsapp_known_number';
    default:
      return 'no_phone_yet';
  }
}

export interface ToolCallResult {
  toolName: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ClaudeResponse {
  text: string;
  toolCalls: ToolCallResult[];
  stopReason: string;
}

/**
 * Bloque de archivo (foto/pdf) que llega en el turno actual.
 */
export interface AttachmentBlock {
  kind: 'image' | 'pdf';
  base64: string;
  mimeType: string;
}

/**
 * Llama a Claude con historial y herramientas, manejando el ciclo tool_use completo.
 */
export async function getClaudeResponse(
  history: ChatMessage[],
  newMessage: string,
  toolHandler: (name: string, input: Record<string, unknown>) => Promise<string>,
  channel: GhlChannel,
  attachments?: AttachmentBlock[]
): Promise<ClaudeResponse> {
  const recentHistory = history.slice(-20);

  // Si hay attachments, mandamos un array de bloques (image/document + text).
  // Si no, string simple.
  let currentTurnContent: Anthropic.MessageParam['content'];
  if (attachments && attachments.length > 0) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const att of attachments) {
      if (att.kind === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: att.base64,
          },
        });
      } else if (att.kind === 'pdf') {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: att.base64,
          },
        });
      }
    }
    blocks.push({ type: 'text', text: newMessage });
    currentTurnContent = blocks;
  } else {
    currentTurnContent = newMessage;
  }

  const messages: Anthropic.MessageParam[] = [
    ...recentHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: currentTurnContent },
  ];

  // System prompt en bloques:
  // 1. Cacheable (prompt estático): cache_control ephemeral — Anthropic cachea
  //    el prefix del system + tools y reduce ~85% del costo en cache hits.
  // 2. NO cacheables (cambian por turno/día): canal de entrada y fecha de hoy.
  //    Van después para no romper el prefix cacheado.
  const cfgAll = getConfig();
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildSystemPrompt(),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        `\n\n---\n## CONTEXTO DEL TURNO (volátil — cambia por canal)\n` +
        `- Canal de entrada: ${channel}\n` +
        `- Estado del teléfono del contacto: ${describeChannel(channel)}\n` +
        `Si el estado es "no_phone_yet" y vas a agendar una cita o pasar el contacto ` +
        `a una persona del equipo, pídele primero un número de WhatsApp.`,
    },
  ];
  if (cfgAll.calendars || cfgAll.follow_ups) {
    systemBlocks.push({ type: 'text', text: getDateContext() });
  }

  const toolCalls: ToolCallResult[] = [];
  let finalText = '';
  let lastStopReason = 'unknown';
  let currentMessages = messages;
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[claude] Iteration ${iterations}/${MAX_ITERATIONS} | msgs=${currentMessages.length} | tools=${TOOLS.length}`);

    const cfg = getConfig().behavior;
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.max_response_tokens,
        system: systemBlocks,
        tools: TOOLS,
        messages: currentMessages,
      });
    } catch (err) {
      console.error(`[claude] API error on iteration ${iterations}:`, (err as Error).message);
      // Si aún no generamos NINGÚN texto, propagamos el error para que el
      // worker reintente el job (pg-boss) en vez de perder el mensaje con una
      // respuesta vacía. Si ya hay texto de una iteración previa, devolvemos
      // lo que tengamos (mejor algo que nada).
      if (!finalText) {
        throw err;
      }
      break;
    }

    const u = response.usage;
    const cacheLog = u
      ? ` | in=${u.input_tokens} out=${u.output_tokens} cacheR=${u.cache_read_input_tokens ?? 0} cacheW=${u.cache_creation_input_tokens ?? 0}`
      : '';
    console.log(`[claude] Response | stop=${response.stop_reason} | blocks=${response.content.length}${cacheLog}`);
    lastStopReason = response.stop_reason ?? 'unknown';

    const turnText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    if (turnText) finalText = turnText;

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown>;
        const output = await toolHandler(block.name, input);
        toolCalls.push({ toolName: block.name, input, output });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
      continue;
    }

    break;
  }

  if (iterations >= MAX_ITERATIONS && !finalText) {
    console.warn(`[claude] Hit max iterations (${MAX_ITERATIONS}) without final text`);
  }

  return { text: finalText, toolCalls, stopReason: lastStopReason };
}

/**
 * Genera el texto de un follow-up CONTEXTUAL — en vez de mandar el mensaje
 * predefinido del yaml tal cual, le pasamos a Claude toda la conversación
 * real y le pedimos que retome exactamente lo que quedó pendiente (un dato
 * que faltaba, un horario sin confirmar, una duda sin resolver).
 *
 * Es una llamada de SOLO TEXTO — sin tools — para que nunca intente agendar,
 * mover de etapa, etc. por su cuenta en un mensaje que el contacto no inició.
 *
 * Si esto falla (red, rate limit, etc.), el caller debe usar como respaldo
 * el mensaje predefinido de `follow_ups.messages` — por eso esta función
 * lanza el error en vez de tragárselo.
 */
export async function generateFollowUpMessage(
  history: ChatMessage[],
  attempt: number,
  totalAttempts: number,
  hoursIdle: number
): Promise<string> {
  const recentHistory = history.slice(-20);

  const instruction =
    `[INSTRUCCIÓN INTERNA DE SEGUIMIENTO — esto NO es un mensaje del contacto, no lo trates como tal ni le respondas como si él hubiera escrito esto]\n` +
    `El contacto dejó de responder hace aproximadamente ${Math.round(hoursIdle)} horas. Este es tu mensaje de seguimiento #${attempt} de ${totalAttempts} máximo antes de dejarlo en paz.\n` +
    `Genera SOLO el texto exacto que le vas a mandar por WhatsApp — nada de explicaciones tuyas, nada de herramientas, nada de meta-comentarios.\n` +
    `Basándote en TODA la conversación de arriba, retoma exactamente lo que quedó pendiente: si faltaba un dato para agendar (nombre, horario, motivo), pídelo directo; si estaba viendo información de algo específico y no llegó a cerrar, retómalo conectado a lo que preguntó; si ya tenía horarios ofrecidos sin elegir, recuérdaselos. NO mandes un saludo genérico tipo "¿pudiste ver la información?" a menos que genuinamente eso sea lo único que quedó pendiente — sé específico al contexto real de esta conversación.\n` +
    `Si por el contexto de la conversación es claro que este contacto NO es una paciente real (ej. es un proveedor ofreciendo un servicio, publicidad, spam, un número equivocado, alguien buscando trabajo), no generes ningún mensaje de seguimiento. En ese caso responde ÚNICAMENTE con el texto exacto NO_FOLLOW_UP (sin comillas, sin explicación, sin nada más alrededor) — nunca expliques tu razonamiento como si fuera el mensaje a enviar.`;

  const messages: Anthropic.MessageParam[] = [
    ...recentHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: instruction },
  ];

  const cfgAll = getConfig();
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
  ];
  if (cfgAll.calendars || cfgAll.follow_ups) {
    systemBlocks.push({ type: 'text', text: getDateContext() });
  }

  const cfg = getConfig().behavior;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.max_response_tokens,
    system: systemBlocks,
    messages,
    // Sin tools a propósito: esto es generación de texto puro.
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')
    .trim();
}

/**
 * Divide el texto en hasta 3 partes para WhatsApp. Corta preferentemente en
 * separación de párrafos para no partir listas a la mitad.
 */
export function splitMessage(text: string, maxChars = 800): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];

  const parts: string[] = [];
  let remaining = clean;

  while (remaining.length > 0 && parts.length < 3) {
    if (remaining.length <= maxChars || parts.length === 2) {
      parts.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut > maxChars * 0.3) {
      cut += 2;
    } else {
      cut = remaining.lastIndexOf('\n', maxChars);
      while (cut > 0 && /^\s*[•\-\*]/.test(remaining.slice(cut + 1))) {
        cut = remaining.lastIndexOf('\n', cut - 1);
      }
      if (cut > maxChars * 0.3) cut += 1;
      else {
        cut = remaining.lastIndexOf('. ', maxChars);
        if (cut > maxChars * 0.3) cut += 2;
        else cut = maxChars;
      }
    }

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  return parts.filter(p => p.length > 0);
}
