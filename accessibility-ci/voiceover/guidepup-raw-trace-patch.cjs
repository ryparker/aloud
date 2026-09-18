const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { GUIDE_VERSION, sha256, requireEvidence } = require("./evidence.cjs");

const PATCH_ID = "guidepup-0.34.0-raw-native-read-trace-v1";
const RELATIVE_PATH = "lib/macOS/runAppleScript.js";
const ORIGINAL_SHA256 = "f0be9296047bcef8df10b82fe7f6b299f53cdc02166ba4f4ede87bcc70c8dd49";
const PATCHED_SHA256 = "fd8ae9a8c8b0662716c20eea305e881bddf59776835d2f7fccc292a5f0c91ab4";
const LIMITS = Object.freeze({ records: 2048, streamBytes: 8192, fileBytes: 16 * 1024 * 1024 });
const MANIFEST_FIELDS = Object.freeze({ schemaVersion: 1, id: PATCH_ID, packageName: "@guidepup/guidepup",
  packageVersion: GUIDE_VERSION, relativePath: RELATIVE_PATH, originalSha256: ORIGINAL_SHA256, patchedSha256: PATCHED_SHA256 });

// This function is injected as source into the pinned dependency. Keep it self-contained.
function uswdsTraceNative(script, started, error, stdout, stderr) {
    const kind = script.includes('tell application "VoiceOver"') &&
        (script.includes("return content of last phrase") ? "last-phrase" :
            script.includes("return text under cursor of vo cursor") ? "cursor-text" : null);
    if (!kind) return;
    const nativeFs = require("node:fs");
    const nativePath = require("node:path");
    const tracePath = process.env.USWDS_VO_NATIVE_TRACE;
    if (!nativePath.isAbsolute(tracePath || "")) throw new Error("Native read tracing requires absolute USWDS_VO_NATIVE_TRACE");
    let state = uswdsTraceNative.state;
    if (!state) {
        state = { path: tracePath, fd: nativeFs.openSync(tracePath, "wx", 0o600), count: 0, bytes: 0, lost: false };
        uswdsTraceNative.state = state;
    }
    if (state.path !== tracePath) throw new Error("Native trace path changed within one replay process");
    if (state.lost) throw new Error("Native trace already lost evidence");
    const ended = new Date();
    const encode = value => {
        if (value === undefined) return { type: "undefined" };
        if (value === null) return { type: "null" };
        const raw = Buffer.from(String(value), "utf8");
        const truncated = raw.length > 8192;
        return { type: typeof value, value: raw.subarray(0, 8192).toString("utf8"),
            byteLength: raw.length, truncated,
            ...(truncated ? { prefixBase64: raw.subarray(0, 8192).toString("base64") } : {}) };
    };
    const nativeError = error ? { name: encode(error.name), message: encode(error.message),
        code: encode(error.code), signal: encode(error.signal), killed: encode(error.killed) } : null;
    const record = { schemaVersion: 1, recordType: "native-read", sequence: state.count + 1, kind,
        startedAt: started.wall, finishedAt: ended.toISOString(),
        durationMs: Number(process.hrtime.bigint() - started.monotonic) / 1e6,
        stdout: encode(stdout), stderr: encode(stderr), error: nativeError };
    record.truncated = [record.stdout, record.stderr, ...Object.values(nativeError || {})].some(value => value.truncated === true);
    let line = JSON.stringify(record) + "\n";
    // Reserve space for the terminal loss marker within the total file limit.
    if (state.count >= 2048 || state.bytes + Buffer.byteLength(line) > 16 * 1024 * 1024 - 512) {
        line = JSON.stringify({ schemaVersion: 1, recordType: "trace-loss", sequence: state.count + 1,
            reason: state.count >= 2048 ? "record-limit" : "byte-limit", recordedAt: ended.toISOString(), truncated: true }) + "\n";
        state.lost = true;
    }
    const bytes = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
        const written = nativeFs.writeSync(state.fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error("Native trace write made no progress");
        offset += written;
    }
    state.bytes += bytes.length;
    state.count += 1;
    if (record.truncated || state.lost) {
        state.lost = true;
        throw new Error("Native trace evidence was truncated");
    }
}

function transformSource(source) {
  return source.replace('const debug = debug_1.base.extend("osascript");',
    `const debug = debug_1.base.extend("osascript");\n${uswdsTraceNative.toString()}`)
    .replace('    return (await new Promise((resolve, reject) => {',
      '    const uswdsTraceStarted = { wall: new Date().toISOString(), monotonic: process.hrtime.bigint() };\n    return (await new Promise((resolve, reject) => {')
    .replace('        }, (error, stdout) => {', `        }, (error, stdout, stderr) => {
            try { uswdsTraceNative(script, uswdsTraceStarted, error, stdout, stderr); }
            catch (traceError) {
                process.exitCode = 1;
                process.env.USWDS_VO_NATIVE_TRACE_ERROR ||= String(traceError.message || traceError).slice(0, 1024);
                console.error("USWDS_NATIVE_TRACE_ERROR:", traceError.message);
                return reject(error || traceError);
            }`);
}

function patchSource(source) {
  requireEvidence(sha256(source) === ORIGINAL_SHA256, "Guidepup AppleScript source does not match the pinned original bytes");
  const patched = transformSource(source);
  requireEvidence(sha256(patched) === PATCHED_SHA256, "Guidepup raw trace patch did not produce the reviewed bytes");
  return patched;
}

async function installedTarget(dependencyRoot) {
  requireEvidence(path.isAbsolute(dependencyRoot || ""), "Set absolute USWDS_AT_DEPENDENCY_ROOT");
  const load = createRequire(path.join(dependencyRoot, "package.json"));
  const packageFile = load.resolve("@guidepup/guidepup/package.json");
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  requireEvidence(pkg.name === MANIFEST_FIELDS.packageName && pkg.version === GUIDE_VERSION, "Raw trace patch requires Guidepup 0.34.0");
  const target = path.join(path.dirname(packageFile), RELATIVE_PATH);
  requireEvidence((await fs.lstat(target)).isFile(), "Raw trace patch target must be an ordinary file");
  return target;
}

async function applyPatch(dependencyRoot, manifestPath) {
  requireEvidence(path.isAbsolute(manifestPath || ""), "Set an absolute raw trace patch manifest path");
  const target = await installedTarget(dependencyRoot);
  const patched = patchSource(await fs.readFile(target, "utf8"));
  try { await fs.lstat(manifestPath); throw new Error("Raw trace patch manifest already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifest = { ...MANIFEST_FIELDS, appliedAt: new Date().toISOString(),
    change: "Record bounded raw native output for VoiceOver last phrase and cursor reads before trimming. Native command behavior and accessibility expectations remain unchanged.",
    status: "experimental-diagnostic-patch", upstreamRelease: false, limits: LIMITS };
  const temporary = `${target}.guidepup-raw-trace-patch.tmp`;
  await fs.writeFile(temporary, patched, { flag: "wx", mode: (await fs.stat(target)).mode });
  await fs.rename(temporary, target);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return verifyInstalledRawTrace(dependencyRoot, manifestPath);
}

async function verifyInstalledRawTrace(dependencyRoot, manifestPath = null) {
  const target = await installedTarget(dependencyRoot);
  const actualHash = sha256(await fs.readFile(target));
  if (!manifestPath) {
    requireEvidence(actualHash === ORIGINAL_SHA256, "Modified Guidepup native reads require the known raw trace patch manifest");
    return null;
  }
  requireEvidence(path.isAbsolute(manifestPath), "Raw trace patch manifest must be an absolute path");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  requireEvidence(Object.entries(MANIFEST_FIELDS).every(([key, value]) => manifest?.[key] === value) &&
    manifest?.status === "experimental-diagnostic-patch" && manifest?.upstreamRelease === false &&
    Number.isFinite(Date.parse(manifest?.appliedAt)) &&
    Object.entries(LIMITS).every(([key, value]) => manifest?.limits?.[key] === value),
  "Raw trace patch manifest does not match the reviewed patch");
  requireEvidence(actualHash === PATCHED_SHA256, "Installed Guidepup AppleScript bytes do not match the raw trace patch");
  return { ...manifest, manifestPath, manifestSha256: sha256(raw), verifiedTargetSha256: actualHash };
}

async function verifyTrace(tracePath) {
  requireEvidence(path.isAbsolute(tracePath || ""), "Native trace path must be absolute");
  const stat = await fs.lstat(tracePath);
  requireEvidence(stat.isFile() && stat.size > 0 && stat.size <= LIMITS.fileBytes,
    "Native trace must be a nonempty bounded ordinary file");
  const raw = await fs.readFile(tracePath, "utf8");
  requireEvidence(raw.endsWith("\n"), "Native trace has an incomplete final record");
  const lines = raw.slice(0, -1).split("\n");
  requireEvidence(lines.length <= LIMITS.records, "Native trace exceeded the record limit");
  const counts = { "last-phrase": 0, "cursor-text": 0 };
  let nativeErrorCount = 0;
  const validateValue = (value, stream = false) => {
    requireEvidence(value && typeof value === "object", "Native trace lacks a typed raw value");
    if (value.type === "undefined" || value.type === "null") return;
    requireEvidence(["string", ...(stream ? [] : ["number", "boolean"])].includes(value.type) &&
      typeof value.value === "string" && value.truncated === false &&
      value.byteLength === Buffer.byteLength(value.value) && value.byteLength <= LIMITS.streamBytes,
    "Native trace contains an invalid or truncated raw value");
  };
  for (let index = 0; index < lines.length; index += 1) {
    const record = JSON.parse(lines[index]);
    requireEvidence(record.schemaVersion === 1 && record.recordType === "native-read" &&
      record.sequence === index + 1 && Object.hasOwn(counts, record.kind) && record.truncated === false &&
      Number.isFinite(Date.parse(record.startedAt)) && Number.isFinite(Date.parse(record.finishedAt)) &&
      Number.isFinite(record.durationMs) && record.durationMs >= 0,
    "Native trace contains malformed, missing, or lost records");
    validateValue(record.stdout, true);
    validateValue(record.stderr, true);
    requireEvidence(record.error === null || (record.error && typeof record.error === "object"), "Native trace lacks native error status");
    if (record.error) {
      for (const key of ["name", "message", "code", "signal", "killed"]) validateValue(record.error[key]);
      nativeErrorCount += 1;
    }
    counts[record.kind] += 1;
  }
  return { schemaVersion: 1, status: "complete", path: tracePath, sha256: sha256(raw),
    bytes: Buffer.byteLength(raw), recordCount: lines.length, counts, nativeErrorCount, truncated: false };
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    requireEvidence(process.platform === "darwin" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Install this patch only on the disposable hosted macOS runner");
    requireEvidence(path.isAbsolute(process.env.CI_EVIDENCE || ""), "Set absolute CI_EVIDENCE");
    const args = process.argv.slice(2);
    requireEvidence(args.length === 4 && args[0] === "--dependency-root" && args[2] === "--manifest", "Expected --dependency-root ABSOLUTE_PATH --manifest ABSOLUTE_PATH");
    console.log(JSON.stringify(await applyPatch(args[1], args[3]), null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { PATCH_ID, RELATIVE_PATH, ORIGINAL_SHA256, PATCHED_SHA256, MANIFEST_FIELDS, LIMITS,
  patchSource, applyPatch, verifyInstalledRawTrace, verifyTrace };
