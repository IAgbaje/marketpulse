import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Touches the DB via PostgREST so Supabase's activity tracker sees a request,
// preventing the free-tier 7-day-inactivity project pause.
Deno.serve(async (_req: Request) => {
  const supabaseUrl = Deno.env.get("https://qkohesyqyknavriyhlsc.supabase.co")!;
  const serviceRoleKey = Deno.env.get("REDACTED_PUBLISHABLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { error } = await supabase
    .from("_keepalive")
    .update({ pinged_at: new Date().toISOString() })
    .eq("id", true);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, pinged_at: new Date().toISOString() }),
    { headers: { "Content-Type": "application/json" } },
  );
});
