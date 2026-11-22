/**
 * Environment for authMethods.test.ts. Its own module, imported first, for the
 * reason rateLimitEnv.ts gives: config/env reads process.env at import time.
 */
process.env.RATE_LIMIT_FAIL_MODE = 'local';
// Each test acts as its own client (X-Forwarded-For), so no test spends
// another's sign-in budget.
process.env.TRUST_PROXY_HOPS = '1';
process.env.ADMIN_APP_URL = 'https://admin.glorytecks.test/';
