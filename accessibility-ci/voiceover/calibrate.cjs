const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { SCENARIO, GUIDE_VERSION, STEP_IDS, validateObservation, evaluateResult, requireEvidence } = require("./evidence.cjs");
const { buildDigest, controlMetadata } = require("./replay.cjs");
const { SOURCE_REVISION, CONTROL_REVISION, RUNTIME_FILES } = require("../fixtures/produce.cjs");

const EXPECTED_DEFECT = "teardown.restores-background";
const timestamp = () => new Date().toISOString();

function brokenProblems(result) {
  const problems = [];
  const check = (value, message) => { if (!value) problems.push(message); };
  if (!result || typeof result !== "object") return ["Missing broken result"];
  check(result.schemaVersion === 2 && result.scenario === SCENARIO && result.mode === "real-at", "Wrong broken result identity");
  check(result.status === "failed", "Broken control did not fail");
  const env = result.environment;
  check(env?.platform === "darwin" && env?.guidepup === GUIDE_VERSION && env?.browser?.browserName?.toLowerCase() === "safari", "Broken control did not use pinned native AT and Safari");
  for (const field of ["voiceOver", "osVersion", "osBuild", "kernel", "arch", "node", "locale", "profilePath", "guidepupVoiceOverAssetVersion", "settings", "zoom"]) {
    check(typeof env?.[field] === "string" && env[field].trim().length > 0, `Broken environment ${field} missing`);
  }
  check(typeof env?.browser?.browserVersion === "string" && env.browser.browserVersion.length > 0, "Broken browser version missing");
  check(/^[a-f0-9]{64}$/.test(env?.profileDigest || ""), "Broken profile digest missing");
  check(/^[a-f0-9]{40}$/.test(result.build?.revision || "") && /^[a-f0-9]{64}$/.test(result.build?.sha256 || "") && result.build?.servedFilesVerified === true, "Broken build identity unverified");
  check(Array.isArray(result.steps) && result.steps.length === 3 && STEP_IDS.every((id, i) => result.steps[i]?.id === id), "Broken observations missing or reordered");
  for (const step of Array.isArray(result.steps) ? result.steps : []) {
    try { validateObservation(step, result); } catch (error) { problems.push(`Broken ${step?.id}: ${error.message}`); }
  }
  const [sentinel, opened, restored] = Array.isArray(result.steps) ? result.steps : [];
  const label = result.fixture?.openerLabel;
  check(typeof label === "string" && label.length > 0 && sentinel?.itemText?.includes(label) && sentinel?.speech?.some(value => typeof value === "string" && value.includes(label)), "Broken opener speech sentinel missing");
  check(opened?.target?.modalOpen === true && opened?.target?.backgroundHidden === true, "Broken modal never opened and isolated background");
  check(restored?.target?.backgroundPresent === true && restored?.target?.backgroundHidden === true && restored?.target?.authoredHidden === "true", "Broken snapshot does not establish the intended hidden-background defect");
  const expected = [["modal.opens-through-at", true], ["modal.isolates-background", true], [EXPECTED_DEFECT, false], ["teardown.preserves-authored-hidden", true]];
  check(Array.isArray(result.assertions) && result.assertions.length === expected.length && expected.every(([id, passed], i) => result.assertions[i]?.id === id && result.assertions[i]?.passed === passed), "Broken assertions differ from the intended defect");
  check(Array.isArray(result.actions) && result.actions.some(action => action.kind === "fixture-lifecycle-js" && action.completed === true), "Broken teardown action did not complete");
  check(Array.isArray(result.errors) && result.errors.length > 0 && result.errors.every(error => error.kind === "product" && error.assertionId === EXPECTED_DEFECT), "Broken control has a wrong defect or infrastructure error");
  check(result.cleanup?.voiceOver === "stopped" && result.cleanup?.safariSession === "deleted" && Array.isArray(result.cleanup?.errors) && result.cleanup.errors.length === 0 && result.cleanup?.finalState?.voiceOverRunning === false && result.cleanup.finalState.profileMounted === false, "Broken cleanup incomplete");
  return problems;
}

function attemptProblems(attempt) {
  if (!attempt || !["corrected", "broken"].includes(attempt.variant)) return ["Unknown or missing attempt"];
  const problems = [];
  if (attempt.error || attempt.timedOut || attempt.signal || !Number.isInteger(attempt.exitCode)) problems.push("Replay process did not complete normally");
  if (!attempt.result || typeof attempt.result !== "object") return [...problems, "Missing replay result"];
  const result = attempt.result;
  if (result.build?.revision !== attempt.sourceRevision || result.build?.sha256 !== attempt.buildSha256) problems.push("Replay result does not match its declared artifact");
  if (attempt.variant === "corrected") {
    try {
      const evaluated = evaluateResult(result);
      if (attempt.exitCode !== 0 || result.status !== "passed" || result.evidenceComplete !== true || evaluated.status !== "passed") problems.push("Corrected replay did not pass its evidence contract");
    } catch { problems.push("Malformed corrected replay result"); }
    if (result.build?.control) problems.push("Corrected replay unexpectedly used a runtime overlay");
    if (result.cleanup?.finalState?.voiceOverRunning !== false || result.cleanup?.finalState?.profileMounted !== false) problems.push("Corrected cleanup state missing or active");
  } else {
    if (attempt.exitCode !== 1) problems.push("Broken replay must exit with its expected failure code");
    if (!attempt.controlSha256 || result.build?.control?.sha256 !== attempt.controlSha256) problems.push("Broken runtime control identity differs from its artifact");
    try { problems.push(...brokenProblems(result)); } catch { problems.push("Malformed broken replay result"); }
  }
  return problems;
}

function evaluateCalibration(attempts) {
  const problems = [];
  if (!Array.isArray(attempts)) attempts = [];
  attempts = Array.from(attempts); // Sparse slots are missing attempts, never completed replays.
  const expected = ["corrected", "broken", ...Array(9).fill("corrected")];
  if (attempts.length > expected.length) problems.push("Unexpected extra attempts");
  const validations = attempts.map((attempt, index) => {
    const found = attemptProblems(attempt);
    const baseline = attempt?.variant === "broken" ? attempts[1] : attempts[0];
    if (baseline && (attempt?.sourceRevision !== baseline.sourceRevision || attempt?.buildSha256 !== baseline.buildSha256)) found.push("Artifact identity changed between attempts");
    if (attempt?.variant !== expected[index]) found.push("Unexpected attempt order");
    problems.push(...found.map(message => `Attempt ${index + 1}: ${message}`));
    return found.length === 0;
  });
  if (attempts.length >= 2) {
    if (attempts[0]?.sourceRevision !== attempts[1]?.sourceRevision) problems.push("Controls have different fixture source revisions");
    if (attempts[0]?.buildSha256 === attempts[1]?.buildSha256) problems.push("Controls have identical build bytes");
  }
  const tokens = attempts.map(attempt => attempt?.result?.runToken).filter(Boolean);
  if (new Set(tokens).size !== tokens.length) problems.push("Reused replay session identity");
  const calibrationValid = attempts.length >= 2 && validations[0] && validations[1] && tokens[0] !== tokens[1] &&
    attempts[0].sourceRevision === attempts[1].sourceRevision && attempts[0].buildSha256 !== attempts[1].buildSha256;
  if (!calibrationValid && attempts.length > 2) problems.push("Repeat runs occurred without valid calibration");
  const correctedPassed = attempts.filter((attempt, i) => attempt?.variant === "corrected" && validations[i]).length;
  return { schemaVersion: 1, status: problems.length ? "failed" : attempts.length === 11 && correctedPassed === 10 && calibrationValid ? "passed" : "incomplete",
    calibrationValid: Boolean(calibrationValid), correctedPassed,
    correctedExpected: 10, brokenExpected: 1, attemptCount: attempts.length, problems };
}

async function readArtifact(directory, expectedHash, variant) {
  requireEvidence(path.isAbsolute(directory || ""), `Set an absolute ${variant} artifact directory`);
  requireEvidence(/^[a-f0-9]{64}$/.test(expectedHash || ""), `Set the expected ${variant} directory digest`);
  requireEvidence((await fs.lstat(directory)).isDirectory(), "Artifact root must be a real directory");
  const site = path.join(directory, "site");
  requireEvidence((await fs.lstat(site)).isDirectory(), "Artifact site must be a real directory");
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "build-provenance.json"), "utf8"));
  requireEvidence(manifest.schemaVersion === 1 && manifest.kind === (variant === "broken" ? "hybrid-runtime-control" : "clean-source-build"), "Wrong artifact provenance kind");
  requireEvidence(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.sourceRepository || "") && /^[a-f0-9]{40}$/.test(manifest.sourceRevision || ""), "Artifact source identity missing");
  requireEvidence(manifest.sourceRepository === "uswds/uswds" && manifest.sourceRevision === SOURCE_REVISION, "Artifact does not match the pinned modal fixture source");
  requireEvidence(manifest.buildSha256 === expectedHash && (await buildDigest(site)).sha256 === expectedHash, "Artifact bytes differ from the expected digest");
  requireEvidence((await fs.stat(path.join(site, "iframe.html"))).isFile(), "Fixture iframe missing");
  const index = JSON.parse(await fs.readFile(path.join(site, "index.json"), "utf8"));
  requireEvidence(Boolean(index.entries?.["components-modal--test-teardown"]), "Dedicated modal fixture missing");
  const control = variant === "broken" ? await controlMetadata(path.join(directory, "control.json")) : null;
  if (control) {
    requireEvidence(control.manifest.ref === CONTROL_REVISION && control.manifest.name === "modal-base" && control.manifest.tree === "core-modal-teardown" &&
      control.manifest.files.length === RUNTIME_FILES.length && RUNTIME_FILES.every((file, i) => control.manifest.files[i] === file), "Broken control does not match the pinned runtime regression");
    const overrides = manifest.runtimeOverrides;
    requireEvidence(Array.isArray(overrides) && overrides.length === control.manifest.files.length &&
      new Set(control.manifest.files).size === control.manifest.files.length &&
      control.manifest.files.every(file => overrides.filter(item => item?.path === file).length === 1) &&
      overrides.every(item => item.sourceRevision === control.manifest.ref && /^[a-f0-9]{64}$/.test(item.sha256 || "") && /^[a-f0-9]{64}$/.test(item.replacedSha256 || "")),
    "Runtime override metadata does not match the broken control");
  } else {
    requireEvidence(manifest.runtimeOverrides === undefined || (Array.isArray(manifest.runtimeOverrides) && manifest.runtimeOverrides.length === 0), "Clean artifact declares runtime overrides");
  }
  return { directory, site, variant, manifest, control };
}

function staticFilePath(root, requestTarget) {
  const raw = requestTarget.split("?", 1)[0];
  const decoded = decodeURIComponent(raw);
  requireEvidence(decoded.startsWith("/") && !decoded.includes("\\") && !decoded.includes("\0") && !decoded.split("/").includes(".."), "Unsafe static resource path");
  const relative = decoded === "/" ? "index.html" : decoded.slice(1);
  const resolved = path.resolve(root, relative);
  requireEvidence(resolved.startsWith(`${path.resolve(root)}${path.sep}`), "Static resource leaves the fixture");
  return resolved;
}

async function startStaticServer(directory) {
  const root = await fs.realpath(directory);
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon" };
  const server = http.createServer(async (req, res) => {
    try {
      requireEvidence(req.method === "GET" || req.method === "HEAD", "Unsupported method");
      const file = staticFilePath(root, req.url);
      const real = await fs.realpath(file);
      requireEvidence(real.startsWith(`${root}${path.sep}`) && (await fs.stat(real)).isFile(), "Resource is not a fixture file");
      const bytes = await fs.readFile(real);
      res.writeHead(200, { "content-type": mime[path.extname(real)] || "application/octet-stream", "cache-control": "no-store", "content-length": bytes.length });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch { res.writeHead(404); res.end("Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { story: `http://127.0.0.1:${server.address().port}/iframe.html?id=components-modal--test-teardown&viewMode=story`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function executeAttempt(artifact, outputDir, ordinal, env) {
  const attemptDir = path.join(outputDir, `${String(ordinal).padStart(2, "0")}-${artifact.variant}`);
  await fs.mkdir(attemptDir);
  const replayDir = path.join(attemptDir, "replay");
  await fs.mkdir(replayDir);
  const attempt = { variant: artifact.variant, ordinal, startedAt: timestamp(), sourceRevision: artifact.manifest.sourceRevision,
    buildSha256: artifact.manifest.buildSha256, controlSha256: artifact.control?.sha256 || null,
    stdout: path.join(attemptDir, "stdout.log"), stderr: path.join(attemptDir, "stderr.log"), exitCode: null, signal: null, timedOut: false };
  let server;
  try {
    requireEvidence((await buildDigest(artifact.site)).sha256 === artifact.manifest.buildSha256, "Fixture bytes changed before replay");
    server = await startStaticServer(artifact.site);
    const childEnv = { ...env, USWDS_AT_BUILD_DIR: artifact.site, USWDS_AT_REVISION: artifact.manifest.sourceRevision,
      USWDS_AT_STORY: server.story, USWDS_AT_OUTPUT_DIR: replayDir };
    delete childEnv.USWDS_AT_CONTROL_MANIFEST;
    if (artifact.control) childEnv.USWDS_AT_CONTROL_MANIFEST = artifact.control.path;
    const stdout = await fs.open(attempt.stdout, "wx");
    let stderr;
    try {
      stderr = await fs.open(attempt.stderr, "wx");
      await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(__dirname, "replay.cjs")], { env: childEnv, stdio: ["ignore", stdout.fd, stderr.fd] });
        let killTimer;
        const timer = setTimeout(() => { attempt.timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5000); }, 120000);
        child.once("error", error => { attempt.error = error.message; });
        child.once("close", (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); attempt.exitCode = code; attempt.signal = signal; resolve(); });
      });
    } finally { await stdout.close(); if (stderr) await stderr.close(); }
    const paths = [];
    for (const entry of await fs.readdir(replayDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const candidate = path.join(replayDir, entry.name, "result.json");
        try { await fs.access(candidate); paths.push(candidate); } catch { /* Missing result stays nonpassing. */ }
      }
    }
    requireEvidence(paths.length === 1, "Replay did not produce exactly one result");
    attempt.resultPath = paths[0];
    attempt.result = JSON.parse(await fs.readFile(paths[0], "utf8"));
    requireEvidence((await buildDigest(artifact.site)).sha256 === artifact.manifest.buildSha256, "Fixture bytes changed during replay");
  } catch (error) { attempt.error = error.message; }
  finally { if (server) await server.close(); attempt.finishedAt = timestamp(); }
  await fs.writeFile(path.join(attemptDir, "attempt.json"), `${JSON.stringify(attempt, null, 2)}\n`, { flag: "wx" });
  return attempt;
}

async function main() {
  const env = process.env;
  let outputDir;
  const attempts = [];
  const summary = { startedAt: timestamp(), limitations: ["One regression scenario; ten corrected replays are a stability sample, not conformance evidence.", "Native VoiceOver caption evidence remains partial command capture."] };
  try {
    requireEvidence(path.isAbsolute(env.USWDS_AT_OUTPUT_DIR || ""), "Set absolute USWDS_AT_OUTPUT_DIR");
    outputDir = path.join(env.USWDS_AT_OUTPUT_DIR, `calibration-${Date.now()}-${randomUUID().slice(0, 8)}`);
    requireEvidence(!outputDir.startsWith(`${__dirname}${path.sep}`), "Calibration outputs must be outside source");
    await fs.mkdir(outputDir, { recursive: true });
    requireEvidence(process.platform === "darwin" && env.RUNNER_ENVIRONMENT === "github-hosted" && env.USWDS_AT_DEDICATED_SESSION === "1", "Calibration requires the prepared GitHub-hosted macOS desktop");
    const corrected = await readArtifact(env.USWDS_AT_CORRECTED_ARTIFACT, env.USWDS_AT_CORRECTED_SHA256, "corrected");
    const broken = await readArtifact(env.USWDS_AT_BROKEN_ARTIFACT, env.USWDS_AT_BROKEN_SHA256, "broken");
    requireEvidence(corrected.manifest.sourceRepository === broken.manifest.sourceRepository && corrected.manifest.sourceRevision === broken.manifest.sourceRevision, "Controls must share the fixture source identity");
    requireEvidence(corrected.manifest.buildSha256 !== broken.manifest.buildSha256, "Controls must contain different bytes");
    summary.artifacts = [corrected, broken].map(artifact => ({ variant: artifact.variant, manifest: artifact.manifest, control: artifact.control }));
    const save = async () => {
      Object.assign(summary, evaluateCalibration(attempts), { attempts, updatedAt: timestamp() });
      await fs.writeFile(path.join(outputDir, "calibration.json.tmp"), `${JSON.stringify(summary, null, 2)}\n`);
      await fs.rename(path.join(outputDir, "calibration.json.tmp"), path.join(outputDir, "calibration.json"));
    };
    await save();
    for (const artifact of [corrected, broken]) { attempts.push(await executeAttempt(artifact, outputDir, attempts.length + 1, env)); await save(); }
    if (evaluateCalibration(attempts).calibrationValid) {
      for (let index = 0; index < 9; index++) { attempts.push(await executeAttempt(corrected, outputDir, attempts.length + 1, env)); await save(); }
    }
    Object.assign(summary, evaluateCalibration(attempts));
    if (summary.status !== "passed") process.exitCode = 1;
  } catch (error) { summary.status = "failed"; summary.error = error.message; process.exitCode = 1; }
  finally {
    summary.finishedAt = timestamp();
    if (outputDir) await fs.writeFile(path.join(outputDir, "calibration.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ status: summary.status, calibrationValid: summary.calibrationValid || false,
      correctedPassed: summary.correctedPassed || 0, attempts: attempts.length, error: summary.error,
      problems: summary.problems, result: outputDir ? path.join(outputDir, "calibration.json") : null }, null, 2));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { EXPECTED_DEFECT, brokenProblems, attemptProblems, evaluateCalibration, readArtifact, staticFilePath, startStaticServer };
