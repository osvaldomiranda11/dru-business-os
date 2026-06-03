import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'af-south-1',
});

export const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

export const Tables = {
  empresas: process.env.EMPRESAS_TABLE!,
  utilizadores: process.env.UTILIZADORES_TABLE!,
  financeiro: process.env.FINANCEIRO_TABLE!,
  faturacao: process.env.FATURACAO_TABLE!,
  stock: process.env.STOCK_TABLE!,
  auditoria: process.env.AUDITORIA_TABLE!,
} as const;
