import { getDependencies } from '../container';
import { createOrderSchema, customerPathSchema } from '../domain/order';
import { httpHandler, parseJsonBody, validate } from '../lib/http';

/** POST /customers/{customerId}/orders */
export const handler = httpHandler(async (event) => {
  const { customerId } = validate(customerPathSchema, event.pathParameters);
  const input = validate(createOrderSchema, parseJsonBody(event));

  const order = await getDependencies().orderService.createOrder(customerId, input);

  return {
    statusCode: 201,
    body: order,
    headers: { location: `/customers/${customerId}/orders/${order.orderId}` },
  };
});
