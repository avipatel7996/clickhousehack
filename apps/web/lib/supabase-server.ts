import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/** Returns a cookie-aware Supabase client, or null for the local/demo setup. */
export async function getSupabaseServerClient(): Promise<SupabaseClient | null> {
  // Local development can exercise the full UI without requiring a browser session.
  // Production always uses Supabase auth when configured.
  if (process.env.NODE_ENV !== "production" && process.env.LOCAL_DEMO_AUTH !== "false") return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Route handlers may be invoked after the response has started.
        }
      },
    },
  });
}

export async function getAuthenticatedUser(client: SupabaseClient): Promise<User | null> {
  const { data } = await client.auth.getUser();
  return data.user ?? null;
}

/** Resolve a requested workspace and verify that the current user belongs to it. */
export async function resolveWorkspace(client: SupabaseClient, userId: string, requested?: string) {
  let query = client.from("workspace_members").select("workspace_id").eq("user_id", userId);
  if (requested) query = query.eq("workspace_id", requested);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw error;
  return data?.workspace_id ?? null;
}

export async function ensureWorkspace(client: SupabaseClient, userId: string, requested?: string) {
  const existing = await resolveWorkspace(client, userId, requested);
  if (existing) return existing;
  if (requested) return null;
  const workspaceId = crypto.randomUUID();
  const created = await client.from("workspaces").insert({ id: workspaceId, name: "My data workspace" });
  if (created.error) throw created.error;
  const membership = await client.from("workspace_members").insert({ workspace_id: workspaceId, user_id: userId, role: "owner" });
  if (membership.error) throw membership.error;
  return workspaceId;
}
