// Prompt bills sent by RxBridge: the bill as a PDF (to print), and sending it to the customer
// on WhatsApp.
import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { billPdfForUser, sendBillNow } from '../services/billSender.js';

const billIdParams = z.object({ id: z.string().regex(/^\d+$/, 'Invalid bill id.') });

export const billRoutes = Router();

billRoutes.use(authenticate);

// The bill PDF, shown inline so the browser can print it. Bills are seen from the Customers page.
billRoutes.get(
  '/:id/pdf',
  requirePermission(PERMISSIONS.CUSTOMERS_READ),
  validate({ params: billIdParams }),
  async (req, res) => {
    const { pdf, filename } = await billPdfForUser(req.auth, req.params.id);
    res
      .set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' })
      .send(pdf);
  },
);

// Messaging a customer on WhatsApp: the same permission as replying in the inbox.
billRoutes.post(
  '/:id/whatsapp',
  requirePermission(PERMISSIONS.WHATSAPP_INBOX_REPLY),
  validate({ params: billIdParams }),
  async (req, res) => {
    res.json(await sendBillNow(req.auth, req.params.id));
  },
);
