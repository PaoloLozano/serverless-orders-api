import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';

/**
 * Same key schema as `OrdersTable` in template.yaml. Used to create the table in
 * DynamoDB Local (local development and integration tests).
 */
export function ordersTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
  };
}
