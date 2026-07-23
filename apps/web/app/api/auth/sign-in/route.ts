import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "../../../../lib/supabase-server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Supabase auth is not enabled in local demo mode" }, { status: 400 });
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin}/auth/callback` } });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ message: "Magic link sent. Check your inbox." });
}
