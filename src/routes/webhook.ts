import { Router, Request, Response, NextFunction } from 'express';
import { enqueueMessage } from '../queue';
import { db } from '../db/client';
import { GHLWebhookPayload, GhlChannel } from '../types';
import { getLatestMessageInfo } from '../services/ghl';

export const webhookRouter = Router();

/**
 * Un webhook INDEPENDIENTE por canal, con el canal hardcodeado en la ruta:
 *
 *   POST /webhook/ghl/whatsapp   → WhatsApp
 *   POST /webhook/ghl/facebook   → FB (Messenger)
 *   POST /webhook/ghl/instagram  → IG (DM)
 *   POST /webhook/ghl            → WhatsApp (compat con bots ya deployados)
 *
 * En GHL se configura un Workflow por canal, cada uno apuntando a SU URL y
 * con el trigger filtrado por ese canal. Detectar el canal dinámicamente
 * desde el payload resulta frágil — hardcodearlo por ruta garantiza que el
 * bot siempre responde por el canal correcto.
 */
function makeGhlWebhookHandler(channel: GhlChannel) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Defensa anti-spoofing: si WEBHOOK_SECRET está seteado, exigir que GHL
    // mande el header `x-webhook-secret` con el mismo valor. Si la env var
    // está vacía/ausente, el handler permite todo (opt-out — solo para compat
    // con instalaciones previas; la skill setea el secret en el deploy).
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (expectedSecret) {
      const providedSecret = req.header('x-webhook-secret');
      if (providedSecret !== expectedSecret) {
        const ua = req.header('user-agent') ?? 'unknown';
        console.warn(`[webhook:${channel}] Unauthorized | ua="${ua}"`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    // Responder 200 inmediatamente — GHL exige respuesta en menos de 5 segundos
    res.status(200).json({ received: true });
    try {
      const payload = req.body as GHLWebhookPayload;

      const contactId = payload.contact_id;
      const messageText = payload.message?.body?.trim() ?? '';
      const phone = payload.phone ?? '';
      const contactName = payload.full_name ?? payload.first_name ?? null;

      if (!contactId) {
        console.log(`[webhook:${channel}] Skipped — sin contactId`);
        return;
      }

      // Si message.body viene vacío es porque llegó media (foto/audio/pdf).
      // GHL no la incluye en el webhook — se pide a la conversations API.
      let attachmentUrl: string | null = null;
      let attachmentKind: string | null = null;
      let textForClaude = messageText;

      if (!messageText) {
        const info = await getLatestMessageInfo(contactId);
        const att = info?.attachment;
        if (!att) {
          console.log(`[webhook:${channel}] Skipped — sin texto ni attachment | contact=${contactId}`);
          return;
        }
        attachmentUrl = att.url;
        attachmentKind = att.kind;
        console.log(`[webhook:${channel}] Media detectada | contact=${contactId} kind=${att.kind} ext=${att.ext}`);

        if (att.kind === 'image') textForClaude = '[el contacto envió una imagen]';
        else if (att.kind === 'pdf') textForClaude = '[el contacto envió un PDF]';
        else if (att.kind === 'audio') textForClaude = '[el contacto envió un audio]';
        else textForClaude = '[el contacto envió un archivo]';
      }

      // Upsert con concatenación del pending_message + append a pending_attachments.
      // Persistimos el canal en metadata.channel para auditoría y para que el
      // worker de follow-ups sepa por dónde responder.
      await db.query(
        `INSERT INTO conversations (contact_id, phone, contact_name, messages, metadata, pending_message, pending_at, pending_attachments)
         VALUES ($1, $2, $3, '[]'::jsonb, jsonb_build_object('channel', $6::text), $4, now(), COALESCE($5::jsonb, '[]'::jsonb))
         ON CONFLICT (contact_id)
         DO UPDATE SET
           pending_message = CASE
             WHEN conversations.pending_message IS NULL OR conversations.pending_message = ''
               THEN $4
             ELSE conversations.pending_message || E'\n' || $4
           END,
           pending_attachments = COALESCE(conversations.pending_attachments, '[]'::jsonb) || COALESCE($5::jsonb, '[]'::jsonb),
           metadata = COALESCE(conversations.metadata, '{}'::jsonb) || jsonb_build_object('channel', $6::text),
           pending_at = now(),
           last_activity = now()`,
        [
          contactId,
          phone,
          contactName,
          textForClaude,
          attachmentUrl ? JSON.stringify([{ url: attachmentUrl, kind: attachmentKind }]) : null,
          channel,
        ]
      );

      await enqueueMessage({ contactId, phone, contactName, message: textForClaude, channel });

      console.log(`[webhook:${channel}] Queued | contact=${contactId} msg="${textForClaude.slice(0, 50)}"${attachmentUrl ? ' (con media)' : ''}`);
    } catch (err) {
      console.error(`[webhook:${channel}] Error processing:`, (err as Error).message);
      next(err);
    }
  };
}

webhookRouter.post('/ghl/whatsapp', makeGhlWebhookHandler('WhatsApp'));
webhookRouter.post('/ghl/facebook', makeGhlWebhookHandler('FB'));
webhookRouter.post('/ghl/instagram', makeGhlWebhookHandler('IG'));
// Compat: la ruta original equivale a WhatsApp (bots deployados antes del multicanal)
webhookRouter.post('/ghl', makeGhlWebhookHandler('WhatsApp'));
