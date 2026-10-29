/**
 * El costo de la consulta solo se dice cuando la paciente pregunta por la
 * consulta (instrucción del consultorio, 22-oct-2026). A quien pregunta el
 * precio de un procedimiento se le dice que depende de su caso y que primero
 * hay valoración, sin número.
 *
 * El prompt ya lo dice y no bastó: cuando la paciente insiste con "un
 * aproximado", el modelo suelta "Lo que sí le puedo adelantar es que la
 * consulta cuesta $1,200" como consuelo (4 de 8 en la prueba del 29-oct, y
 * le pasó a una paciente real ese mismo día). Aquí se quita la frase con el
 * precio antes de mandar, si el mensaje de la paciente no habla de la consulta.
 */

import { getConfig } from './config';

/** La paciente está preguntando por la consulta misma, no por un procedimiento. */
const PREGUNTA_POR_CONSULTA = /consulta|valoraci[oó]n|cita|virtual|presencial/i;

function precioRegex(): RegExp | null {
  const digitos = (getConfig().offer?.price_consulta ?? '').replace(/\D/g, '');
  if (!digitos) return null;
  // "$1,200", "1200", "1.200", "1 200"
  const cuerpo = digitos.split('').join('[,.\\s]?');
  return new RegExp(`(?<!\\d)${cuerpo}(?!\\d)`);
}

/**
 * Devuelve el texto sin las oraciones que mencionan el costo de la consulta,
 * salvo que `entrante` (lo que escribió la paciente) pregunte por la consulta.
 * Para un follow-up se pasa `entrante` vacío: ahí nunca se da el precio.
 */
export function quitarPrecioNoPedido(texto: string, entrante: string): { texto: string; quitado: boolean } {
  const re = precioRegex();
  if (!re || !re.test(texto) || PREGUNTA_POR_CONSULTA.test(entrante)) {
    return { texto, quitado: false };
  }
  // Sin el precio, una oración suelta con la duración ("Dura aproximadamente
  // 40 minutos.") queda colgando, así que se va con él.
  const minutos = (getConfig().offer?.duracion_consulta ?? '').match(/\d+/)?.[0];
  const sobra = (oracion: string) =>
    re.test(oracion) || (!!minutos && new RegExp(`(?<!\\d)${minutos}\\s*min`, 'i').test(oracion));
  const parrafos = texto
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split(/(?<=[.!?])\s+/)
        .filter((oracion) => !sobra(oracion))
        .join(' ')
        .trim()
    )
    .filter(Boolean);
  return { texto: parrafos.join('\n\n'), quitado: true };
}
