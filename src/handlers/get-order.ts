import { getDependencies } from '../container';
import { orderPathSchema } from '../domain/order';
import { httpHandler, validate } from '../lib/http';

/** GET /customers/{customerId}/orders/{orderId} — served with the cache-aside pattern. */
export const handler = httpHandler(async (event) => {
  const { customerId, orderId } = validate(orderPathSchema, event.pathParameters);

  const order = await getDependencies().orderService.getOrder(customerId, orderId);

  return { statusCode: 200, body: order };
});
