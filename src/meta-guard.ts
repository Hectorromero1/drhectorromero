/**
 * Última barrera antes de mandarle algo a la paciente: detecta cuando el
 * modelo escribió su razonamiento interno en vez del mensaje.
 *
 * Pasó en producción seis veces entre el 13 y el 21 de octubre de 2026, y todas
 * salieron por WhatsApp tal cual. Tres de ellas:
 *   - follow-up: "Para generar el mensaje de seguimiento, necesito evaluar el
 *     contexto: **Análisis de la conversación:** - El contacto llegó desde un
 *     anuncio…" (21-oct)
 *   - follow-up: "No genero mensaje de seguimiento porque la conversación aún
 *     está activa esperando la respuesta del contacto…" (17-oct)
 *   - respuesta normal, después de escalar: "Perfecto. Todos los datos de [nombre]
 *     han sido capturados y la escalación a Karime se completó
 *     exitosamente. La paciente ya está clasificada como 'caliente'…" (14-oct)
 *
 * El prompt ya prohibía todo eso ("nunca muestres tu razonamiento interno") y
 * no bastó: una regla en el prompt es una sugerencia, esto es código.
 *
 * Los patrones son frases que el bot NUNCA le diría a una paciente (le habla
 * de "usted", nunca de "la paciente" o "el contacto" en tercera persona, ni
 * nombra sus herramientas). Si alguno da un falso positivo, el costo es un
 * mensaje que no sale y una línea `[meta-guard]` en logs; el costo contrario
 * es lo de arriba.
 */

const PATRONES: Array<[string, RegExp]> = [
  ['centinela', /\bNO_(FOLLOW_UP|INSISTIR)\b/],
  ['instrucción interna', /\[INSTRUCCI[OÓ]N/i],
  ['nombre de herramienta', /\b(mover_a_etapa|consultar_disponibilidad|agendar_cita|cliente_frecuente|escalar_a_humano|actualizar_campo)\b/],
  ['encabezado de análisis', /an[aá]lisis de la conversaci[oó]n|^\W*evaluaci[oó]n\W*$|^\W*evaluaci[oó]n\s*:/im],
  ['habla del seguimiento', /mensaje de seguimiento|necesito evaluar|no genero (el |ning[uú]n )?mensaje/i],
  ['tercera persona', /\b(el|la) (contacto|paciente|prospecto) (ya |no |lleg[oó]|dijo|pregunt[oó]|dej[oó]|lleva|mostr[oó]|hizo|est[aá]|fue|ser[aá]|tiene|quer[ií]a)/i],
  ['habla de la escalación', /\bescalaci[oó]n\b|\bescalad[oa]\b|datos obligatorios|clasificad[oa] como|se complet[oó] exitosamente|han sido capturados/i],
];

/** Devuelve el motivo si el texto parece razonamiento interno, o null si se puede mandar. */
export function motivoMetaComentario(text: string): string | null {
  for (const [motivo, re] of PATRONES) {
    if (re.test(text)) return motivo;
  }
  return null;
}
