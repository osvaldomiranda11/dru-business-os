const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const servicesRoot = path.join(root, 'services');
const failures = [];
const publicRoutes = new Set([
  'auth.register:POST /auth/register',
  'auth.login:POST /auth/login',
  'auth.refresh:POST /auth/refresh',
  'documentos.acederPartilhaPublica:GET /partilha/{token}',
  'faturacao.webhookMulticaixa:POST /pagamentos/multicaixa/webhook',
  'subscriptions.listarPlanos:GET /planos',
]);

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function hasCognitoAuthorizer(httpEvent) {
  const authorizer = httpEvent?.authorizer;
  return authorizer?.type === 'COGNITO_USER_POOLS'
    && typeof authorizer.arn === 'string'
    && authorizer.arn.includes('CognitoUserPoolArn');
}

for (const serviceName of fs.readdirSync(servicesRoot)) {
  const servicePath = path.join(servicesRoot, serviceName);
  const configPath = path.join(servicePath, 'serverless.yml');
  if (!fs.existsSync(configPath)) continue;

  let config;
  try {
    config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    failures.push(`${serviceName}: cannot parse serverless.yml (${error.message})`);
    continue;
  }

  const usesJwtVerification = sourceFiles(path.join(servicePath, 'src'))
    .some((sourcePath) => fs.readFileSync(sourcePath, 'utf8').includes('verifyToken('));

  if (usesJwtVerification) {
    const environment = config.provider?.environment ?? {};
    const expectedEnvironment = {
      COGNITO_USER_POOL_ID: 'CognitoUserPoolId',
      COGNITO_CLIENT_ID: 'CognitoUserPoolClientId',
    };
    for (const [key, outputName] of Object.entries(expectedEnvironment)) {
      const value = environment[key];
      if (typeof value !== 'string' || !value.includes(`dru-bos-infra-${'${sls:stage}'}.${outputName}`)) {
        failures.push(`${serviceName}: provider.environment.${key} must reference the current stage's ${outputName} output`);
      }
    }
  }

  for (const [functionName, definition] of Object.entries(config.functions ?? {})) {
    const events = Array.isArray(definition.events) ? definition.events : [];
    const httpEvents = events.map((event) => event.http).filter(Boolean);
    for (const httpEvent of httpEvents) {
      const route = `${serviceName}.${functionName}:${String(httpEvent.method).toUpperCase()} ${httpEvent.path}`;
      if (!httpEvent.authorizer && publicRoutes.has(route)) continue;
      if (!hasCognitoAuthorizer(httpEvent)) {
        failures.push(`${route}: HTTP route must use the stage Cognito User Pool authorizer or be explicitly listed as public`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Cognito configuration check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Cognito configuration check passed: JWT environment and HTTP authorizers are aligned.');
