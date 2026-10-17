import { z } from 'zod';
import { REMINDER_VIEWS } from '../repositories/reminderRepository.js';
import { MAX_INTERVAL_DAYS } from '../services/reminderRules.js';
import { isoDateField, medicineNameField } from './customerValidators.js';

const customerId = z.string().regex(/^\d+$/, 'Invalid customer id.');

export const scheduleOptionsQuerySchema = z.object({ customerId });

export const scheduleRemindersSchema = z.object({
  customerId,
  items: z
    .array(
      z.object({
        branchId: z.number().int().positive(),
        medicine: medicineNameField,
        intervalDays: z
          .number({ error: 'Enter the number of days.' })
          .int('Use whole days.')
          .min(1, 'At least 1 day.')
          .max(MAX_INTERVAL_DAYS, `At most ${MAX_INTERVAL_DAYS} days.`),
        // Only used when the medicine has no stored last bill date.
        startDate: isoDateField.optional(),
      }),
    )
    .min(1, 'Choose at least one medicine.')
    .max(50)
    .refine((items) => new Set(items.map((i) => `${i.branchId}|${i.medicine}`)).size === items.length, {
      message: 'Each medicine can only be listed once.',
    }),
});

export const listRemindersQuerySchema = z.object({
  view: z.enum(REMINDER_VIEWS).default('active'),
  search: z.string().trim().max(100).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const cycleIdParamsSchema = z.object({ id: z.string().regex(/^\d+$/, 'Invalid reminder id.') });

export const cancelReminderSchema = z.object({
  reason: z.string().trim().max(255).optional().transform((v) => v || undefined),
});

const deliveryDetailsSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('delivery'),
    address: z.string({ error: 'Enter the delivery address.' }).trim().min(1, 'Enter the delivery address.').max(500),
    // Also store this address on the customer.
    saveAddress: z.boolean().default(false),
  }),
  z.object({ method: z.literal('pickup') }),
]);

export const recordOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ordered'), delivery: deliveryDetailsSchema }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.string({ error: 'Enter the reason.' }).trim().min(1, 'Enter the reason.').max(500, 'Must be at most 500 characters.'),
  }),
]);
