import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { SignJWT, importPKCS8 } from "npm:jose@5.9.6";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function canonical(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const a: number[] = [];
  while (n) { a.unshift(n & 255); n >>>= 8; }
  return new Uint8Array([0x80 | a.length, ...a]);
}
function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
}
function der(tag: number, body: Uint8Array) { return concat(new Uint8Array([tag]), derLen(body.length), body); }
function pkcs1ToPkcs8(pem: string) {
  // GitHub App secrets may contain literal escaped newlines or real line breaks.
  const normalized = pem
    .replaceAll("\\r\\n", "\n")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\n")
    .trim();

  if (/-----BEGIN PRIVATE KEY-----/.test(normalized)) return normalized;

  const match = normalized.match(
    /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/
  );
  if (!match) {
    throw new Error("GITHUB_PRIVATE_KEY must be a PEM-encoded RSA private key (expected RSA PRIVATE KEY or PRIVATE KEY header)");
  }

  const b64 = match[1].replace(/\s/g, "");
  let pkcs1: Uint8Array;
  try {
    pkcs1 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    throw new Error("GITHUB_PRIVATE_KEY PEM body is not valid base64");
  }

  const alg = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);
  const body = concat(new Uint8Array([0x02, 0x01, 0x00]), alg, der(0x04, pkcs1));
  const wrapped = der(0x30, body);
  let binary = "";
  for (const x of wrapped) binary += String.fromCharCode(x);
  const encoded = btoa(binary).match(/.{1,64}/g)!.join("\n");
  return "-----BEGIN PRIVATE KEY-----\n" + encoded + "\n-----END PRIVATE KEY-----";
}

function validPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.length <= 240 &&
    !p.startsWith("/") && !p.includes("..") && !p.includes("\\") &&
    !p.split("/").some(x => !x || x === "." );
}
function b64utf8(s: string) {
  const bytes = new TextEncoder().encode(s);
  let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}


async function createGitHubClient(user: any) {
  const appId = Deno.env.get("GITHUB_APP_ID")!;
  const privateKey = Deno.env.get("GITHUB_PRIVATE_KEY")!;
  if (!appId || !privateKey) throw new Error("GitHub App secrets unavailable");

  const githubIdentity = Array.isArray(user?.identities)
    ? user.identities.find((identity: any) => String(identity?.provider || "").toLowerCase() === "github")
    : null;
  if (!githubIdentity) throw new Error("GitHub 계정을 먼저 연결해 주세요.");

  const identityData = githubIdentity.identity_data && typeof githubIdentity.identity_data === "object"
    ? githubIdentity.identity_data
    : {};
  const githubProviderId = String(
    githubIdentity.provider_id ?? githubIdentity.id ?? identityData.provider_id ?? identityData.id ?? identityData.sub ?? ""
  ).trim();
  const githubLogin = String(
    identityData.user_name ?? identityData.login ?? identityData.preferred_username ?? ""
  ).trim().toLowerCase();
  if (!githubProviderId && !githubLogin) {
    throw new Error("연결된 GitHub 계정의 식별 정보를 확인할 수 없습니다. GitHub 계정을 다시 연결해 주세요.");
  }

  const key = await importPKCS8(pkcs1ToPkcs8(privateKey), "RS256");
  const now = Math.floor(Date.now() / 1000);
  const appJwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(appId).setIssuedAt(now - 30).setExpirationTime(now + 8 * 60).sign(key);

  const installations: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      "https://api.github.com/app/installations?per_page=100&page=" + page,
      {
        headers: {
          Authorization: "Bearer " + appJwt,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error("GitHub App 설치 목록을 확인하지 못했습니다. (" + response.status + ")");
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("GitHub App 설치 목록 응답이 올바르지 않습니다.");
    installations.push(...rows);
    if (rows.length < 100) break;
  }

  const installation = installations.find((item: any) => {
    const account = item?.account || {};
    const sameId = githubProviderId && String(account.id ?? "") === githubProviderId;
    const sameLogin = githubLogin && String(account.login ?? "").toLowerCase() === githubLogin;
    return !!(sameId || sameLogin);
  });
  if (!installation?.id) {
    throw new Error("이 GitHub 계정에는 xyock GitHub App이 설치되어 있지 않습니다. GitHub App을 해당 계정에 설치하고 저장소 접근을 허용해 주세요.");
  }

  const tokenRes = await fetch(
    "https://api.github.com/app/installations/" + encodeURIComponent(String(installation.id)) + "/access_tokens",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + appJwt,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!tokenRes.ok) throw new Error("GitHub installation token request failed (" + tokenRes.status + ")");
  const tokenData = await tokenRes.json();

  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch("https://api.github.com" + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + tokenData.token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const txt = await res.text();
    let value: any = {};
    try { value = txt ? JSON.parse(txt) : {}; } catch { value = { message: txt.slice(0, 500) }; }
    if (!res.ok) throw new Error("GitHub API error (" + res.status + "): " + (value.message || "request failed"));
    return value;
  };
}
async function listInstallationRepositories(gh: (path: string, init?: RequestInit) => Promise<any>) {
  const all: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await gh(`/installation/repositories?per_page=100&page=${page}`);
    const rows = Array.isArray(result.repositories) ? result.repositories : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return json({ error: "Sign-in required" }, 401);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!url || !anon || !service) throw new Error("Supabase server credentials unavailable");
    const userClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } });
    const { data: ud, error: ue } = await userClient.auth.getUser(match[1]);
    if (ue || !ud.user) return json({ error: "Invalid session" }, 401);
    const userId = ud.user.id;
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json();
    const op = body?.op;
    const identityProviders = [
      ud.user.app_metadata?.provider,
      ...(Array.isArray(ud.user.identities) ? ud.user.identities.map((identity: any) => identity?.provider) : []),
    ].filter(Boolean).map((value: unknown) => String(value).toLowerCase());
    if (!identityProviders.includes("github")) {
      return json({ error: "GitHub 계정 연결 후 저장소를 사용할 수 있습니다." }, 403);
    }

    async function audit(requestId: string | null, event: string, details: unknown = {}) {
      const { error } = await admin.from("github_action_audit").insert({
        request_id: requestId, user_id: userId, event_type: event, details
      });
      if (error) console.error("audit insert failed", error.message);
    }

    if (op === "repositories") {
      const gh = await createGitHubClient(ud.user);
      const repositories = await listInstallationRepositories(gh);
      return json({ repositories: repositories.map((r: any) => ({
        full_name: r.full_name, private: !!r.private, default_branch: r.default_branch || "main"
      })).sort((a: any, b: any) => a.full_name.localeCompare(b.full_name)) });
    }

    if (op === "inspect") {
      const repo = body.repo;
      if (typeof repo !== "string" || repo.split("/").length !== 2 || repo.includes("..")) return json({ error: "Select a valid repository" }, 400);
      const gh = await createGitHubClient(ud.user);
      const accessible = await listInstallationRepositories(gh);
      const repoEntry = accessible.find((r: any) => r.full_name.toLowerCase() === repo.toLowerCase());
      if (!repoEntry) return json({ error: "Repository is not connected to this GitHub App installation" }, 403);
      const [owner, repository] = repo.split("/");
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const branch = repoEntry.default_branch || "main";
      const tree = await gh(base + "/git/trees/" + encodeURIComponent(branch) + "?recursive=1");
      const files = (tree.tree || []).filter((x: any) => x.type === "blob").map((x: any) => x.path).slice(0, 250);
      const candidates = files.filter((p: string) => /README\.md|package\.json|index\.html|xyock\.html|app\.(js|ts|py)|main\.(js|ts|py)/i.test(p)).slice(0, 6);
      const selected: Array<{path:string; content:string}> = [];
      for (const path of candidates) {
        try {
          const item = await gh(base + "/contents/" + path.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(branch));
          if (item.encoding === "base64" && typeof item.content === "string") {
            const binary = atob(item.content.replace(/\\n/g, ""));
            const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            selected.push({ path, content: new TextDecoder().decode(bytes).slice(0, 9000) });
          }
        } catch (e) { console.error("inspect file skipped", path, e); }
      }
      return json({ repo: repoEntry.full_name, branch, files, selected });
    }

    if (op === "request") {
      const repo = body.repo;
      if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return json({ error: "Select a valid repository" }, 400);
      const repoGh = await createGitHubClient(ud.user);
      const accessible = await listInstallationRepositories(repoGh);
      const repoEntry = accessible.find((r: any) => r.full_name.toLowerCase() === repo.toLowerCase());
      if (!repoEntry) return json({ error: "Repository is not connected to this GitHub App installation" }, 403);
      const action = body.action_type;
      const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
      const allowed = ["read_file", "create_file", "update_file", "create_pull_request", "deploy_pages", "commit_changes"];
      if (!allowed.includes(action)) return json({ error: "Unsupported action" }, 400);
      let path: string | null = null;
      if (["read_file", "create_file", "update_file"].includes(action)) {
        if (!validPath(body.target_path)) return json({ error: "Invalid target_path" }, 400);
        path = body.target_path;
      }
      if (["create_file", "update_file"].includes(action)) {
        if (typeof payload.content !== "string" || payload.content.length > 100000) return json({ error: "File content must be <= 100 KB" }, 400);
        if (typeof payload.message !== "string" || payload.message.length < 1 || payload.message.length > 200) return json({ error: "Commit message required (max 200 chars)" }, 400);
      }
      if (action === "create_pull_request") {
        if (typeof payload.head !== "string" || !/^[A-Za-z0-9._/-]{1,100}$/.test(payload.head) ||
            typeof payload.title !== "string" || payload.title.length < 1 || payload.title.length > 200 ||
            typeof payload.body !== "string" || payload.body.length > 5000 ||
            (payload.base !== undefined && payload.base !== (repoEntry.default_branch || "main"))) return json({ error: "Invalid pull request details; base must be main" }, 400);
        payload.base = repoEntry.default_branch || "main";
      }
      if (action === "commit_changes") {
        if (typeof payload.message !== "string" || !payload.message.trim() || payload.message.length > 200) {
          return json({ error: "커밋 메시지를 입력해 주세요. (최대 200자)" }, 400);
        }
        if (!Array.isArray(payload.changes) || payload.changes.length < 1 || payload.changes.length > 12) {
          return json({ error: "한 번에 1~12개 파일만 커밋할 수 있습니다." }, 400);
        }
        const seen = new Set<string>();
        let totalBytes = 0;
        const changes: Array<{path:string;content:string}> = [];
        for (const item of payload.changes) {
          if (!item || typeof item !== "object" || !validPath(item.path) || typeof item.content !== "string") {
            return json({ error: "파일 경로 또는 내용이 올바르지 않습니다." }, 400);
          }
          if (seen.has(item.path)) return json({ error: "같은 파일이 변경 목록에 중복되었습니다: " + item.path }, 400);
          seen.add(item.path);
          const size = new TextEncoder().encode(item.content).length;
          if (size > 100_000) return json({ error: item.path + " 파일은 100 KB 이하여야 합니다." }, 413);
          totalBytes += size;
          if (totalBytes > 600_000) return json({ error: "전체 변경 내용은 600 KB 이하여야 합니다." }, 413);
          changes.push({ path: item.path, content: item.content });
        }
        const [owner, repository] = repoEntry.full_name.split("/");
        const repoApi = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repository);
        const branch = repoEntry.default_branch || "main";
        const head = await repoGh(repoApi + "/git/ref/heads/" + encodeURIComponent(branch));
        if (typeof head?.object?.sha !== "string") throw new Error("저장소 기준 커밋을 확인하지 못했습니다.");
        payload.changes = changes;
        payload.branch = branch;
        payload.base_sha = head.object.sha;
        payload.base_tree_sha = (await repoGh(repoApi + "/git/commits/" + encodeURIComponent(head.object.sha))).tree?.sha;
        if (typeof payload.base_tree_sha !== "string") throw new Error("저장소 기준 트리를 확인하지 못했습니다.");
      }
      if (action === "deploy_pages" && Object.keys(payload).length) return json({ error: "deploy_pages takes no payload" }, 400);
      const payloadHash = await sha256(canonical(payload));
      const { data, error } = await admin.from("github_action_requests").insert({
        user_id: userId, repo: repoEntry.full_name, action_type: action, target_path: path,
        payload, payload_hash: payloadHash, status: "pending",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }).select("id,repo,action_type,target_path,payload,status,created_at,expires_at").single();
      if (error) throw error;
      await audit(data.id, "requested", { action_type: action, target_path: path, payload_hash: payloadHash });
      return json({ request: data, message: "Pending explicit approval. No GitHub action has run." }, 201);
    }

    if (op === "list") {
      const { data, error } = await admin.from("github_action_requests")
        .select("id,repo,action_type,target_path,payload,status,created_at,expires_at,approved_at,executed_at,result")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return json({ requests: data });
    }

    if (op === "approve" || op === "reject") {
      if (typeof body.id !== "string") return json({ error: "Request id required" }, 400);
      const { data: row, error: readErr } = await admin.from("github_action_requests")
        .select("id,status,expires_at,payload,payload_hash").eq("id", body.id).eq("user_id", userId).maybeSingle();
      if (readErr) throw readErr;
      if (!row) return json({ error: "Request not found" }, 404);
      if (row.status !== "pending") return json({ error: "Request is no longer pending" }, 409);
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await admin.from("github_action_requests").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");
        await audit(row.id, "expired");
        return json({ error: "Request expired" }, 410);
      }
      if (await sha256(canonical(row.payload)) !== row.payload_hash) return json({ error: "Payload integrity check failed" }, 409);
      const next = op === "approve" ? "approved" : "rejected";
      const patch: Record<string, unknown> = { status: next };
      if (next === "approved") patch.approved_at = new Date().toISOString();
      const { data: changed, error } = await admin.from("github_action_requests").update(patch)
        .eq("id", row.id).eq("user_id", userId).eq("status", "pending")
        .gt("expires_at", new Date().toISOString()).select("id,status").maybeSingle();
      if (error) throw error;
      if (!changed) return json({ error: "Request was already handled or expired" }, 409);
      await audit(row.id, next === "approved" ? "approved" : "rejected");
      return json({ id: row.id, status: next });
    }

    if (op === "execute") {
      if (typeof body.id !== "string") return json({ error: "Request id required" }, 400);
      const { data: row, error: readErr } = await admin.from("github_action_requests").select("*")
        .eq("id", body.id).eq("user_id", userId).maybeSingle();
      if (readErr) throw readErr;
      if (!row) return json({ error: "Request not found" }, 404);
      if (row.status !== "approved") return json({ error: "Only approved requests can execute" }, 409);
      if (new Date(row.expires_at).getTime() <= Date.now()) return json({ error: "Approval expired" }, 410);
      if (await sha256(canonical(row.payload)) !== row.payload_hash) return json({ error: "Payload integrity check failed" }, 409);
      const { data: locked, error: lockErr } = await admin.from("github_action_requests")
        .update({ status: "executing" }).eq("id", row.id).eq("user_id", userId)
        .eq("status", "approved").gt("expires_at", new Date().toISOString())
        .select("id").maybeSingle();
      if (lockErr) throw lockErr;
      if (!locked) return json({ error: "Approval already consumed or expired" }, 409);
      await audit(row.id, "execution_started");

      try {
        const gh = await createGitHubClient(ud.user);
        const allowedRepos = await listInstallationRepositories(gh);
        if (!allowedRepos.some((r: any) => r.full_name.toLowerCase() === String(row.repo).toLowerCase())) {
          throw new Error("Repository is no longer connected to this GitHub App installation");
        }
        const [owner, repository] = String(row.repo).split("/");
        const repoApi = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
        const action = row.action_type;
        const path = row.target_path ? row.target_path.split("/").map(encodeURIComponent).join("/") : "";
        let result: any;
        if (action === "read_file") {
          result = await gh(repoApi + "/contents/" + path);
          if (result.content && result.encoding === "base64") {
            const raw = atob(result.content.replace(/\n/g, ""));
            const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
            result.decoded_content = new TextDecoder().decode(bytes);
          }
        } else if (action === "create_file" || action === "update_file") {
          let sha: string | undefined;
          if (action === "update_file") {
            const current = await gh(repoApi + "/contents/" + path);
            sha = current.sha;
            if (!sha) throw new Error("Existing file SHA not found");
          }
          result = await gh(repoApi + "/contents/" + path, { method: "PUT", body: JSON.stringify({
            message: row.payload.message, content: b64utf8(row.payload.content), branch: "main", ...(sha ? { sha } : {})
          }) });
          result = { commit: result.commit?.sha, content: result.content?.path };
        } else if (action === "commit_changes") {
          const branch = String(row.payload.branch || "main");
          const latest = await gh(repoApi + "/git/ref/heads/" + encodeURIComponent(branch));
          if (latest?.object?.sha !== row.payload.base_sha) {
            throw new Error("승인 대기 중 기본 브랜치가 변경되었습니다. 최신 코드로 다시 요청해 주세요.");
          }
          const baseCommit = await gh(repoApi + "/git/commits/" + encodeURIComponent(row.payload.base_sha));
          if (baseCommit?.tree?.sha !== row.payload.base_tree_sha) {
            throw new Error("저장소 기준 트리가 변경되었습니다. 최신 코드로 다시 요청해 주세요.");
          }
          const changes = row.payload.changes as Array<{path:string;content:string}>;
          const treeEntries = [];
          for (const change of changes) {
            const blob = await gh(repoApi + "/git/blobs", {
              method: "POST",
              body: JSON.stringify({ content: change.content, encoding: "utf-8" })
            });
            treeEntries.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
          }
          const tree = await gh(repoApi + "/git/trees", {
            method: "POST",
            body: JSON.stringify({ base_tree: row.payload.base_tree_sha, tree: treeEntries })
          });
          const commit = await gh(repoApi + "/git/commits", {
            method: "POST",
            body: JSON.stringify({ message: row.payload.message, tree: tree.sha, parents: [row.payload.base_sha] })
          });
          await gh(repoApi + "/git/refs/heads/" + encodeURIComponent(branch), {
            method: "PATCH",
            body: JSON.stringify({ sha: commit.sha, force: false })
          });
          result = {
            commit: commit.sha,
            html_url: commit.html_url,
            branch,
            files: changes.map(change => change.path)
          };
        } else if (action === "create_pull_request") {
          result = await gh(repoApi + "/pulls", { method: "POST", body: JSON.stringify({
            title: row.payload.title, head: row.payload.head, base: row.payload.base || "main", body: row.payload.body
          }) });
          result = { number: result.number, html_url: result.html_url, state: result.state };
        } else if (action === "deploy_pages") {
          result = await gh(repoApi + "/pages/builds", { method: "POST", body: "{}" });
          result = { status: result.status, url: result.url, created_at: result.created_at };
        } else {
          throw new Error("Unsupported action");
        }
        const { error: doneErr } = await admin.from("github_action_requests").update({
          status: "completed", executed_at: new Date().toISOString(), result
        }).eq("id", row.id).eq("status", "executing");
        if (doneErr) throw doneErr;
        await audit(row.id, "execution_completed", { result });
        return json({ id: row.id, status: "completed", result });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Execution failed";
        await admin.from("github_action_requests").update({
          status: "failed", executed_at: new Date().toISOString(), result: { error: message.slice(0, 500) }
        }).eq("id", row.id).eq("status", "executing");
        await audit(row.id, "execution_failed", { error: message.slice(0, 500) });
        return json({ id: row.id, status: "failed", error: message }, 502);
      }
    }

    return json({ error: "Unknown op. Use request, list, approve, reject, execute." }, 400);
  } catch (e) {
    console.error("github-actions error", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});