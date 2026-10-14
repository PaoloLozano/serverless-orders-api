import type { Order, OrderStatus } from '../domain/order';

export interface ListOrdersOptions {
  limit: number;
  from?: Date;
  to?: Date;
  nextToken?: string;
}

export interface OrderPage {
  orders: Order[];
  nextToken?: string;
}

export interface UpdateStatusParams {
  customerId: string;
  orderId: string;
  status: OrderStatus;
  /** The update only succeeds if the current status is one of these. */
  allowedFrom: readonly OrderStatus[];
  updatedAt: string;
}

/**
 * Persistence port. The service depends on this interface, not on DynamoDB, which keeps
 * business logic testable with a fake and isolates every DynamoDB detail in one class.
 */
export interface OrderRepository {
  create(order: Order): Promise<void>;
  get(
    customerId: string,
    orderId: string,
    options?: { consistentRead?: boolean },
  ): Promise<Order | undefined>;
  listByCustomer(customerId: string, options: ListOrdersOptions): Promise<OrderPage>;
  /** Throws NotFoundError if the order does not exist, ConflictError if the transition is invalid. */
  updateStatus(params: UpdateStatusParams): Promise<Order>;
}
