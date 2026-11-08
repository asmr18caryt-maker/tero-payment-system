import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

/**
 * On Netlify the connection is configured automatically.
 * When merging into the Vercel/Neon app, replace with:
 *   import { drizzle } from "drizzle-orm/neon-http";
 *   export const db = drizzle(process.env.DATABASE_URL!, { schema });
 * (use the neon-serverless driver if you need interactive transactions).
 */
export const db = drizzle({ schema });
export type DB = typeof db;
