import { z } from 'zod';
import { normalizeIndianMobile } from '../utils/phone.js';

/** Trimmed optional text: empty string or null clears it (null); omitted stays undefined. */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters.`)
    .nullish()
    .transform((value) => (value === undefined ? undefined : value || null));

const customerFields = {
  fullName: z.string().trim().min(1, 'Patient name is required.').max(150, 'Must be at most 150 characters.'),
  mobile: z.union([z.string(), z.number()]).transform((value, ctx) => {
    const result = normalizeIndianMobile(value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error });
      return z.NEVER;
    }
    return result.value;
  }),
  address: optionalText(500),
  usualDoctor: optionalText(150),
  notes: optionalText(2000),
};

const branchIdsArray = z
  .array(z.number().int().positive())
  .max(50)
  .transform((ids) => [...new Set(ids)]);
const branchIdsField = branchIdsArray.refine((ids) => ids.length > 0, 'Select at least one branch.');

export const customerIdParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid customer id.'),
});

export const listCustomersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  medicine: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const createCustomerSchema = z.object({
  ...customerFields,
  branchIds: branchIdsField,
});

export const updateCustomerSchema = z
  .object({
    fullName: customerFields.fullName.optional(),
    mobile: customerFields.mobile.optional(),
    address: customerFields.address,
    usualDoctor: customerFields.usualDoctor,
    notes: customerFields.notes,
    // The caller's own branches only; may be empty if the customer keeps another branch.
    branchIds: branchIdsArray.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'No changes supplied.' });

export const medicineNameField = z.string().trim().min(1, 'Medicine name is required.').max(100);

export const isoDateField = z.iso.date('Use the YYYY-MM-DD format.');

export const addFromProntozSchema = z.object({
  branchId: z.number().int().positive(),
  // Date of the ProntoZ bill the medicines come from; reminders count from it.
  lastBillDate: isoDateField,
  fullName: customerFields.fullName,
  mobile: customerFields.mobile,
  address: customerFields.address,
  usualDoctor: customerFields.usualDoctor,
  medicines: z
    .array(medicineNameField)
    .max(50)
    .transform((names) => [...new Set(names)]),
});
