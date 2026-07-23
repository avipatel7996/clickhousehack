import { NextResponse } from "next/server";
import { buildDemoAnswer } from "../../../../../packages/analysis/src/answer";
import { dispatchTask } from "../../../lib/trigger";
import { ensureWorkspace, getAuthenticatedUser, getSupabaseServerClient } from "../../../lib/supabase-server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const question = String(body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "Question is required" }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  let workspaceId = String(body.workspaceId ?? request.headers.get("x-workspace-id") ?? "");
  let datasetId = String(body.datasetId ?? body.datasetImportId ?? "");
  let analysisId = crypto.randomUUID();
  if (supabase) {
    const user = await getAuthenticatedUser(supabase);
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    workspaceId = (await ensureWorkspace(supabase, user.id, workspaceId || undefined)) ?? "";
    if (!workspaceId) return NextResponse.json({ error: "A workspace membership is required" }, { status: 403 });
    if (!datasetId) {
      const { data } = await supabase.from("dataset_imports").select("id").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      datasetId = data?.id ?? "";
    }
    if (!datasetId) return NextResponse.json({ error: "datasetId is required" }, { status: 400 });
    const { data, error } = await supabase.from("analysis_runs").insert({ id: analysisId, workspace_id: workspaceId, dataset_import_id: datasetId, question, status: "queued" }).select("id").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    analysisId = data.id;
  }
  if (!workspaceId) workspaceId = crypto.randomUUID();
  if (!datasetId) datasetId = crypto.randomUUID();
  const dispatch = await dispatchTask("analyze-dataset", { analysisId, workspaceId, datasetId, question, chartPreference: body.chartPreference ?? "auto" });
  if (supabase && dispatch.runId) await supabase.from("analysis_runs").update({ trigger_run_id: dispatch.runId }).eq("id", analysisId);
  return NextResponse.json({ status: "queued", analysisId, workspaceId, triggerRunId: dispatch.runId, live: dispatch.enabled && !dispatch.error, warning: dispatch.error ?? (dispatch.enabled ? undefined : "Trigger.dev is not configured; returning a demo answer."), answer: dispatch.enabled && !dispatch.error ? undefined : buildDemoAnswer(question) }, { status: 202 });
}
