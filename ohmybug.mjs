#!/usr/bin/env node
// ohmybug: review the git diff of the current folder with the OhMyBug hosted bug hunt, from a CI job or a shell.
// One file, no dependencies, Node 18+. Exit 0: no medium or worse bug. 1: at least one. 2: the review could not run.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
const USAGE = `ohmybug ${VERSION}: review this repository's changes with OhMyBug.

Usage:
  ohmybug [--base <ref>]     review <base>...HEAD (the committed changes of this branch)
  ohmybug --uncommitted      review the working tree against HEAD, untracked files included

The base is --base, else $CI_MERGE_REQUEST_TARGET_BRANCH_NAME (GitLab merge request pipelines),
else origin/main.

Environment:
  OHMYBUG_API_KEY     required: a key from https://ohmybug.ai/me
  OHMYBUG_URL         default https://mcp.ohmybug.ai
  OHMYBUG_TIMEOUT_S   how long to wait for the review, default 1800

Behind a proxy: Node's fetch reads HTTPS_PROXY only on Node 24+ with NODE_USE_ENV_PROXY=1.

Exit codes: 0 no medium or worse bug, 1 at least one, 2 the review could not run, or was cut short with no
medium or worse bug.`;

/** Severity order, in lower case; P0-P3 is the same scale. */
const RANK = { critical: 0, p0: 0, high: 1, p1: 1, medium: 2, p2: 2, low: 3, p3: 3 };
const rankOf = (f) => RANK[String(f?.severity).toLowerCase()] ?? 4;
/** Severities a pipeline gates on: the ones OhMyBug bills as real bugs. */
export const BLOCKING = new Set(Object.keys(RANK).filter((k) => RANK[k] <= 2));
const isBlocking = (f) => rankOf(f) <= 2;
// Server caps: 30 files and about 10 MiB of diff and files per call; 20 files per answer to a file request.
const MAX_FILES = 30, MAX_EXTRA = 20, MAX_BYTES = 9 * 1024 * 1024, MAX_BODY = 11_500_000, MAX_FILE = 512 * 1024;
const MAX_TREE = 1024 * 1024, MAX_UNTRACKED = 500, MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;
// Pinned diff format, whatever the user's git config says (noprefix, mnemonicPrefix, textconv drivers).
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
const TRANSIENT_TOOL = new Set(["internal", "rate_limited"]);

export class Refusal extends Error {}
export class Deadline extends Error {}

/** argv → options, or a string to print and exit 2 on. */
export function parseArgs(argv) {
  const o = { base: undefined, uncommitted: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uncommitted") o.uncommitted = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--version") o.version = true;
    else if (a === "--base") { if (!argv[i + 1] || argv[i + 1].startsWith("-")) return "--base needs a ref"; o.base = argv[++i]; }
    else if (a.startsWith("--base=")) { if (!a.slice(7)) return "--base needs a ref"; o.base = a.slice(7); }
    else return `unknown argument: ${a}`;
  }
  if (o.uncommitted && o.base) return "--uncommitted and --base do not go together";
  return o;
}

/**
 * The ref the branch is compared with: --base, then the merge request's target branch (as the remote-tracking ref when
 * the clone has it, since a CI clone rarely has the local branch), then origin/main.
 */
export function resolveBase(opts, env, hasRef) {
  if (opts.base) return opts.base;
  const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (target) return hasRef(`origin/${target}`) ? `origin/${target}` : target;
  return "origin/main";
}

/**
 * The change to review: { diff, changed, all, rev, base, skipped }. `all` is every path the client may send (the tree
 * at the reviewed commit, plus the untracked files with --uncommitted); `rev` is that commit's sha, null for the
 * working tree; `skipped` lists untracked paths left out of the diff.
 */
export function selectChange(opts, env, git, root) {
  if (opts.uncommitted) {
    let diff = git("diff", "HEAD", ...DIFF_FLAGS);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    // An untracked build folder would be thousands of git processes; a nested repository (`sub/`) is not a file.
    const skipped = [];
    let count = 0;
    for (const p of untracked) {
      let size = Infinity;
      try { size = lstatSync(join(root, p)).size; } catch {}
      const piece = !p.endsWith("/") && size <= MAX_UNTRACKED_BYTES && count < MAX_UNTRACKED ? gitNoIndex(git, p) : null;
      if (piece === null) skipped.push(p); else { diff += piece; count++; }
    }
    const diffed = untracked.filter((p) => !skipped.includes(p));
    const changed = [...git("diff", "HEAD", "--name-only", "--diff-filter=d", "-z").split("\0").filter(Boolean), ...diffed];
    const all = [...git("ls-files", "-z").split("\0").filter(Boolean), ...diffed];
    return { diff, changed, all, rev: null, base: "HEAD", skipped };
  }
  const base = resolveBase(opts, env, (ref) => { try { git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); return true; } catch { return false; } });
  try { git("rev-parse", "--verify", "--quiet", `${base}^{commit}`); }
  catch { throw new Refusal(`base ${base} is not a commit in this clone (${opts.base ? "fetch it, or check the ref" : "fetch it, or pass --base"})`); }
  // The sha, not HEAD: a file request answered minutes later reads the commit that was reviewed.
  const rev = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  const range = `${base}...${rev}`;
  const diff = git("diff", range, ...DIFF_FLAGS);
  const changed = git("diff", range, "--name-only", "--diff-filter=d", "-z").split("\0").filter(Boolean);
  const all = git("ls-tree", "-r", "--name-only", "-z", rev).split("\0").filter(Boolean);
  return { diff, changed, all, rev, base, skipped: [] };
}

/** A new-file diff for an untracked path, or null when git cannot diff it (unreadable, special). */
function gitNoIndex(git, path) {
  // `git diff --no-index` exits 1 when there is a difference, which is the point.
  try { return git("diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", path); }
  catch (e) { return e.status === 1 && e.stdout ? e.stdout.toString() : null; }
}

// A diff over the server's 2 MiB cut is split across reviewers; its per-file entries over 160 KiB are lockfiles,
// bundles or generated output: dropped, unless none would be left.
const SPLIT_BYTES = 2 * 1024 * 1024, MAX_ENTRY = 160 * 1024;
export function trimDiff(diff, log = () => {}) {
  if (Buffer.byteLength(diff) <= SPLIT_BYTES) return diff;
  const parts = diff.split(/(?=^diff --git )/m);
  const isBig = (p) => p.startsWith("diff --git ") && Buffer.byteLength(p) > MAX_ENTRY;
  const kept = parts.filter((p) => !isBig(p));
  if (kept.length === parts.length || !kept.some((p) => p.startsWith("diff --git "))) return diff;
  log(`diff trimmed: left out ${parts.length - kept.length} file(s) over ${MAX_ENTRY} bytes`);
  return kept.join("");
}

/**
 * path → text or null. Only a path of the change's own list is read, never one under .git (in any case), so a request
 * can not reach an ignored file; from the reviewed commit, or the working tree with --uncommitted (where the list
 * holds the untracked files of the diff too).
 * Missing, binary, LFS pointers and files over MAX_FILE read as null.
 */
export function fileReader(root, change, gitBuf) {
  const known = new Set(change.all);
  const allowed = (p) => known.has(p) && !p.split("/").some((s) => s.toLowerCase() === ".git");
  const text = (buf) => {
    if (buf.subarray(0, 8000).includes(0)) return null;
    const s = buf.toString("utf8");
    return s.startsWith("version https://git-lfs.github.com/spec/") ? null : s;
  };
  return (requested) => {
    const path = String(requested).replace(/^\/+/, "");
    if (!allowed(path)) return null;
    try {
      if (change.rev) {
        if (Number(gitBuf("cat-file", "-s", `${change.rev}:${path}`)) > MAX_FILE) return null;
        return text(gitBuf("cat-file", "blob", `${change.rev}:${path}`));
      }
      // A symlink is followed only to another file of the list.
      const abs = realpathSync(join(root, path));
      if (!abs.startsWith(root + sep) || !allowed(abs.slice(root.length + 1).split(sep).join("/"))) return null;
      const st = statSync(abs);
      return st.isFile() && st.size <= MAX_FILE ? text(readFileSync(abs)) : null;
    } catch { return null; }
  };
}

function pack(read, paths, max, budget) {
  const files = [];
  for (const path of paths) {
    if (files.length >= max) break;
    const content = read(path);
    if (content === null || Buffer.byteLength(content) > budget) continue;
    budget -= Buffer.byteLength(content);
    files.push({ path, content });
  }
  return files;
}

/** Project manifests and rule files a reviewer checks a change against. */
const ROOT_FILES = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|tsconfig\.json|AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md|README\.md)$/i;

/** Changed files first, then root manifests, then the files that mention a changed module by name, most mentions first. */
function contextPaths(changed, all, git, rev) {
  const seen = new Set(changed);
  const roots = all.filter((p) => !p.includes("/") && ROOT_FILES.test(p) && !seen.has(p));
  roots.forEach((p) => seen.add(p));
  const hits = new Map();
  const stems = [...new Set(changed.map((p) => p.split("/").pop().replace(/\.[^.]+$/, ""))
    .filter((s) => s.length >= 4 && !/^(index|main|init|__init__|readme|test|tests|utils)$/i.test(s)))].slice(0, 20);
  for (const stem of stems) {
    let out = "";
    try { out = git("grep", "-l", "-I", "-F", "-w", "-z", "-e", stem, ...(rev ? [rev] : []), "--"); } catch { continue; } // exit 1: no match
    for (const ref of out.split("\0").filter(Boolean)) {
      const p = rev ? ref.slice(rev.length + 1) : ref;
      if (!seen.has(p)) hits.set(p, (hits.get(p) ?? 0) + 1);
    }
  }
  return [...changed, ...roots, ...[...hits].sort((a, b) => b[1] - a[1]).map(([p]) => p)];
}

/** What the CI says about the change, as the server's optional labels; never repo or ref, so the server reads no host. */
export function ciMeta(env, git) {
  const cut = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
  let branch = cut(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME || env.BITBUCKET_BRANCH, 200);
  if (!branch) { try { branch = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { branch = ""; } }
  const title = cut(env.CI_MERGE_REQUEST_TITLE, 300), body = cut(env.CI_MERGE_REQUEST_DESCRIPTION, 8000);
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), ...(title ? { pr_title: title } : {}), ...(body ? { pr_body: body } : {}) };
}

/** 0, 1 or 2 for a finished review body. */
export function exitCodeFor(r) {
  if (r.status !== "done") return 2;
  if ((r.findings ?? []).some(isBlocking)) return 1;
  // A run that was cut short and found nothing is not a clean result: the gate cannot pass on it.
  return r.review_of_record === false ? 2 : 0;
}

export function formatFindings(findings) {
  return [...findings].sort((a, b) => rankOf(a) - rankOf(b)).map((f) => {
    const where = f.file ? (f.line ? `${f.file}:${f.line}` : String(f.file)) : "";
    const scenario = String(f.failure_scenario ?? "").trim().replace(/\n/g, "\n    ");
    return `${String(f.severity ?? "unrated").toUpperCase()}  ${where}  ${f.title ?? ""}`.trimEnd() + (scenario ? `\n    ${scenario}` : "");
  }).join("\n\n");
}

/** Context files dropped from the end until the JSON body (escaping included) fits the server's cap. */
export function fitBody(body, max = MAX_BODY) {
  const files = [...body.files];
  while (files.length > 1 && Buffer.byteLength(JSON.stringify({ ...body, files })) > max) files.pop();
  return { ...body, files };
}

/** An MCP answer: a JSON body, or a text/event-stream whose last data event carries the JSON-RPC response. */
export function rpcMessage(text) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  const events = text.split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n"));
  for (const data of events.reverse()) {
    try { const m = JSON.parse(data); if (m && (m.result || m.error)) return m; } catch {}
  }
  throw new Refusal(`unreadable answer: ${text.slice(0, 200)}`);
}

/** One review, start to end. Returns the exit code; never calls process.exit itself (the tests drive it). */
export async function run({ argv, env, cwd, out = (s) => process.stdout.write(s + "\n"), log = (s) => process.stderr.write(`ohmybug: ${s}\n`) }) {
  const opts = parseArgs(argv);
  if (typeof opts === "string") { log(opts); log("see ohmybug --help"); return 2; }
  if (opts.help) { out(USAGE); return 0; }
  if (opts.version) { out(VERSION); return 0; }
  if (!env.OHMYBUG_API_KEY) { log("OHMYBUG_API_KEY is not set: create a key at https://ohmybug.ai/me"); return 2; }
  const timeoutS = Number(env.OHMYBUG_TIMEOUT_S || 1800);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) { log(`OHMYBUG_TIMEOUT_S must be a number of seconds, not ${env.OHMYBUG_TIMEOUT_S}`); return 2; }
  const api = (env.OHMYBUG_URL || "https://mcp.ohmybug.ai").replace(/\/$/, "");
  const deadline = Date.now() + timeoutS * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))));
  const execGit = (dir, a) => execFileSync("git", ["-C", dir, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

  /**
   * POST and return the body text, retrying network errors, 408, 429 and 5xx until the deadline. With `once` (a call
   * that starts a paid hunt) only failures that prove the server never took the request are retried.
   */
  let reached = false;
  async function http(url, init, once = false) {
    const keyed = Boolean(init.headers?.authorization);
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Deadline("timed out");
      let why, retryAfter = 0;
      try {
        // A paid call is not cut at 60 s: a multi-MB upload on a slow uplink takes longer, and it is not resent.
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(once ? left : Math.min(60_000, left)) });
        reached = true;
        const text = await res.text();
        if (res.ok) return text;
        if ((res.status === 401 || res.status === 403) && keyed) throw new Refusal(`the API key was refused (HTTP ${res.status})`);
        const retryable = res.status === 429 || (!once && (res.status === 408 || res.status >= 500));
        if (!retryable) throw new Refusal(`HTTP ${res.status} ${text.slice(0, 300)}`);
        why = `HTTP ${res.status}`;
        retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
      } catch (e) {
        if (e instanceof Refusal) throw e;
        why = e.cause?.code ?? e.message;
        const unreachable = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(e.cause?.code);
        if (once && !unreachable) {
          throw new Refusal(`no clear answer (${why}); not sent again, so as not to start a second hunt. A hunt may have started: see https://ohmybug.ai/me`);
        }
        // A host never reached is a wrong OHMYBUG_URL or a proxy-only runner, not a blip worth the whole timeout.
        if (unreachable && !reached && attempt >= 3) {
          const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
          throw new Refusal(`cannot reach ${new URL(url).host} (${why})${proxy ? "; Node's fetch ignores HTTPS_PROXY unless Node 24+ runs with NODE_USE_ENV_PROXY=1" : ""}`);
        }
      }
      const wait = Math.max(retryAfter, Math.min(30_000, 2000 * 2 ** attempt));
      log(`${why}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  let rpcId = 0;
  async function tool(name, args, once = false) {
    for (let attempt = 0; ; attempt++) {
      const text = await http(`${api}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OHMYBUG_API_KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }, once);
      let msg, body, raw;
      try {
        msg = rpcMessage(text);
        raw = msg.result?.content?.[0]?.text ?? "";
        body = msg.error || !raw.trimStart().startsWith("{") ? null : JSON.parse(raw);
      } catch (e) {
        // A garbled answer to a poll is read again; to the paid call it is no clear answer, and is not resent.
        if (once) throw new Refusal(`${name}: unreadable answer; not sent again. A hunt may have started: see https://ohmybug.ai/me`);
        log(`${name}: unreadable answer; retrying`);
        await sleep(Math.min(30_000, 2000 * 2 ** attempt));
        if (Date.now() >= deadline) throw new Deadline("timed out");
        continue;
      }
      if (msg.error) throw new Refusal(`${name}: ${msg.error.message}`);
      if (!body) throw new Refusal(`${name}: ${raw.slice(0, 300) || "empty answer"}`);
      if (!msg.result?.isError) return body;
      // An internal error may come after the hunt was created: a paid call retries only a rate limit.
      if (!TRANSIENT_TOOL.has(body.error) || (once && body.error !== "rate_limited")) {
        throw new Refusal(`${body.error ?? name}: ${body.message ?? raw.slice(0, 300)}`);
      }
      const wait = Math.min(60_000, 5000 * 2 ** attempt);
      log(`${body.error}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      if (Date.now() >= deadline) throw new Deadline("timed out");
    }
  }

  let started;
  try {
    let root;
    try { root = realpathSync(execGit(cwd, ["rev-parse", "--show-toplevel"]).toString().trim()); }
    catch { throw new Refusal("this folder is not inside a git repository"); }
    const gitBuf = (...a) => execGit(root, a), git = (...a) => gitBuf(...a).toString();
    const change = selectChange(opts, env, git, root);
    if (change.skipped.length) log(`left out ${change.skipped.length} untracked path(s): over ${MAX_UNTRACKED_BYTES} bytes, past the first ${MAX_UNTRACKED}, or not a file (${change.skipped.slice(0, 3).join(", ")})`);
    if (!change.diff.trim()) {
      if (change.skipped.length) throw new Refusal("the only changes are untracked paths this client leaves out");
      out(`Nothing to review: no changes against ${change.base}.`);
      return 0;
    }
    const diff = trimDiff(change.diff, log);
    if (Buffer.byteLength(diff) > MAX_BYTES) throw new Refusal(`the diff is ${Buffer.byteLength(diff)} bytes, over the ${MAX_BYTES} the service takes: review a smaller range with --base`);
    const read = fileReader(root, change, gitBuf);
    // The reviewers can ask for any file by path; without the list they cannot name a caller to ask for.
    let listing = change.all.join("\n");
    if (Buffer.byteLength(listing) > MAX_TREE) {
      listing = Buffer.from(listing).subarray(0, MAX_TREE).toString();
      listing = `${listing.slice(0, listing.lastIndexOf("\n"))}\n# (list cut at ${MAX_TREE} bytes)`;
    }
    const tree = { path: ".review-client/tree.txt", content: `# Every file path in this repository at the reviewed head, one per line. Sent by the review client; request any of them.\n${listing}\n` };
    const { files } = fitBody({ diff, files: [tree, ...pack(read, contextPaths(change.changed, change.all, git, change.rev), MAX_FILES - 1, MAX_BYTES - Buffer.byteLength(diff) - Buffer.byteLength(tree.content))] });
    log(`reviewing ${change.changed.length} changed file(s) against ${change.base}`);

    const meta = ciMeta(env, git);
    const sub = await tool("submit_review", { diff, files, ...(Object.keys(meta).length ? { meta } : {}) }, true);
    if (!sub.review_id) throw new Refusal(`submit_review answered without a review id: ${JSON.stringify(sub).slice(0, 300)}`);
    started = sub;
    log(`review ${sub.review_id} started${sub.recent_median_minutes ? `; recent ones took about ${sub.recent_median_minutes} min` : ""}`);
    if (sub.live_url) log(`live progress: ${sub.live_url}`);

    const answered = new Set();
    for (;;) {
      // The long poll ends before the request's own abort, which is the time left.
      // 15 s are kept for the get_findings that follows a finished wait.
      const waitS = Math.min(45, Math.floor((deadline - Date.now()) / 1000) - 15);
      if (waitS < 1) throw new Deadline("timed out");
      let r = await tool("wait_review", { review_id: sub.review_id, timeout_s: waitS });
      // A finished wait_review carries the attestation; the findings are get_findings'.
      if (r.status === "done" || r.status === "failed") r = await tool("get_findings", { review_id: sub.review_id });
      if (r.status === "done" || r.status === "failed") {
        const findings = (r.findings ?? []).filter((f) => f && typeof f === "object");
        const code = exitCodeFor({ ...r, findings });
        if (r.status === "failed") log(`the review failed: ${String(r.error ?? r.summary ?? "no reason given").slice(0, 300)}`);
        else if (findings.length) out(formatFindings(findings));
        else out("No bugs found.");
        if (code === 2 && r.status === "done") log("the review did not finish its protocol: this is not a clean result");
        if (r.billing) log(`billing: ${r.billing.charged_usd ? `$${r.billing.charged_usd}` : "nothing"} charged${r.billing.paid_by ? ` (${r.billing.paid_by})` : ""}`);
        if (r.live_url) out(`\nReport: ${r.live_url}`);
        out(code === 1 ? `\n${findings.filter(isBlocking).length} blocking bug(s): medium or worse.` : code === 0 ? "\nNo blocking bugs." : "");
        return code;
      }
      if (r.status === "needs_files" && r.files_url && !answered.has(r.files_url)) {
        const sent = pack(read, (r.requested_files ?? []).slice(0, 200), MAX_EXTRA, MAX_BYTES);
        log(`the reviewers asked for ${(r.requested_files ?? []).length} file(s); sending ${sent.length}`);
        try { await http(r.files_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fitBody({ files: sent })) }); }
        catch (e) { if (!(e instanceof Refusal)) throw e; log(`the file answer was refused (${e.message}); continuing`); }
        answered.add(r.files_url);
        continue;
      }
      if (Date.now() >= deadline) throw new Deadline("timed out");
      if (!r.timed_out) await sleep(5000);
    }
  } catch (e) {
    if (e instanceof Refusal) log(`could not review: ${e.message}`);
    else if (e instanceof Deadline) log(`could not review: no result within OHMYBUG_TIMEOUT_S (${timeoutS}s)`);
    else log(`could not review: ${e.message ?? e}`);
    if (started) log(`review ${started.review_id} may still be running${started.live_url ? `: ${started.live_url}` : ""}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }).then((code) => process.exit(code));
}
