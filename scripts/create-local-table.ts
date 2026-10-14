/**
 * Creates the Orders table in DynamoDB Local (started with `npm run local:up`).
 * Usage: npm run local:table
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb';
import { ordersTableDefinition } from './table-definition';

const tableName = process.env.TABLE_NAME ?? 'orders-local';
const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8100';

const client = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function main() {
  try {
    await client.send(new CreateTableCommand(ordersTableDefinition(tableName)));
    console.log(`Created table "${tableName}" at ${endpoint}`);
  } catch (error) {
    if (error instanceof ResourceInUseException) {
      console.log(`Table "${tableName}" already exists at ${endpoint}`);
    } else {
      throw error;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
