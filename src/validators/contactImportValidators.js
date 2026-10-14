import { z } from 'zod';

const ROW_STATUSES = ['new', 'update', 'unchanged', 'invalid', 'duplicate'];

export const importIdParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid import id.'),
});

export const uploadImportBodySchema = z.object({
  branchId: z.coerce.number().int().positive({ error: 'Select a branch.' }),
});

export const listImportsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const listImportRowsQuerySchema = z.object({
  // Comma-separated, e.g. ?status=invalid,duplicate
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((s) => s.trim()) : []))
    .pipe(z.array(z.enum(ROW_STATUSES))),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
