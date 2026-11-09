const REQUIRED = ["DATABASE_URL", "REDIS_URL"];

export function config(env = process.env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`${missing.join(" and ")} not set: copy .env.example to .env`);
  }
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    sessionTtl: Number(env.SESSION_TTL_SECONDS ?? 3600),
  };
}
