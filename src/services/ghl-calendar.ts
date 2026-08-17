/**
 * Cliente para GHL Calendars API — free-slots y creación de citas.
 *
 * La capacidad por hora, el horario de atención y los bloqueos los maneja
 * GHL en la configuración de cada calendario, no este código. El bot solo
 * consulta disponibilidad y agenda.
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

function getApiKey(): string {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error('GHL_API_KEY is required');
  return key;
}

async function ghlFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GHL_API_BASE}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

export interface FreeSlot {
  iso: string;
  calendarId: string;
}

/**
 * Consulta slots libres en un calendario entre dos fechas (timestamps en ms).
 * GHL devuelve un objeto agrupado por día con la lista de slots ISO.
 *
 * Si el calendario está mal configurado o el rango no tiene slots, devuelve [].
 */
export async function getFreeSlots(
  calendarId: string,
  startDateMs: number,
  endDateMs: number,
  timezone = 'America/Bogota'
): Promise<FreeSlot[]> {
  const path =
    `/calendars/${encodeURIComponent(calendarId)}/free-slots` +
    `?startDate=${startDateMs}&endDate=${endDateMs}&timezone=${encodeURIComponent(timezone)}`;

  const data = (await ghlFetch(path)) as Record<string, { slots?: string[] } | undefined> & {
    traceId?: string;
  };

  const slots: FreeSlot[] = [];
  for (const key of Object.keys(data)) {
    if (key === 'traceId') continue;
    const day = data[key];
    if (day && Array.isArray(day.slots)) {
      for (const iso of day.slots) {
        slots.push({ iso, calendarId });
      }
    }
  }
  // GHL ya los devuelve en orden cronológico, pero por si acaso lo aseguramos.
  slots.sort((a, b) => a.iso.localeCompare(b.iso));
  return slots;
}

export interface CreateAppointmentParams {
  calendarId: string;
  locationId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title: string;
  appointmentStatus?: 'new' | 'confirmed' | 'showed' | 'cancelled';
}

export interface CreatedAppointment {
  id: string;
  startTime: string;
  endTime: string;
  calendarId: string;
}

/**
 * Crea una appointment en el calendario indicado. GHL la sincroniza
 * automáticamente con Google Calendar si el calendario está conectado.
 */
export async function createAppointment(
  params: CreateAppointmentParams
): Promise<CreatedAppointment> {
  const body = {
    calendarId: params.calendarId,
    locationId: params.locationId,
    contactId: params.contactId,
    startTime: params.startTime,
    endTime: params.endTime,
    title: params.title,
    appointmentStatus: params.appointmentStatus ?? 'confirmed',
  };

  const data = (await ghlFetch('/calendars/events/appointments', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { id: string; startTime: string; endTime: string; calendarId: string };

  return {
    id: data.id,
    startTime: data.startTime,
    endTime: data.endTime,
    calendarId: data.calendarId,
  };
}

export interface ContactAppointment {
  id: string;
  title?: string;
  startTime: string;
  endTime: string;
  appointmentStatus: string;
  calendarId: string;
}

/**
 * Lista las citas de un contacto. Útil para detectar si es cliente recurrente.
 * Si GHL devuelve error, retorna [] (no lanza — el caller decide).
 */
export async function getContactAppointments(
  contactId: string
): Promise<ContactAppointment[]> {
  try {
    const data = (await ghlFetch(
      `/contacts/${encodeURIComponent(contactId)}/appointments`
    )) as { events?: ContactAppointment[] };
    return data.events ?? [];
  } catch (err) {
    console.warn(`[GHL] getContactAppointments failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Agrega tags al contacto. Útil para escalación a humano y para que el equipo
 * tenga workflows GHL que detecten esos tags.
 */
export async function addTagsToContact(
  contactId: string,
  tags: string[]
): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags }),
  });
}
