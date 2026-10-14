import { getDependencies } from '../container';
import { customerPathSchema, listOrdersQuerySchema } from '../domain/order';
import { httpHandler, validate } from '../lib/http';

/** GET /customers/{customerId}/orders?limit=&from=&to=&nextToken= */
export const handler = httpHandler(async (event) => {
  const { customerId } = validate(customerPathSchema, event.pathParameters);
  const query = validate(listOrdersQuerySchema, event.queryStringParameters ?? {});

  const page = await getDependencies().orderService.listOrders(customerId, query);

  return { statusCode: 200, body: { items: page.orders, nextToken: page.nextToken ?? null } };
});
