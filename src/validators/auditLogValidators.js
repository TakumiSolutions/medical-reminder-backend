import { z } from 'zod';

const isoDate = z.iso.date('Use the YYYY-MM-DD format.');

export const listAuditLogsQuerySchema = z
  .object({
    action: z.string().trim().max(100).optional(),
    entityType: z.string().trim().max(50).optional(),
    entityId: z.string().trim().max(64).optional(),
    actorUserId: z.string().regex(/^\d+$/).optional(),
    // Inclusive calendar dates, interpreted in UTC.
    from: isoDate.optional(),
    to: isoDate.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '"from" must not be after "to".', path: ['from'] });
