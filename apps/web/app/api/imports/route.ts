import { NextResponse } from "next/server";
import { parseKaggleDatasetUrl } from "../../../../../packages/ingestion/src/url";
import { dispatchTask } from "../../../lib/trigger";
import { ensureWorkspace, getAuthenticatedUser, getSupabaseServerClient } from "../../../lib/supabase-server";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const user = await getAuthenticatedUser(supabase);
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const workspaceId = await ensureWorkspace(supabase, user.id);
  if (!id) {
    const { data, error } = await supabase.from("dataset_imports").select("id,source_url,canonical_ref,status,row_count,physical_tables,created_at").eq("workspace_id", workspaceId ?? "").order("created_at", { ascending: false }).limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ imports: data ?? [] });
  }
  const { data, error } = await supabase.from("dataset_imports").select("id,status,row_count,physical_tables,created_at").eq("id", id).eq("workspace_id", workspaceId ?? "").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
}


export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  let reference: ReturnType<typeof parseKaggleDatasetUrl>;
  try {
    reference = parseKaggleDatasetUrl(String(body.url ?? ""));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid Kaggle dataset URL" }, { status: 400 });
  }
  try {
    const supabase = await getSupabaseServerClient();
    let workspaceId = String(body.workspaceId ?? request.headers.get("x-workspace-id") ?? "");
    let importId = crypto.randomUUID();
    if (supabase) {
      const user = await getAuthenticatedUser(supabase);
      if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      workspaceId = (await ensureWorkspace(supabase, user.id, workspaceId || undefined)) ?? "";
      if (!workspaceId) return NextResponse.json({ error: "A workspace membership is required" }, { status: 403 });
      const idempotencyKey = `${reference.owner}/${reference.slug}/${reference.version ?? 1}`;
      const existing = await supabase.from("dataset_imports").select("id,status").eq("workspace_id", workspaceId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existing.error) return NextResponse.json({ error: `Unable to check existing import: ${existing.error.message}` }, { status: 500 });
      if (existing.data) return NextResponse.json({ status: existing.data.status, importId: existing.data.id, workspaceId, deduplicated: true }, { status: 200 });
      const { data, error } = await supabase.from("dataset_imports").insert({
        id: importId, workspace_id: workspaceId, source_url: String(body.url),
        canonical_ref: `${reference.owner}/${reference.slug}`, source_version: reference.version ?? 1,
        status: "queued", idempotency_key: idempotencyKey,
      }).select("id").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      importId = data.id;
    }
    if (!workspaceId) workspaceId = crypto.randomUUID();
    const dispatch = await dispatchTask("ingest-dataset", { importId, workspaceId, kaggleRef: `${reference.owner}/${reference.slug}${reference.version ? `/versions/${reference.version}` : ""}`, selectedFiles: body.selectedFiles ?? [] });
    if (!dispatch.enabled || dispatch.error || !dispatch.runId) {
      const message = dispatch.error ?? "TRIGGER_SECRET_KEY is missing; no ingestion worker was dispatched";
      await supabase?.from("dataset_imports").update({ status: "failed" }).eq("id", importId);
      return NextResponse.json({ error: message, importId, live: false }, { status: 503 });
    }
    // trigger_run_id is optional for compatibility with databases created before tracking columns were added.
    return NextResponse.json({ status: "queued", importId, workspaceId, triggerRunId: dispatch.runId, live: dispatch.enabled && !dispatch.error, warning: dispatch.error ?? (dispatch.enabled ? undefined : "Trigger.dev is not configured; running in demo mode.") }, { status: 202 });
  } catch (error) {
    console.error("Dataset import setup failed", error);
    return NextResponse.json({ error: `Import setup failed: ${error instanceof Error ? error.message : "unknown error"}` }, { status: 500 });
  }
}
