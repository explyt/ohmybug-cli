// Diff selection and exit codes, end to end: a throwaway git repository and a fake review server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciMeta, exitCodeFor, fitBody, parseArgs, resolveBase, rpcMessage, run, trimDiff } from "../ohmybug.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-cli-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "app.js"), "export const a = 1\n");
  git("add", ".");
  git("commit", "-qm", "base");
  // A CI clone has the target branch as a remote-tracking ref only.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("checkout", "-qb", "feature");
  return { dir, git };
}

/**
 * A review server that answers submit_review, wait_review and get_findings with `findings` and `status`. `requested`
 * makes the first wait_review a file request whose answer lands in `posted`; `sse` answers as an event stream;
 * `submitStatus` fails submit_review with that HTTP status; `toolError` answers every tool call with isError;
 * `faults` fails the first call of a tool: { wait_review: 503 | "reset" | "garble" }.
 */
async function server({ findings = [], status = "done", review_of_record = true, httpStatus = 200, requested, sse = false, submitStatus, toolError, faults = {} } = {}) {
  const calls = [], posted = [];
  let url;
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (httpStatus !== 200) { res.writeHead(httpStatus); return res.end("no"); }
      if (req.url === "/files") { posted.push(JSON.parse(body)); res.writeHead(200); return res.end("{}"); }
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      calls.push({ name, args, auth: req.headers.authorization });
      if (name === "submit_review" && submitStatus) { res.writeHead(submitStatus); return res.end("boom"); }
      const fault = faults[name];
      if (fault) {
        delete faults[name];
        if (fault === "reset") return req.socket.destroy();
        if (fault === "garble") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{\"jsonrpc\":"); }
        res.writeHead(fault); return res.end("busy");
      }
      const asked = name === "wait_review" && requested && !posted.length;
      const result = toolError ? toolError
        : name === "submit_review" ? { review_id: "rev_test", status: "running" }
        : asked ? { review_id: "rev_test", status: "needs_files", requested_files: requested, files_url: `${url}/files` }
        : name === "wait_review" ? { review_id: "rev_test", status }
        : { review_id: "rev_test", status, findings, review_of_record, live_url: "https://example.test/live/x" };
      const answer = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], ...(toolError ? { isError: true } : {}) } });
      res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
      res.end(sse ? `event: message\ndata: ${answer}\n\n` : answer);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
  return { url, calls, posted, close: () => new Promise((r) => srv.close(r)) };
}

async function cli(dir, argv, env) {
  const out = [], log = [];
  const code = await run({ argv, env: { OHMYBUG_API_KEY: "test-key", OHMYBUG_TIMEOUT_S: "20", ...env }, cwd: dir, out: (s) => out.push(s), log: (s) => log.push(s) });
  return { code, out: out.join("\n"), log: log.join("\n") };
}

const high = { severity: "high", file: "app.js", line: 1, title: "wrong constant", failure_scenario: "a is 2" };
const low = { severity: "low", file: "app.js", line: 1, title: "naming", failure_scenario: "a short name" };

test("parseArgs refuses unknown flags and --base with --uncommitted", () => {
  assert.equal(typeof parseArgs(["--nope"]), "string");
  assert.equal(typeof parseArgs(["--base"]), "string");
  assert.equal(typeof parseArgs(["--base", "x", "--uncommitted"]), "string");
  assert.deepEqual(parseArgs(["--base=dev"]), { base: "dev", uncommitted: false, help: false, version: false });
});

test("the base: --base, then the merge request target (remote-tracking when present), then origin/main", () => {
  const has = (refs) => (r) => refs.includes(r);
  assert.equal(resolveBase({ base: "v1" }, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "v1");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has(["origin/develop"])), "origin/develop");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "develop");
  assert.equal(resolveBase({}, {}, has([])), "origin/main");
});

test("exit codes: 1 on a medium or worse bug, 0 on lows or none, 2 on a failed or cut-short clean run", () => {
  assert.equal(exitCodeFor({ status: "done", findings: [high] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity: "medium" }] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [low] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [] }), 0);
  assert.equal(exitCodeFor({ status: "failed", findings: [] }), 2);
  assert.equal(exitCodeFor({ status: "done", findings: [], review_of_record: false }), 2);
  // A cut-short run that still found a real bug blocks: the bug is there.
  assert.equal(exitCodeFor({ status: "done", findings: [high], review_of_record: false }), 1);
  for (const severity of ["critical", "Critical", "HIGH", "P0", "P1", "P2", "p2"]) {
    assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity }] }), 1, severity);
  }
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity: "P3" }] }), 0);
  // A design-level bug with no file still blocks.
  assert.equal(exitCodeFor({ status: "done", findings: [{ severity: "high", title: "no file" }] }), 1);
});

test("parseArgs: an empty --base= is refused; OHMYBUG_TIMEOUT_S must be a number", async () => {
  assert.equal(typeof parseArgs(["--base="]), "string");
  const { dir } = repo();
  const r = await cli(dir, [], { OHMYBUG_TIMEOUT_S: "30m" });
  assert.equal(r.code, 2);
  assert.match(r.log, /OHMYBUG_TIMEOUT_S must be a number/);
});

test("ciMeta: an empty CI variable falls back to the next one", () => {
  const meta = ciMeta({ CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "", CI_COMMIT_REF_NAME: "feat" }, () => "local\n");
  assert.equal(meta.branch, "feat");
});

test("trimDiff drops per-file entries over 160 KiB from a diff over 2 MiB, unless nothing would be left", () => {
  const entry = (name, bytes) => `diff --git a/${name} b/${name}\n+${"x".repeat(bytes)}\n`;
  const small = entry("small.js", 10);
  const bigs = Array.from({ length: 14 }, (_, i) => entry(`big${i}.lock`, 170 * 1024)).join("");
  assert.equal(trimDiff(small + bigs), small);
  assert.equal(trimDiff(bigs), bigs);
  assert.equal(trimDiff(small), small);
});

test("an empty diff exits 0 without submitting", async () => {
  const { dir } = repo();
  const s = await server();
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    assert.match(r.out, /Nothing to review: no changes against origin\/main/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close() }
});

test("base...HEAD: the branch's committed change is sent, a blocking bug exits 1 and prints the finding", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  writeFileSync(join(dir, "app.js"), "export const a = 3 // uncommitted, not reviewed\n");
  const s = await server({ findings: [high, low] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1);
    const submit = s.calls.find((c) => c.name === "submit_review");
    assert.match(submit.args.diff, /\+export const a = 2/);
    assert.doesNotMatch(submit.args.diff, /uncommitted/);
    // Context files are the reviewed commit's, not the working tree's.
    assert.equal(submit.args.files[0].path, ".review-client/tree.txt");
    assert.equal(submit.args.files.find((f) => f.path === "app.js").content, "export const a = 2\n");
    assert.equal(submit.args.meta.branch, "feature");
    assert.equal(submit.args.meta.repo, undefined);
    assert.equal(s.calls[0].auth, "Bearer test-key");
    assert.match(r.out, /HIGH {2}app\.js:1 {2}wrong constant/);
    assert.match(r.out, /1 blocking bug/);
  } finally { await s.close() }
});

test("a file request is answered only with files of the reviewed commit: no ignored, untracked or .git path", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, "lib.js"), "export const l = 1\n");
  git("add", ".");
  git("commit", "-qm", "lib");
  writeFileSync(join(dir, "app.js"), "export const a = 9\n");
  git("commit", "-qam", "change");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "notes.txt"), "untracked\n");
  writeFileSync(join(dir, "lib.js"), "export const l = 2 // uncommitted\n");
  const requested = ["lib.js", "/app.js", ".env", "notes.txt", ".git/config", ".GIT/config", "../outside", "src/.git/config"];
  const s = await server({ requested });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    assert.equal(s.posted.length, 1);
    assert.deepEqual(s.posted[0].files, [{ path: "lib.js", content: "export const l = 1\n" }, { path: "/app.js", content: "export const a = 9\n" }]);
  } finally { await s.close() }
});

test("--uncommitted answers a file request from the working tree, untracked included, ignored not", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "new.js"), "export const n = 2\n");
  const s = await server({ requested: ["new.js", ".env", "app.js"] });
  try {
    assert.equal((await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url })).code, 0);
    assert.deepEqual(s.posted[0].files.map((f) => f.path), ["new.js", "app.js"]);
  } finally { await s.close() }
});

test("a changed file named like a git option is a search term, and its referrers are sent", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "user.js"), 'import x from "./-Oecho.js"\n');
  git("add", ".");
  git("commit", "-qm", "user");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "-Oecho.js"), "export default 1\n");
  git("add", "--", "-Oecho.js");
  git("commit", "-qm", "dash");
  const s = await server();
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 0);
    const paths = s.calls.find((c) => c.name === "submit_review").args.files.map((f) => f.path);
    assert.ok(paths.includes("-Oecho.js") && paths.includes("user.js"), paths.join(","));
  } finally { await s.close() }
});

test("an event-stream answer is read like a JSON one", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 10\n");
  git("commit", "-qam", "c");
  const s = await server({ sse: true, findings: [high] });
  try { assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 1); } finally { await s.close() }
  assert.throws(() => rpcMessage("event: ping\n\n"), /unreadable/);
});

test("submit_review is sent once: a 5xx answer does not start a second hunt", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 11\n");
  git("commit", "-qam", "c");
  const s = await server({ submitStatus: 502 });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.match(r.log, /HTTP 502/);
  } finally { await s.close() }
});

test("a tool error is reported with its code and message, without retrying", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 12\n");
  git("commit", "-qam", "c");
  const s = await server({ toolError: { error: "quota_exceeded" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /could not review: quota_exceeded: \{/);
    assert.equal(s.calls.length, 1);
  } finally { await s.close() }
});

test("the GitLab merge request target branch is the base, and its title is sent", async () => {
  const { dir, git } = repo();
  // develop moves on; main stays at the base: only the change against develop is reviewed.
  writeFileSync(join(dir, "dev.js"), "export const d = 1\n");
  git("add", ".");
  git("commit", "-qm", "on develop");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const a = 5\n");
  git("commit", "-qam", "feature change");
  const s = await server({ findings: [low] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop", CI_MERGE_REQUEST_TITLE: "Fix a" });
    assert.equal(r.code, 0);
    const submit = s.calls.find((c) => c.name === "submit_review");
    assert.match(submit.args.diff, /\+export const a = 5/);
    assert.doesNotMatch(submit.args.diff, /dev\.js/);
    assert.equal(submit.args.meta.pr_title, "Fix a");
  } finally { await s.close() }
});

test("--base picks the base by hand", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 6\n");
  git("commit", "-qam", "one");
  const one = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "b.js"), "export const b = 1\n");
  git("add", ".");
  git("commit", "-qm", "two");
  const s = await server();
  try {
    const r = await cli(dir, ["--base", one], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /b\.js/);
    assert.doesNotMatch(diff, /app\.js/);
  } finally { await s.close() }
});

test("--uncommitted reviews the working tree, untracked files included", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 7\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "new.js"), "export const n = 1\n");
  const s = await server();
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /\+export const a = 7/);
    assert.match(diff, /\+export const n = 1/);
  } finally { await s.close() }
});

test("could not run: no key, a refused key, a failed review, a base the clone lacks — all exit 2", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 8\n");
  git("commit", "-qam", "c");
  assert.equal((await cli(dir, [], { OHMYBUG_API_KEY: "" })).code, 2);
  const nope = await cli(dir, ["--base", "nope"], { OHMYBUG_URL: "http://127.0.0.1:9" });
  assert.equal(nope.code, 2);
  assert.match(nope.log, /base nope is not a commit in this clone \(fetch it, or check the ref\)/);
  for (const [opts, why] of [[{ httpStatus: 401 }, /API key was refused/], [{ status: "failed" }, /the review failed/], [{ review_of_record: false }, /did not finish its protocol/]]) {
    const s = await server(opts);
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, JSON.stringify(opts));
      assert.match(r.log, why);
    } finally { await s.close() }
  }
});

test("--uncommitted follows a symlink only to another file of the change, never to an ignored or outside file", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "app.js"), "export const a = 13\n");
  symlinkSync(".env", join(dir, "cfg"));
  symlinkSync("/etc/hosts", join(dir, "out"));
  symlinkSync("app.js", join(dir, "ok"));
  const s = await server({ requested: ["cfg", "out", "ok"] });
  try {
    assert.equal((await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url })).code, 0);
    assert.deepEqual(s.posted[0].files, [{ path: "ok", content: "export const a = 13\n" }]);
  } finally { await s.close() }
});

test("submit_review: a 429 is sent again and starts one hunt; a reset or an internal error is not sent again", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 14\n");
  git("commit", "-qam", "c");
  for (const [opts, code, submits] of [
    [{ faults: { submit_review: 429 } }, 0, 2],
    [{ faults: { submit_review: "reset" } }, 2, 1],
    [{ toolError: { error: "internal", message: "late failure" } }, 2, 1],
  ]) {
    const s = await server(opts);
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, code, JSON.stringify(opts) + r.log);
      assert.equal(s.calls.filter((c) => c.name === "submit_review").length, submits, JSON.stringify(opts));
      // The server counts what it received: one hunt, however many attempts reached it.
      if (code === 2) assert.match(r.log, /not sent again|late failure/);
    } finally { await s.close() }
  }
});

test("polling outlives a 5xx, a reset and a garbled answer", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 15\n");
  git("commit", "-qam", "c");
  for (const fault of [503, "reset", "garble"]) {
    const s = await server({ findings: [high], faults: { wait_review: fault } });
    try { assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "60" })).code, 1, String(fault)); } finally { await s.close() }
  }
});

test("a review still running at OHMYBUG_TIMEOUT_S exits 2 and names the review", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 16\n");
  git("commit", "-qam", "c");
  const s = await server({ status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "17" });
    assert.equal(r.code, 2);
    assert.match(r.log, /no result within OHMYBUG_TIMEOUT_S/);
    assert.match(r.log, /review rev_test may still be running/);
  } finally { await s.close() }
});

test("--uncommitted: a nested repository is skipped, a 200 KiB untracked file is reviewed, skipped-only changes exit 2", async () => {
  const { dir } = repo();
  mkdirSync(join(dir, "sub"));
  execFileSync("git", ["-C", join(dir, "sub"), "init", "-q"]);
  writeFileSync(join(dir, "sub", "x.js"), "1\n");
  const only = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: "http://127.0.0.1:9" });
  assert.equal(only.code, 2);
  assert.match(only.log, /only changes are untracked paths/);
  writeFileSync(join(dir, "big.js"), `export const big = "${"y".repeat(200 * 1024)}"\n`);
  const s = await server();
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    assert.match(s.calls.find((c) => c.name === "submit_review").args.diff, /\+export const big/);
    assert.match(r.log, /left out 1 untracked path/);
  } finally { await s.close() }
});

test("fitBody drops context files from the end until the escaped JSON fits, never the first", () => {
  const quotes = '"'.repeat(1000);
  const body = { diff: "d", files: [{ path: "tree", content: "t" }, { path: "a", content: quotes }, { path: "b", content: quotes }] };
  assert.deepEqual(fitBody(body, 2500).files.map((f) => f.path), ["tree", "a"]);
  assert.deepEqual(fitBody(body, 10).files.map((f) => f.path), ["tree"]);
  assert.equal(fitBody(body, 1e6).files.length, 3);
});
