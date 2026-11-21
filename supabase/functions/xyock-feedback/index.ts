import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://xyock.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const REPORT_EMAIL = "unknown675@naver.com";
const validCategories = new Set(["incorrect", "unsafe", "harassment", "privacy", "spam", "other"]);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) throw new Error("Supabase server configuration is incomplete.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function getStats(admin: ReturnType<typeof getAdminClient>) {
  const [up, down, reports] = await Promise.all([
    admin.from("xyock_answer_votes").select("id", { count: "exact", head: true }).eq("vote", "up"),
    admin.from("xyock_answer_votes").select("id", { count: "exact", head: true }).eq("vote", "down"),
    admin.from("xyock_answer_reports").select("id", { count: "exact", head: true }),
  ]);
  const error = up.error ?? down.error ?? reports.error;
  if (error) throw error;
  return {
    thumbsUp: up.count ?? 0,
    thumbsDown: down.count ?? 0,
    reports: reports.count ?? 0,
  };
}

async function deliverReport(report: {
  id: string;
  answer_id: string;
  answer_text: string;
  category: string;
  reason: string;
  created_at: string;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY") ?? "";
  if (!apiKey) return { sent: false, status: "pending_config", error: null };

  const from = Deno.env.get("RESEND_FROM_EMAIL") || "XYOCK Reports <onboarding@resend.dev>";
  const answerText = report.answer_text || "(답변 내용 없음)";
  const reason = report.reason || "(추가 설명 없음)";
  const html = [
    "<h2>XYOCK 답변 신고</h2>",
    "<p><b>신고 ID:</b> " + escapeHtml(report.id) + "</p>",
    "<p><b>답변 ID:</b> " + escapeHtml(report.answer_id) + "</p>",
    "<p><b>신고 사유:</b> " + escapeHtml(report.category) + "</p>",
    "<p><b>접수 시각:</b> " + escapeHtml(report.created_at) + "</p>",
    "<h3>신고 설명</h3><pre style='white-space:pre-wrap;font-family:inherit'>" + escapeHtml(reason) + "</pre>",
    "<h3>신고된 답변</h3><pre style='white-space:pre-wrap;font-family:inherit'>" + escapeHtml(answerText) + "</pre>",
  ].join("");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      from,
      to: [REPORT_EMAIL],
      subject: "[xyock] 답변 신고 · " + report.category,
      html,
      text: [
        "XYOCK 답변 신고",
        "신고 ID: " + report.id,
        "답변 ID: " + report.answer_id,
        "신고 사유: " + report.category,
        "접수 시각: " + report.created_at,
        "신고 설명: " + reason,
        "신고된 답변: " + answerText,
      ].join("\n\n"),
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "Email provider error")).slice(0, 500);
    return { sent: false, status: "failed", error: detail };
  }
  return { sent: true, status: "sent", error: null };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  try {
    const authorization = request.headers.get("Authorization") ?? "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return json({ error: "로그인이 필요합니다." }, 401);

    const admin = getAdminClient();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user) return json({ error: "인증이 만료되었습니다. 다시 로그인해 주세요." }, 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "요청 형식이 올바르지 않습니다." }, 400);
    const action = String(body.action ?? "");
    if (action === "stats") {
      return json({ ok: true, counts: await getStats(admin) });
    }

    const answerId = String(body.answerId ?? "").trim();
    if (!answerId || answerId.length > 160) return json({ error: "답변 식별자가 올바르지 않습니다." }, 400);

    if (action === "vote") {
      const vote = body.vote;
      if (vote !== null && vote !== "up" && vote !== "down") return json({ error: "평가 값이 올바르지 않습니다." }, 400);
      if (vote === null) {
        const { error } = await admin.from("xyock_answer_votes")
          .delete().eq("user_id", user.id).eq("answer_id", answerId);
        if (error) throw error;
      } else {
        const { error } = await admin.from("xyock_answer_votes").upsert({
          user_id: user.id,
          answer_id: answerId,
          vote,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,answer_id" });
        if (error) throw error;
      }
      return json({ ok: true, counts: await getStats(admin) });
    }

    if (action === "report") {
      const category = String(body.category ?? "other");
      const reason = String(body.reason ?? "").trim().slice(0, 1500);
      const answerText = String(body.answerText ?? "").slice(0, 4000);
      if (!validCategories.has(category)) return json({ error: "신고 사유가 올바르지 않습니다." }, 400);

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = await admin.from("xyock_answer_reports")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", hourAgo);
      if (recent.error) throw recent.error;
      if ((recent.count ?? 0) >= 10) return json({ error: "신고는 한 시간에 최대 10건까지 접수할 수 있습니다." }, 429);

      const inserted = await admin.from("xyock_answer_reports").insert({
        user_id: user.id,
        answer_id: answerId,
        answer_text: answerText,
        category,
        reason,
        email_status: "pending",
      }).select("id,answer_id,answer_text,category,reason,created_at").single();
      if (inserted.error || !inserted.data) throw inserted.error ?? new Error("신고를 저장하지 못했습니다.");

      const delivery = await deliverReport(inserted.data);
      await admin.from("xyock_answer_reports").update({
        email_status: delivery.status,
        email_sent_at: delivery.sent ? new Date().toISOString() : null,
        email_error: delivery.error,
      }).eq("id", inserted.data.id);

      return json({
        ok: true,
        saved: true,
        emailSent: delivery.sent,
        emailStatus: delivery.status,
        message: delivery.sent
          ? "신고가 접수되어 관리자 이메일로 전달되었습니다."
          : delivery.status === "pending_config"
            ? "신고는 저장됐지만 이메일 발송 설정이 아직 완료되지 않았습니다."
            : "신고는 저장됐지만 이메일 발송에 실패했습니다.",
        counts: await getStats(admin),
      });
    }

    return json({ error: "지원하지 않는 요청입니다." }, 400);
  } catch (error) {
    console.error("xyock-feedback error", error);
    return json({ error: error instanceof Error ? error.message : "서버 오류가 발생했습니다." }, 500);
  }
});
