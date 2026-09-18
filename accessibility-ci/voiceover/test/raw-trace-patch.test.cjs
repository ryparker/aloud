const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { sha256 } = require("../evidence.cjs");
const { ORIGINAL_SHA256, PATCHED_SHA256, RELATIVE_PATH, LIMITS, patchSource,
  applyPatch, verifyInstalledRawTrace, verifyTrace } = require("../guidepup-raw-trace-patch.cjs");

// Exact Guidepup 0.34.0 source is executed with a mocked native process, never actual VoiceOver.
const ORIGINAL_SOURCE = syncFs.readFileSync(path.join(__dirname, "fixtures/guidepup-runAppleScript-0.34.0.cjs"), "utf8");
const PHRASE_SCRIPT = 'tell application "VoiceOver"\nwith transaction\nreturn content of last phrase\nend transaction\nend tell';
const CURSOR_SCRIPT = 'tell application "VoiceOver"\nwith transaction\nreturn text under cursor of vo cursor\nend transaction\nend tell';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-raw-trace-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageDir = path.join(directory, "node_modules/@guidepup/guidepup");
  const target = path.join(packageDir, RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@guidepup/guidepup", version: "0.34.0" }));
  await fs.writeFile(target, ORIGINAL_SOURCE);
  return { directory, packageDir, target, manifest: path.join(directory, "patch.json"), trace: path.join(directory, "native.jsonl") };
}

function mocked(t, trace, results, overrideFs = {}) {
  const exports = {};
  const messages = [];
  const nativeCalls = [];
  const descriptors = [];
  const processMock = { env: { USWDS_VO_NATIVE_TRACE: trace }, hrtime: process.hrtime };
  const dependencies = {
    "../constants": { DEFAULT_TIMEOUT: 10000, DEFAULT_MAX_BUFFER: 1024 * 1024 },
    "../debug": { base: { extend: () => () => {} } },
    "node:path": path,
    "node:fs": { ...syncFs, openSync: (...args) => { const fd = syncFs.openSync(...args); descriptors.push(fd); return fd; }, ...overrideFs },
    child_process: { execFile(file, args, options, callback) {
      assert.equal(file, "/usr/bin/osascript");
      assert.deepEqual(Array.from(args), []);
      assert.equal(options.timeout, 1234);
      const result = results.shift();
      assert.ok(result, "Unexpected native command");
      return { pid: 12, stdin: { write: script => nativeCalls.push(script), end: () => queueMicrotask(() => callback(result.error || null, result.stdout, result.stderr)) } };
    } },
  };
  t.after(() => descriptors.forEach(fd => syncFs.closeSync(fd)));
  vm.runInNewContext(patchSource(ORIGINAL_SOURCE), { exports, Buffer, process: processMock,
    console: { error: (...args) => messages.push(args.join(" ")) }, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; } });
  return { run: script => exports.runAppleScript(script, { timeout: 1234 }), messages, nativeCalls, processMock };
}

async function records(trace) { return (await fs.readFile(trace, "utf8")).trimEnd().split("\n").map(JSON.parse); }

test("raw native trace distinguishes missing value, empty output, undefined, and whitespace before trimming", async t => {
  const f = await fixture(t);
  const raw = ["missing value\n", "", undefined, "  Dialog\n\t", null];
  const m = mocked(t, f.trace, raw.map(stdout => ({ stdout, stderr: "native diagnostic\n" })));
  const returns = [];
  for (let i = 0; i < raw.length; i += 1) returns.push(await m.run(i % 2 ? CURSOR_SCRIPT : PHRASE_SCRIPT));
  assert.deepEqual(returns, ["missing value", undefined, undefined, "Dialog", undefined]);
  const log = await records(f.trace);
  assert.deepEqual(log.map(row => row.stdout.type), ["string", "string", "undefined", "string", "null"]);
  assert.deepEqual(log.map(row => row.stdout.value), raw.map(value => value == null ? undefined : value));
  assert.ok(log.every(row => row.stderr.value === "native diagnostic\n" && row.durationMs >= 0));
  assert.ok(m.nativeCalls.every(script => script.startsWith("with timeout of 2 seconds\n")));
  const verified = await verifyTrace(f.trace);
  assert.equal(verified.recordCount, 5);
  assert.deepEqual(verified.counts, { "last-phrase": 3, "cursor-text": 2 });
  assert.equal(verified.nativeErrorCount, 0);
  assert.equal(sha256(ORIGINAL_SOURCE), ORIGINAL_SHA256);
  assert.equal(sha256(patchSource(ORIGINAL_SOURCE)), PATCHED_SHA256);
});

test("native error identity and raw stderr survive tracing; unrelated scripts are excluded", async t => {
  const f = await fixture(t);
  const error = Object.assign(new Error("AppleScript failed (-600)"), { code: 1, signal: null, killed: false });
  const m = mocked(t, f.trace, [{ error, stdout: "partial\n", stderr: "Application isn’t running. (-600)\n" }, { stdout: "unrelated secret\n" }]);
  await assert.rejects(m.run(PHRASE_SCRIPT), value => value === error);
  assert.equal(await m.run('tell application "Safari" to return name'), "unrelated secret");
  const [record] = await records(f.trace);
  assert.equal(record.error.message.value, error.message);
  assert.equal(record.error.code.value, "1");
  assert.equal(record.stderr.value, "Application isn’t running. (-600)\n");
  assert.equal(record.stdout.value, "partial\n");
  const verified = await verifyTrace(f.trace);
  assert.equal(verified.recordCount, 1);
  assert.equal(verified.nativeErrorCount, 1);
  assert.equal(m.processMock.exitCode, undefined);
});

test("missing trace path and preexisting trace fail visibly without accepting native success", async t => {
  const f = await fixture(t);
  const m = mocked(t, "", [{ stdout: "valid caption\n" }]);
  await assert.rejects(m.run(PHRASE_SCRIPT), /requires absolute/);
  assert.equal(m.processMock.exitCode, 1);
  assert.match(m.processMock.env.USWDS_VO_NATIVE_TRACE_ERROR, /requires absolute/);
  assert.match(m.messages[0], /^USWDS_NATIVE_TRACE_ERROR:/);
  await fs.writeFile(f.trace, "older evidence\n");
  const existing = mocked(t, f.trace, [{ stdout: "valid caption\n" }]);
  await assert.rejects(existing.run(PHRASE_SCRIPT), /EEXIST/);
  assert.equal(await fs.readFile(f.trace, "utf8"), "older evidence\n");
});

test("write errors fail visibly while preserving an existing native error", async t => {
  const f = await fixture(t);
  const nativeError = new Error("Native error remains the rejection");
  const m = mocked(t, f.trace, [{ error: nativeError, stdout: "", stderr: "native stderr" }], {
    writeSync: () => { throw new Error("Disk full"); },
  });
  await assert.rejects(m.run(PHRASE_SCRIPT), value => value === nativeError);
  assert.equal(m.processMock.exitCode, 1);
  assert.equal(m.processMock.env.USWDS_VO_NATIVE_TRACE_ERROR, "Disk full");
  assert.match(m.messages[0], /Disk full/);
  await assert.rejects(verifyTrace(f.trace), /nonempty bounded ordinary file/);
});

test("late logging failure remains sticky even when a later read succeeds and JSONL remains valid", async t => {
  const f = await fixture(t);
  let writes = 0;
  const m = mocked(t, f.trace, [{ stdout: "first\n" }, { stdout: "lost\n" }, { stdout: "third\n" }], {
    writeSync: (...args) => {
      writes += 1;
      if (writes === 2) throw new Error("Transient disk failure");
      return syncFs.writeSync(...args);
    },
  });
  assert.equal(await m.run(PHRASE_SCRIPT), "first");
  await assert.rejects(m.run(PHRASE_SCRIPT), /Transient disk failure/);
  assert.equal(await m.run(PHRASE_SCRIPT), "third");
  assert.equal((await verifyTrace(f.trace)).recordCount, 2);
  assert.equal(m.processMock.env.USWDS_VO_NATIVE_TRACE_ERROR, "Transient disk failure");
  assert.equal(m.processMock.exitCode, 1);
});

test("oversized streams record explicit truncation then reject; verifier rejects lost evidence", async t => {
  const f = await fixture(t);
  const m = mocked(t, f.trace, [{ stdout: "x".repeat(LIMITS.streamBytes + 1), stderr: "" }]);
  await assert.rejects(m.run(PHRASE_SCRIPT), /truncated/);
  const [record] = await records(f.trace);
  assert.equal(record.truncated, true);
  assert.equal(record.stdout.byteLength, LIMITS.streamBytes + 1);
  assert.equal(Buffer.from(record.stdout.prefixBase64, "base64").length, LIMITS.streamBytes);
  await assert.rejects(verifyTrace(f.trace), /malformed, missing, or lost/);
});

test("record limit writes a loss marker and makes subsequent native reads nonpassing", async t => {
  const f = await fixture(t);
  const m = mocked(t, f.trace, Array.from({ length: LIMITS.records + 2 }, () => ({ stdout: "caption\n", stderr: "" })));
  for (let i = 0; i < LIMITS.records; i += 1) await m.run(PHRASE_SCRIPT);
  await assert.rejects(m.run(PHRASE_SCRIPT), /truncated/);
  await assert.rejects(m.run(PHRASE_SCRIPT), /already lost evidence/);
  const log = await records(f.trace);
  assert.equal(log.length, LIMITS.records + 1);
  assert.equal(log.at(-1).recordType, "trace-loss");
  assert.equal(log.at(-1).reason, "record-limit");
  await assert.rejects(verifyTrace(f.trace), /exceeded the record limit/);
});

test("byte limit retains its loss marker within the total file bound", async t => {
  const f = await fixture(t);
  const m = mocked(t, f.trace, Array.from({ length: LIMITS.records }, () => ({
    stdout: "x".repeat(LIMITS.streamBytes), stderr: "y".repeat(LIMITS.streamBytes),
  })));
  let loss;
  for (let i = 0; i < LIMITS.records; i += 1) {
    try { await m.run(PHRASE_SCRIPT); } catch (error) { loss = error; break; }
  }
  assert.match(loss.message, /truncated/);
  assert.ok((await fs.stat(f.trace)).size <= LIMITS.fileBytes);
  const log = await records(f.trace);
  assert.equal(log.at(-1).reason, "byte-limit");
  await assert.rejects(verifyTrace(f.trace), /malformed, missing, or lost/);
});

test("trace verifier rejects dropped sequence numbers, partial writes, and altered byte counts", async t => {
  const f = await fixture(t);
  const m = mocked(t, f.trace, [{ stdout: "caption\n", stderr: "" }]);
  await m.run(PHRASE_SCRIPT);
  const raw = await fs.readFile(f.trace, "utf8");
  const record = JSON.parse(raw);
  await fs.writeFile(f.trace, raw.trimEnd());
  await assert.rejects(verifyTrace(f.trace), /incomplete final record/);
  await fs.writeFile(f.trace, JSON.stringify({ ...record, sequence: 2 }) + "\n");
  await assert.rejects(verifyTrace(f.trace), /malformed, missing, or lost/);
  await fs.writeFile(f.trace, JSON.stringify({ ...record, stdout: { ...record.stdout, byteLength: 100 } }) + "\n");
  await assert.rejects(verifyTrace(f.trace), /invalid or truncated raw value/);
});

test("patch and manifest reject original, installed, manifest, or package version tampering", async t => {
  const f = await fixture(t);
  assert.equal(await verifyInstalledRawTrace(f.directory), null);
  await fs.writeFile(f.target, ORIGINAL_SOURCE + "// changed");
  await assert.rejects(applyPatch(f.directory, f.manifest), /pinned original bytes/);
  await fs.writeFile(f.target, ORIGINAL_SOURCE);
  const record = await applyPatch(f.directory, f.manifest);
  assert.equal(record.verifiedTargetSha256, PATCHED_SHA256);
  assert.equal(record.upstreamRelease, false);
  await assert.rejects(verifyInstalledRawTrace(f.directory), /require the known/);
  const rawManifest = await fs.readFile(f.manifest, "utf8");
  await fs.writeFile(f.manifest, JSON.stringify({ ...JSON.parse(rawManifest), limits: { ...LIMITS, records: 999 } }));
  await assert.rejects(verifyInstalledRawTrace(f.directory, f.manifest), /does not match the reviewed/);
  await fs.writeFile(f.manifest, rawManifest);
  await fs.appendFile(f.target, "// changed");
  await assert.rejects(verifyInstalledRawTrace(f.directory, f.manifest), /bytes do not match/);
  await fs.writeFile(path.join(f.packageDir, "package.json"), JSON.stringify({ name: "@guidepup/guidepup", version: "0.35.0" }));
  await assert.rejects(verifyInstalledRawTrace(f.directory, f.manifest), /requires Guidepup/);
});
