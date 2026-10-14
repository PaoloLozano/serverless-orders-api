import { getDependencies } from '../container';
import { orderPathSchema, updateOrderStatusSchema } from '../domain/order';
import { httpHandler, parseJsonBody, validate } from '../lib/http';

/** PATCH /customers/{customerId}/orders/{orderId} — body: { "status": "PAID" } */
export const handler = httpHandler(async (event) => {
  const { customerId, orderId } = validate(orderPathSchema, event.pathParameters);
  const { status } = validate(updateOrderStatusSchema, parseJsonBody(event));

  const order = await getDependencies().orderService.updateOrderStatus(customerId, orderId, status);

  return { statusCode: 200, body: order };
});
