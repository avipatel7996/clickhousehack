import { NextResponse } from "next/server";
import { parseKaggleDatasetUrl } from "../../../../../packages/ingestion/src/url";
import { dispatchTask } from "../../../lib/trigger";
import { ensureWorkspace, getAuthenticatedUser, getSupabaseServerClient } from "../../../lib/supabase-server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  try {
    const reference = parseKaggleDatasetUrl(String(body.url ?? ""));
    const supabase = await getSupabaseServerClient();
    let workspaceId = String(body.workspaceId ?? request.headers.get("x-workspace-id") ?? "");
    let importId = crypto.randomUUID();
    if (supabase) {
      const user = await getAuthenticatedUser(supabase);
      if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      workspaceId = (await ensureWorkspace(supabase, user.id, workspaceId || undefined)) ?? "";
      if (!workspaceId) return NextResponse.json({ error: "A workspace membership is required" }, { status: 403 });
      const { data, error } = await supabase.from("dataset_imports").insert({
        id: importId, workspace_id: workspaceId, source_url: String(body.url),
        canonical_ref: `${reference.owner}/${reference.slug}`, source_version: reference.version ?? 1,
        status: "queued", idempotency_key: `${reference.owner}/${reference.slug}/${reference.version ?? 1}`,
      }).select("id").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      importId = data.id;
    }
    if (!workspaceId) workspaceId = crypto.randomUUID();
    const dispatch = await dispatchTask("ingest-dataset", { importId, workspaceId, kaggleRef: `${reference.owner}/${reference.slug}${reference.version ? `/versions/${reference.version}` : ""}`, selectedFiles: body.selectedFiles ?? [] });
    return NextResponse.json({ status: "queued", importId, workspaceId, triggerRunId: dispatch.runId, live: dispatch.enabled && !dispatch.error, warning: dispatch.error ?? (dispatch.enabled ? undefined : "Trigger.dev is not configured; running in demo mode.") }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid Kaggle dataset URL" }, { status: 400 });
  }
}
