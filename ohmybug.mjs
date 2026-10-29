#!/usr/bin/env node
// ohmybug: review the git diff of the current folder with the OhMyBug hosted bug hunt, from a CI job or a shell.
// One file, no dependencies, Node 18+. Exit 0: no medium or worse bug. 1: at least one. 2: the review could not run.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

Exit codes: 0 no medium or worse bug, 1 at least one, 2 the review could not run.`;

/** Severities a pipeline gates on: the ones OhMyBug bills as real bugs. */
export const BLOCKING = new Set(["critical", "high", "medium", "P0", "P1"]);
// Server caps: 30 files and about 10 MiB of diff and files per call; 20 files per answer to a file request.
const MAX_FILES = 30, MAX_EXTRA = 20, MAX_BYTES = 9 * 1024 * 1024, MAX_BODY = 11_500_000, MAX_FILE = 512 * 1024;
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
    else if (a.startsWith("--base=")) o.base = a.slice(7);
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

/** The change to review: { diff, changed, all, readHead } where readHead names what context files are read from. */
export function selectChange(opts, env, git) {
  if (opts.uncommitted) {
    let diff = git("diff", "HEAD", "--no-color", "--no-ext-diff");
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
    for (const p of untracked) diff += gitNoIndex(git, p);
    const changed = [...git("diff", "HEAD", "--name-only", "--diff-filter=d", "-z").split("\0").filter(Boolean), ...untracked];
    const all = [...git("ls-files", "-z").split("\0").filter(Boolean), ...untracked];
    return { diff, changed, all, rev: null, base: "HEAD" };
  }
  const base = resolveBase(opts, env, (ref) => { try { git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); return true; } catch { return false; } });
  try { git("rev-parse", "--verify", "--quiet", `${base}^{commit}`); }
  catch { throw new Refusal(`base ${base} is not a commit in this clone (fetch it, or pass --base)`); }
  const range = `${base}...HEAD`;
  const diff = git("diff", range, "--no-color", "--no-ext-diff");
  const changed = git("diff", range, "--name-only", "--diff-filter=d", "-z").split("\0").filter(Boolean);
  const all = git("ls-tree", "-r", "--name-only", "-z", "HEAD").split("\0").filter(Boolean);
  return { diff, changed, all, rev: "HEAD", base };
}

/** A new-file diff for an untracked path; `git diff --no-index` exits 1 when there is a difference, which is the point. */
function gitNoIndex(git, path) {
  try { return git("diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path); }
  catch (e) { if (e.status === 1 && e.stdout) return e.stdout.toString(); throw e; }
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

/** A repository file as text, or null: outside the repository, under .git, missing, binary, an LFS pointer, too big. */
function readRepoFile(root, path) {
  try {
    const abs = realpathSync(join(root, String(path).replace(/^\/+/, "")));
    if (!abs.startsWith(root + sep) || abs.slice(root.length + 1).split(sep)[0] === ".git") return null;
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return null;
    const text = buf.toString("utf8");
    return text.startsWith("version https://git-lfs.github.com/spec/") ? null : text;
  } catch { return null; }
}

function pack(root, paths, max, budget) {
  const files = [];
  for (const path of paths) {
    if (files.length >= max) break;
    const content = readRepoFile(root, path);
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
    try { out = git("grep", "-l", "-I", "-F", "-w", "-z", stem, ...(rev ? [rev] : [])); } catch { continue; } // exit 1: no match
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
  let branch = cut(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? env.CI_COMMIT_REF_NAME ?? env.BITBUCKET_BRANCH, 200);
  if (!branch) { try { branch = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { branch = ""; } }
  const title = cut(env.CI_MERGE_REQUEST_TITLE, 300), body = cut(env.CI_MERGE_REQUEST_DESCRIPTION, 8000);
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), ...(title ? { pr_title: title } : {}), ...(body ? { pr_body: body } : {}) };
}

/** 0, 1 or 2 for a finished review body. */
export function exitCodeFor(r) {
  if (r.status !== "done") return 2;
  const blocking = (r.findings ?? []).filter((f) => BLOCKING.has(String(f?.severity)));
  if (blocking.length) return 1;
  // A run that was cut short and found nothing is not a clean result: the gate cannot pass on it.
  return r.review_of_record === false ? 2 : 0;
}

export function formatFindings(findings) {
  const rank = { critical: 0, P0: 0, high: 1, P1: 1, medium: 2, low: 3 };
  return [...findings].sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4)).map((f) => {
    const where = f.line ? `${f.file}:${f.line}` : String(f.file ?? "");
    const scenario = String(f.failure_scenario ?? "").trim().replace(/\n/g, "\n    ");
    return `${String(f.severity ?? "unrated").toUpperCase()}  ${where}  ${f.title ?? ""}`.trimEnd() + (scenario ? `\n    ${scenario}` : "");
  }).join("\n\n");
}

/** One review, start to end. Returns the exit code; never calls process.exit itself (the tests drive it). */
export async function run({ argv, env, cwd, out = (s) => process.stdout.write(s + "\n"), log = (s) => process.stderr.write(`ohmybug: ${s}\n`) }) {
  const opts = parseArgs(argv);
  if (typeof opts === "string") { log(opts); log("see ohmybug --help"); return 2; }
  if (opts.help) { out(USAGE); return 0; }
  if (opts.version) { out(VERSION); return 0; }
  if (!env.OHMYBUG_API_KEY) { log("OHMYBUG_API_KEY is not set: create a key at https://ohmybug.ai/me"); return 2; }
  const api = (env.OHMYBUG_URL || "https://mcp.ohmybug.ai").replace(/\/$/, "");
  const deadline = Date.now() + Number(env.OHMYBUG_TIMEOUT_S || 1800) * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))));
  const git = (...a) => execFileSync("git", ["-C", cwd, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();

  async function http(url, init) {
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Deadline("timed out");
      let why;
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(60_000, left)) });
        const text = await res.text();
        if (res.ok) return text;
        if (res.status === 401 || res.status === 403) throw new Refusal(`the API key was refused (HTTP ${res.status})`);
        if (res.status !== 429 && res.status < 500) throw new Refusal(`HTTP ${res.status} ${text.slice(0, 300)}`);
        why = `HTTP ${res.status}`;
      } catch (e) {
        if (e instanceof Refusal) throw e;
        why = e.cause?.code ?? e.message;
      }
      const wait = Math.min(30_000, 2000 * 2 ** attempt);
      log(`network: ${why}; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  let rpcId = 0;
  async function tool(name, args) {
    for (let attempt = 0; ; attempt++) {
      const text = await http(`${api}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OHMYBUG_API_KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      });
      const msg = JSON.parse(text);
      if (msg.error) throw new Refusal(`${name}: ${msg.error.message}`);
      const raw = msg.result?.content?.[0]?.text ?? "";
      if (!raw.trimStart().startsWith("{")) throw new Refusal(`${name}: ${raw.slice(0, 300) || "empty answer"}`);
      const body = JSON.parse(raw);
      if (!msg.result?.isError) return body;
      if (!TRANSIENT_TOOL.has(body.error)) throw new Refusal(`${body.error}: ${body.message}`);
      const wait = Math.min(60_000, 5000 * 2 ** attempt);
      log(`${body.error}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      if (Date.now() >= deadline) throw new Deadline("timed out");
    }
  }

  try {
    let root;
    try { root = realpathSync(git("rev-parse", "--show-toplevel").trim()); }
    catch { throw new Refusal("this folder is not inside a git repository"); }
    const rootGit = (...a) => execFileSync("git", ["-C", root, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const change = selectChange(opts, env, rootGit);
    if (!change.diff.trim()) { out(`Nothing to review: no changes against ${change.base}.`); return 0; }
    const diff = trimDiff(change.diff, log);
    // The reviewers can ask for any file by path; without the list they cannot name a caller to ask for.
    const tree = { path: ".review-client/tree.txt", content: `# Every file path in this repository at the reviewed head, one per line. Sent by the review client; request any of them.\n${change.all.join("\n")}\n` };
    const files = [tree, ...pack(root, contextPaths(change.changed, change.all, rootGit, change.rev), MAX_FILES - 1, MAX_BYTES - Buffer.byteLength(diff) - Buffer.byteLength(tree.content))];
    while (files.length > 1 && Buffer.byteLength(JSON.stringify({ diff, files })) > MAX_BODY) files.pop();
    log(`reviewing ${change.changed.length} changed file(s) against ${change.base}`);

    const meta = ciMeta(env, rootGit);
    const sub = await tool("submit_review", { diff, files, ...(Object.keys(meta).length ? { meta } : {}) });
    if (!sub.review_id) throw new Refusal(`submit_review answered without a review id: ${JSON.stringify(sub).slice(0, 300)}`);
    log(`review ${sub.review_id} started${sub.recent_median_minutes ? `; recent ones took about ${sub.recent_median_minutes} min` : ""}`);
    if (sub.live_url) log(`live progress: ${sub.live_url}`);

    const answered = new Set();
    for (;;) {
      let r = await tool("wait_review", { review_id: sub.review_id, timeout_s: Math.max(1, Math.min(45, Math.ceil((deadline - Date.now()) / 1000))) });
      // A finished wait_review carries the attestation; the findings are get_findings'.
      if (r.status === "done" || r.status === "failed") r = await tool("get_findings", { review_id: sub.review_id });
      if (r.status === "done" || r.status === "failed") {
        const findings = (r.findings ?? []).filter((f) => f && f.file);
        const code = exitCodeFor({ ...r, findings });
        if (r.status === "failed") log(`the review failed: ${String(r.error ?? r.summary ?? "no reason given").slice(0, 300)}`);
        else if (findings.length) out(formatFindings(findings));
        else out("No bugs found.");
        if (code === 2 && r.status === "done") log("the review did not finish its protocol: this is not a clean result");
        if (r.billing) log(`billing: ${r.billing.charged_usd ? `$${r.billing.charged_usd}` : "nothing"} charged${r.billing.paid_by ? ` (${r.billing.paid_by})` : ""}`);
        if (r.live_url) out(`\nReport: ${r.live_url}`);
        out(code === 1 ? `\n${findings.filter((f) => BLOCKING.has(String(f.severity))).length} blocking bug(s): medium or worse.` : code === 0 ? "\nNo blocking bugs." : "");
        return code;
      }
      if (r.status === "needs_files" && r.files_url && !answered.has(r.files_url)) {
        const sent = pack(root, (r.requested_files ?? []).slice(0, 200), MAX_EXTRA, MAX_BYTES);
        log(`the reviewers asked for ${(r.requested_files ?? []).length} file(s); sending ${sent.length}`);
        try { await http(r.files_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: sent }) }); }
        catch (e) { if (!(e instanceof Refusal)) throw e; log(`the file answer was refused (${e.message}); continuing`); }
        answered.add(r.files_url);
        continue;
      }
      if (Date.now() >= deadline) throw new Deadline("timed out");
      if (!r.timed_out) await sleep(5000);
    }
  } catch (e) {
    if (e instanceof Refusal) log(`could not review: ${e.message}`);
    else if (e instanceof Deadline) log(`could not review: no result within OHMYBUG_TIMEOUT_S`);
    else log(`could not review: ${e.message ?? e}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }).then((code) => process.exit(code));
}
