import { createClient } from "@supabase/supabase-js";

/**
 * Create a Supabase client scoped to a single request.
 *
 * Workers are stateless — we create a fresh client per request.
 * The SDK uses fetch internally, so it works natively in Workers.
 */
export function getSupabase(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
}
