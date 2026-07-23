import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "../../../lib/supabase-server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const supabase = await getSupabaseServerClient();
  if (code && supabase) await supabase.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(new URL("/", request.url));
}
