/**
 * Bootstrap for the opt-in token check. Import AFTER `./dashboardTestEnv`, which
 * sets a shared secret: that path is checked first, so it has to go.
 * (Blank rather than deleted: dotenv only fills keys that are absent.)
 */
process.env.SUPABASE_JWT_SECRET = '';
process.env.SUPABASE_VERIFY_JWT_LOCALLY = 'true';

export {};
