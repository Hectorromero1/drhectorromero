/**
 * Cargador de configuración del bot.
 *
 * Lee `configuracion/bot.config.yaml` (estructurado) y `configuracion/prompt.md`
 * (texto), valida la estructura con zod y expone helpers para el resto del código.
 *
 * Si el yaml está mal formado o le falta un campo requerido, el bot falla al
 * arrancar con un error claro que indica qué línea/campo arreglar — esto es
 * intencional, mejor fallar rápido y obvio que con un comportamiento raro.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { z } from 'zod';

const CONFIG_DIR = path.resolve(process.cwd(), 'configuracion');
const CONFIG_PATH = path.join(CONFIG_DIR, 'bot.config.yaml');
const PROMPT_PATH = path.join(CONFIG_DIR, 'prompt.md');

const PipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  when: z.string().min(1, 'when: describe la regla literal de cuándo mover'),
});

const PipelineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    stages: z
      .array(PipelineStageSchema)
      .min(1, 'pipeline debe tener al menos 1 etapa configurada')
      .refine(
        (stages) => new Set(stages.map((s) => s.id)).size === stages.length,
        { message: 'Los stage.id deben ser únicos' }
      )
      .refine(
        (stages) => new Set(stages.map((s) => s.name)).size === stages.length,
        { message: 'Los stage.name deben ser únicos (el modelo distingue por nombre)' }
      ),
  })
  .strict();

const AgendaSchema = z.object({
  name: z.string().min(1),
  calendar_id: z.string().min(1),
});

const CalendarsSchema = z
  .object({
    timezone: z.string().default('America/Bogota'),
    duration_minutes: z.number().int().positive().default(30),
    // Etapa del pipeline a la que se mueve la opportunity al agendar una
    // cita (opcional — debe existir en pipeline.stages).
    booked_stage: z.string().optional(),
    agendas: z.record(z.string(), AgendaSchema),
    // Routing por palabras clave del motivo. Cada key (en minúsculas) apunta
    // a una agenda, una lista de agendas, o "any" (todas). "default" define
    // qué hacer cuando ninguna palabra clave matchea.
    routing: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .default({ default: 'any' }),
    // Opcional: máximo de citas ACTIVAS (futuras, no canceladas) por
    // contacto. Si se omite, no hay límite. La 2da+ cita debe ir a nombre
    // de una persona distinta a la anterior (asume familiares agendando
    // desde el mismo número).
    max_active_appointments: z.number().int().positive().optional(),
    // Opcional: tag que se agrega al contacto al agendar (para que un
    // Workflow de GHL notifique al equipo — ej. WhatsApp/push al dueño).
    notify_tag: z.string().optional(),
    // Opcional: ID de un custom field de GHL donde el bot escribe el
    // detalle de la cita en texto plano (contacto, motivo, fecha, hora) —
    // útil como merge field en el mensaje de notificación del Workflow.
    detail_field_id: z.string().optional(),
  })
  .refine(
    (c) => Object.keys(c.agendas).length > 0,
    'calendars.agendas debe tener al menos una agenda configurada'
  );

const FollowUpsSchema = z
  .object({
    timezone: z.string().default('America/Bogota'),
    // Horario permitido de envío (hora local, 0-23). Fuera de esta ventana
    // los follow-ups se posponen al próximo inicio de ventana (default 8am).
    window_start_hour: z.number().int().min(0).max(23).default(8),
    window_end_hour: z.number().int().min(1).max(24).default(22),
    // Horas después del último mensaje del bot en que se envía cada intento.
    // DEBEN ser < 24: WhatsApp solo permite texto libre dentro de las 24h
    // siguientes al último mensaje del cliente.
    cadence_hours: z.array(z.number().positive().max(23)).min(1).max(3).default([3, 9]),
    // Textos predefinidos de cada follow-up — uno por intento de la cadencia.
    // Soportan {nombre} (primer nombre del contacto, si se conoce).
    messages: z.array(z.string().min(1)).min(1).max(3),
    // Opcional: marcar el lead como perdido moviéndolo a esta etapa del
    // pipeline N horas después (requiere bloque pipeline:). También < 24.
    lost_after_hours: z.number().positive().max(23).optional(),
    lost_stage: z.string().optional(),
    // Opcional: solo hacer follow-up mientras la opportunity siga en esta
    // etapa (la de entrada). Si avanzó (agendó, escaló), se suprime.
    entry_stage: z.string().optional(),
  })
  .refine((f) => f.window_start_hour < f.window_end_hour, {
    message: 'follow_ups: window_start_hour debe ser menor que window_end_hour',
  })
  .refine((f) => f.messages.length === f.cadence_hours.length, {
    message:
      'follow_ups: messages debe tener la misma cantidad de textos que cadence_hours (un mensaje por intento)',
  });

const CustomFieldSchema = z.object({
  // ID interno del campo en GHL (lo pone Andrés durante el setup).
  id: z.string().min(1),
  // Nombre legible — es como el modelo se refiere al campo en la tool.
  name: z.string().min(1),
  // Regla literal de cuándo/qué guardar, en lenguaje natural.
  when: z.string().min(1, 'when: describe cuándo y qué guardar en el campo'),
});

const CustomFieldsSchema = z
  .object({
    fields: z
      .array(CustomFieldSchema)
      .min(1, 'custom_fields debe tener al menos 1 campo configurado')
      .refine(
        (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
        { message: 'Los field.name deben ser únicos (el modelo distingue por nombre)' }
      ),
  })
  .strict();

const EscalationSchema = z.object({
  // Tag que se agrega al contacto en GHL al escalar (para workflows del equipo).
  tag: z.string().min(1).default('requiere_humano'),
  // Opcional: etapa del pipeline a la que se mueve la opportunity al escalar.
  stage: z.string().optional(),
});

const ConfigSchema = z.object({
  bot: z.object({
    name: z.string().min(1),
    welcome_message: z.string().min(1),
  }),
  business: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
  }),
  persona: z.object({
    tone: z.string().min(1),
    language: z.string().min(1),
    audio_language: z.string().min(2).default('es'),
  }),
  rules: z
    .object({
      do_not: z.array(z.string()).default([]),
    })
    .default({ do_not: [] }),
  behavior: z
    .object({
      message_debounce_seconds: z.number().int().positive().default(30),
      worker_concurrency: z.number().int().positive().default(5),
      model: z.string().default('claude-sonnet-4-6'),
      max_response_tokens: z.number().int().positive().default(1024),
    })
    .default({
      message_debounce_seconds: 30,
      worker_concurrency: 5,
      model: 'claude-sonnet-4-6',
      max_response_tokens: 1024,
    }),
  pipeline: PipelineSchema.optional(),
  calendars: CalendarsSchema.optional(),
  follow_ups: FollowUpsSchema.optional(),
  escalation: EscalationSchema.optional(),
  custom_fields: CustomFieldsSchema.optional(),
});

export type BotConfig = z.infer<typeof ConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineSchema>;
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type CalendarsConfig = z.infer<typeof CalendarsSchema>;
export type FollowUpsConfig = z.infer<typeof FollowUpsSchema>;
export type EscalationConfig = z.infer<typeof EscalationSchema>;
export type CustomFieldsConfig = z.infer<typeof CustomFieldsSchema>;

let cachedConfig: BotConfig | null = null;
let cachedPrompt: string | null = null;

export function getConfig(): BotConfig {
  if (cachedConfig) return cachedConfig;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Falta archivo de configuración: ${CONFIG_PATH}\n` +
        `Asegúrate de que la carpeta configuracion/ esté en la raíz del proyecto.`
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `configuracion/bot.config.yaml tiene un error de sintaxis:\n${(err as Error).message}\n` +
        `Revisa la indentación y los dos puntos. Si te trabas, en el classroom hay un video.`
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `configuracion/bot.config.yaml es inválido. Revisa estos campos:\n${issues}`
    );
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}

function getPromptTemplate(): string {
  if (cachedPrompt !== null) return cachedPrompt;

  if (!fs.existsSync(PROMPT_PATH)) {
    throw new Error(
      `Falta archivo de prompt: ${PROMPT_PATH}\n` +
        `Asegúrate de que la carpeta configuracion/ esté en la raíz del proyecto.`
    );
  }

  cachedPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
  return cachedPrompt;
}

function lookup(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Sustituye placeholders en el prompt con valores del config.
 *
 * Soporta:
 *   {{path.to.value}}                          → valor literal
 *   {{#if path}}...{{else}}...{{/if}}          → renderiza una rama u otra según truthy
 *   {{#each list}}...{{this}}...{{/each}}      → repite el bloque por cada item
 *   {{#each list}}...{{this.key}}...{{/each}}  → acceso a propiedades del item
 *
 * El orden de procesamiento (if → each → simples) es importante para que el
 * nesting funcione: un {{#each}} adentro de un {{#if}} solo se renderiza si
 * el #if es truthy.
 */
export function renderPrompt(): string {
  const config = getConfig();
  let prompt = getPromptTemplate();

  // 1. Bloques #if con #else opcional (antes que #each por el nesting).
  // El [\s\S]*? es non-greedy; soporta multi-línea pero no anida #if dentro de #if.
  prompt = prompt.replace(
    /\{\{#if ([\w.]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_match, condPath, thenBlock, elseBlock = '') => {
      const value = lookup(config, condPath);
      const truthy =
        value !== undefined &&
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0);
      return truthy ? thenBlock : elseBlock;
    }
  );

  // 2. Bloques #each. Soporta {{this}} (item completo) y {{this.key}} (propiedad).
  prompt = prompt.replace(/\{\{#each ([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_match, listPath, template) => {
    const list = lookup(config, listPath);
    if (!Array.isArray(list)) {
      console.warn(`[config] {{#each ${listPath}}}: no es un array`);
      return '';
    }
    return list
      .map((item) => {
        let out: string = template;
        out = out.replace(/\{\{this\.(\w+)\}\}/g, (_m: string, key: string) =>
          item !== null && typeof item === 'object'
            ? String((item as Record<string, unknown>)[key] ?? '')
            : ''
        );
        out = out.replace(/\{\{this\}\}/g, String(item));
        return out;
      })
      .join('')
      .replace(/\n+$/, '\n');
  });

  // 3. Placeholders simples {{path.to.value}}
  prompt = prompt.replace(/\{\{([\w.]+)\}\}/g, (match, dottedPath) => {
    const value = lookup(config, dottedPath);
    if (value === undefined) {
      console.warn(`[config] Placeholder no encontrado en bot.config.yaml: ${match}`);
      return match;
    }
    return String(value);
  });

  return prompt.trim();
}
