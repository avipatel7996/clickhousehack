import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const update = await request.json().catch(() => ({}));
  console.info("telegram_update_received", { updateId: update?.update_id });
  return NextResponse.json({ ok: true });
}
