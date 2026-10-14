import { z } from 'zod';

export const ORDER_STATUSES = ['PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Order lifecycle as a state machine. Each status lists the statuses it can move to.
 *
 *   PENDING ──► PAID ──► SHIPPED ──► DELIVERED
 *      │          │
 *      └──────────┴──► CANCELLED
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Inverse lookup: which statuses may move to `target`. The repository turns this list
 * into a DynamoDB ConditionExpression, so the transition is validated atomically in
 * the database instead of with a read-then-write (which would race).
 */
export function allowedPreviousStatuses(target: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => canTransition(from, target));
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  /** Price per unit in the smallest currency unit (cents). Never floats for money. */
  unitPrice: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  currency: string;
  /** Sum of quantity * unitPrice, in cents. */
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
}

export function calculateTotal(items: readonly OrderItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

// ---------------------------------------------------------------------------
// Input validation (API boundary)
// ---------------------------------------------------------------------------

/**
 * IDs become part of DynamoDB keys (`CUSTOMER#<id>`), so they must never contain the
 * `#` delimiter. A strict allow-list prevents "key injection".
 */
export const customerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'customerId must be 1-64 characters: letters, digits, _ or -');

/** Order IDs are ULIDs in canonical (upper-case) Crockford base32. */
export const orderIdSchema = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'orderId must be a valid ULID');

export const customerPathSchema = z.object({ customerId: customerIdSchema });
export const orderPathSchema = z.object({ customerId: customerIdSchema, orderId: orderIdSchema });

const orderItemSchema = z.strictObject({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().positive().max(1_000),
  unitPrice: z.number().int().nonnegative().max(100_000_000),
});

export const createOrderSchema = z.strictObject({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code such as USD')
    .default('USD'),
  items: z.array(orderItemSchema).min(1).max(50),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const updateOrderStatusSchema = z.strictObject({
  status: z.enum(ORDER_STATUSES),
});
export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;

export const listOrdersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    nextToken: z.string().max(2048).optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: '`from` must be before or equal to `to`',
    path: ['from'],
  });
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
