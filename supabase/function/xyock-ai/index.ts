
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_ORIGIN = "https://xyock.github.io";
const PROVIDER_URL = "https://ai-gateway.kilo.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "kilo-auto/free";
const FREE_MODELS = new Set([
  "kilo-auto/free",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "dots-studio/dots-3-note-preview:free",
]);
const MAX_QUESTION_CHARS = 4000;
const MAX_REQUEST_BYTES = 20_000_000;
const GUEST_DAILY_LIMIT = 100;

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }
  return headers;
}

function jsonResponse(
  data: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function getSecretKey(): string | null {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;

  try {
    const secrets = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}",
    );
    if (typeof secrets.default === "string") return secrets.default;
    const first = Object.values(secrets).find(
      (value) => typeof value === "string",
    );
    return typeof first === "string" ? first : null;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function consumeGuestRequest(
  ipHash: string,
  adminKey: string,
): Promise<{ allowed: boolean; remaining: number } | null> {
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!projectUrl) return null;

  const response = await fetch(
    `${projectUrl}/rest/v1/rpc/xyock_consume_guest_request`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify({ p_ip_hash: ipHash }),
    },
  );

  if (!response.ok) {
    console.error("Guest quota RPC failed:", response.status, (await response.text()).slice(0, 300));
    return null;
  }

  const result = await response.json();
  const row = Array.isArray(result) ? result[0] : result;
  if (!row || typeof row.allowed !== "boolean") return null;

  return {
    allowed: row.allowed,
    remaining: Number(row.remaining) || 0,
  };
}

async function validateUserToken(
  token: string,
  publicApiKey: string,
): Promise<boolean> {
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!projectUrl || !publicApiKey) return false;

  try {
    const response = await fetch(`${projectUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: publicApiKey,
        Authorization: `Bearer ${token}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const allowedOrigin = origin === ALLOWED_ORIGIN ? origin : null;

  if (req.method === "OPTIONS") {
    if (origin && origin !== ALLOWED_ORIGIN) {
      return jsonResponse({ error: "허용되지 않은 웹사이트입니다." }, 403, null);
    }
    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST 요청만 허용됩니다." }, 405, allowedOrigin);
  }

  if (origin && origin !== ALLOWED_ORIGIN) {
    return jsonResponse({ error: "허용되지 않은 웹사이트입니다." }, 403, null);
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "요청이 너무 큽니다." }, 413, allowedOrigin);
  }

  let payload: unknown;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: "요청이 너무 큽니다." }, 413, allowedOrigin);
    }
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "JSON 요청 본문을 확인해 주세요." }, 400, allowedOrigin);
  }

  const requestBody = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const q = requestBody.q;
  const rawAttachments = requestBody.attachments;
  const requestedModel = requestBody.model;
  const model = typeof requestedModel === "string" && FREE_MODELS.has(requestedModel)
    ? requestedModel
    : DEFAULT_MODEL;
  if (requestedModel !== undefined && (typeof requestedModel !== "string" || !FREE_MODELS.has(requestedModel))) {
    return jsonResponse({ error: "선택한 무료 모델을 사용할 수 없습니다." }, 400, allowedOrigin);
  }

  if (typeof q !== "string" || !q.trim()) {
    return jsonResponse({ error: "질문을 입력해 주세요." }, 400, allowedOrigin);
  }

  function toWellFormedText(value: string): string {
    let output = "";
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += value[i] + value[i + 1];
          i++;
        } else {
          output += "\\uFFFD";
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        output += "\\uFFFD";
      } else {
        output += value[i];
      }
    }
    return output;
  }

  const question = toWellFormedText(q.trim()).slice(0, MAX_QUESTION_CHARS);
  const attachments = Array.isArray(rawAttachments) ? rawAttachments.slice(0, 4) : [];
  const imageParts: Array<Record<string, unknown>> = [];
  let userText = question || "첨부한 파일을 분석해 주세요.";
  let totalAttachmentChars = 0;
  for (const item of attachments) {
    if (!item || typeof item !== "object") continue;
    const attachment = item as Record<string, unknown>;
    const name = toWellFormedText(typeof attachment.name === "string" ? attachment.name : "첨부 파일").slice(0, 200);
    const type = typeof attachment.type === "string" ? attachment.type : "";
    if (typeof attachment.data === "string" && type.startsWith("image/")) {
      if (attachment.data.length > 7_000_000 || !attachment.data.startsWith("data:image/")) {
        return jsonResponse({ error: "이미지 파일 크기 또는 형식을 확인해 주세요." }, 400, allowedOrigin);
      }
      imageParts.push({ type: "image_url", image_url: { url: attachment.data } });
      userText += "\\n\\n첨부 이미지: " + name;
    } else if (typeof attachment.text === "string") {
      const text = toWellFormedText(attachment.text).slice(0, 100_000);
      totalAttachmentChars += text.length;
      if (totalAttachmentChars > 300_000) {
        return jsonResponse({ error: "텍스트 첨부 파일의 총 용량이 너무 큽니다." }, 413, allowedOrigin);
      }
      userText += "\\n\\n[첨부 파일: " + name + "]\\n" + text;
    }
  }

  // Kilo's OpenAI-compatible gateway is more reliable with plain string
  // content for text-only requests. Use content blocks only when images exist.
  const messageContent: string | Array<Record<string, unknown>> = imageParts.length
    ? [{ type: "text", text: userText }, ...imageParts]
    : userText;
  const kiloKey = Deno.env.get("KILO_API_KEY");
  const adminKey = getSecretKey();
  const publicApiKey =
    Deno.env.get("SUPABASE_ANON_KEY") ??
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    req.headers.get("apikey") ??
    "";

  if (!kiloKey) {
    return jsonResponse(
      { error: "KILO_API_KEY Secret을 확인해 주세요." },
      503,
      allowedOrigin,
    );
  }

  if (!adminKey) {
    return jsonResponse(
      { error: "Supabase 서버 비밀값을 불러오지 못했습니다." },
      503,
      allowedOrigin,
    );
  }

  const authorization = req.headers.get("authorization") ?? "";
  const bearerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!bearerToken) {
    return jsonResponse({ error: "로그인 토큰이 없습니다." }, 401, allowedOrigin);
  }

  // The public key is only for guest requests; any other bearer token must be a valid Supabase user session.
  const isGuest = bearerToken === publicApiKey;
  let authenticated = false;
  if (!isGuest) {
    authenticated = await validateUserToken(bearerToken, publicApiKey);
    if (!authenticated) {
      return jsonResponse({ error: "로그인 세션이 유효하지 않습니다. 다시 로그인해 주세요." }, 401, allowedOrigin);
    }
  }

  let remaining: number | null = null;
  if (!authenticated) {
    try {
      const ipHash = await sha256Hex(
        `xyock-guest-daily-limit:${clientIp(req)}`,
      );
      const quota = await consumeGuestRequest(ipHash, adminKey);
      if (!quota) {
        return jsonResponse(
          { error: "요청 제한 서비스를 사용할 수 없습니다. SQL 설정을 확인해 주세요." },
          503,
          allowedOrigin,
        );
      }
      if (!quota.allowed) {
        return jsonResponse({ error: "Limit reached" }, 429, allowedOrigin);
      }
      remaining = quota.remaining;
    } catch (error) {
      console.error("Guest quota check failed:", error);
      return jsonResponse(
        { error: "요청 제한 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." },
        503,
        allowedOrigin,
      );
    }
  }

  try {
    const aiResponse = await fetch(PROVIDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${kiloKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "너는 xyock AI야. 정확하고 친절하게 한국어로 답해. 다른 언어를 요청하면 그 언어를 사용해. 확실하지 않은 정보는 단정하지 말고, 비밀번호나 비밀 키를 요청하거나 공개하지 마.",
          },
          { role: "user", content: messageContent },
        ],
        stream: false,
        max_tokens: ({
          "kilo-auto/free": 32768,
          "nvidia/nemotron-3.5-super-vl:free": 131072,
          "nvidia/nemotron-3-ultra-550b-a55b:free": 65536,
          "dots-studio/dots-3-note-preview:free": 131072,
        } as Record<string, number>)[model] ?? 32768,
        temperature: 0.5,
      }),
    });

    if (!aiResponse.ok) {
      const details = (await aiResponse.text()).slice(0, 500);
      console.error("Kilo Gateway error:", aiResponse.status, details);

      if (aiResponse.status === 401 || aiResponse.status === 403) {
        return jsonResponse(
          { error: "Kilo API 키가 유효한지 확인해 주세요." },
          502,
          allowedOrigin,
        );
      }

      if (aiResponse.status === 429) {
        return jsonResponse(
          { error: "무료 AI 요청 한도에 도달했어요. 잠시 후 다시 시도해 주세요." },
          429,
          allowedOrigin,
        );
      }

      return jsonResponse(
        { error: `Kilo AI 오류 (${aiResponse.status}). Supabase 함수 로그를 확인해 주세요.` },
        502,
        allowedOrigin,
      );
    }

    const result = await aiResponse.json();
    const content = result?.choices?.[0]?.message?.content;

    const answer = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
      ? content.map((part: { text?: unknown }) =>
        typeof part?.text === "string" ? part.text : ""
      ).join("").trim()
      : "";

    if (!answer) {
      return jsonResponse(
        { error: "AI가 빈 답변을 반환했어요. 다시 시도해 주세요." },
        502,
        allowedOrigin,
      );
    }

    return jsonResponse({ answer, remaining: authenticated ? null : remaining }, 200, allowedOrigin);
  } catch (error) {
    console.error("Kilo request failed:", error);
    return jsonResponse(
      { error: "AI 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." },
      502,
      allowedOrigin,
    );
  }
});
