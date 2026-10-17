// Allowed delivery status changes. Home delivery: pending → out_for_delivery → delivered.
// Store pickup: pending → delivered (picked up). Either can fail with a reason, and a
// failed delivery can be tried again (back to pending).

const TRANSITIONS = {
  delivery: {
    pending: ['out_for_delivery', 'failed'],
    out_for_delivery: ['delivered', 'failed'],
    failed: ['pending'],
  },
  pickup: {
    pending: ['delivered', 'failed'],
    failed: ['pending'],
  },
};

export const DELIVERY_STATUSES = ['pending', 'out_for_delivery', 'delivered', 'failed', 'cancelled'];

export function canTransition(method, from, to) {
  return TRANSITIONS[method]?.[from]?.includes(to) ?? false;
}

/** Statuses from which the order may still be undone (the delivery is then cancelled). */
export const CANCELLABLE_STATUSES = ['pending', 'failed'];
