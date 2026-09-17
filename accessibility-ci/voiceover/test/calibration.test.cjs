const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { SCENARIO, STEP_IDS, ASSERTION_IDS, GUIDE_VERSION, CAPTURE_POLICY, evaluateResult } = require("../evidence.cjs");
const { buildDigest } = require("../replay.cjs");
const { SOURCE_REVISION, CONTROL_REVISION, RUNTIME_FILES } = require("../../fixtures/produce.cjs");
const { EXPECTED_DEFECT, evaluateCalibration, readArtifact, staticFilePath, startStaticServer } = require("../calibrate.cjs");

// Synthetic records verify the controller's decisions; these tests never execute AT.
function attempt(variant = "corrected") {
  const runToken = randomUUID();
  const story = "http://127.0.0.1:8774/iframe.html?id=components-modal--test-teardown&viewMode=story";
  const record = { variant, exitCode: variant === "broken" ? 1 : 0, signal: null, timedOut: false,
    sourceRevision: "a".repeat(40), buildSha256: (variant === "broken" ? "d" : "b").repeat(64), controlSha256: variant === "broken" ? "e".repeat(64) : null };
  const result = { schemaVersion: 2, scenario: SCENARIO, mode: "real-at", story, runToken,
    fixture: { openerLabel: "Open modal" },
    environment: { platform: "darwin", guidepup: GUIDE_VERSION, voiceOver: "fixture-version", osVersion: "fixture-os",
      osBuild: "fixture-build", kernel: "fixture-kernel", arch: "x64", node: "v24.19.0", locale: "en-US",
      profilePath: "/synthetic-test-profiles", profileDigest: "c".repeat(64), guidepupVoiceOverAssetVersion: "fixture-asset-version",
      settings: "test-profile", zoom: "not-tested", browser: { browserName: "Safari", browserVersion: "fixture-version" } },
    build: { revision: record.sourceRevision, sha256: record.buildSha256, servedFilesVerified: true },
    steps: STEP_IDS.map(id => ({ id, source: "voiceover-guidepup-caption", startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: "2026-09-17T00:00:01.000Z", capture: { ...CAPTURE_POLICY, logCleared: true, itemLogCleared: true,
        commandCompleted: true, commandDurationMs: 1000 },
      speech: [id === "opener-sentinel" ? "Open modal link" : "Background content heading level 1"],
      itemText: id === "opener-sentinel" ? "Open modal link" : "Background content heading level 1",
      target: { url: story, runToken, fixtureReady: true, foregroundApp: "com.apple.Safari",
        modalOpen: id === "modal-open", backgroundPresent: true, backgroundHidden: id === "modal-open", authoredHidden: "true" } })),
    assertions: ASSERTION_IDS.map(id => ({ id, passed: true })), errors: [],
    actions: [{ kind: "fixture-lifecycle-js", completed: true }],
    cleanup: { voiceOver: "stopped", safariSession: "deleted", errors: [], finalState: { voiceOverRunning: false, profileMounted: false } } };
  if (variant === "broken") {
    result.build.control = { sha256: record.controlSha256 };
    result.steps[2].target.backgroundHidden = true;
    result.steps[2].speech = ["No previous heading"];
    result.steps[2].itemText = "Previous page action button";
    result.assertions = result.assertions.slice(0, 4);
    result.assertions[2].passed = false;
    result.errors.push({ kind: "product", assertionId: EXPECTED_DEFECT, message: "Teardown left background missing or hidden" });
  }
  Object.assign(result, evaluateResult(result));
  record.result = result;
  return record;
}

function pair() { return [attempt(), attempt("broken")]; }

test("valid intended failure calibrates but two runs cannot count as ten corrected passes", () => {
  const records = pair();
  assert.equal(records[1].result.evidenceComplete, false);
  const evaluated = evaluateCalibration(records);
  assert.equal(evaluated.calibrationValid, true);
  assert.equal(evaluated.status, "incomplete");
  assert.equal(evaluated.correctedPassed, 1);
  assert.deepEqual(evaluated.problems, []);
});

test("one broken control plus ten independent corrected passes completes the sample", () => {
  const records = [...pair(), ...Array.from({ length: 9 }, () => attempt())];
  assert.equal(evaluateCalibration(records).status, "passed");
  assert.equal(evaluateCalibration(records).correctedPassed, 10);
  assert.equal(evaluateCalibration([...records, attempt()]).status, "failed");
});

for (const [name, mutate] of [
  ["wrong product defect", r => { r.result.errors[0].assertionId = "teardown.preserves-authored-hidden"; }],
  ["infrastructure error", r => { r.result.errors.push({ kind: "infrastructure", message: "Driver failed" }); }],
  ["missing final speech", r => { r.result.steps[2].speech = []; }],
  ["missing opener speech", r => { r.result.steps[0].speech = []; }],
  ["wrong run identity", r => { r.result.steps[2].target.runToken = "other-session"; }],
  ["simulated reader", r => { r.result.steps[0].source = "virtual-screen-reader"; }],
  ["missing teardown action", r => { r.result.actions = []; }],
  ["missing expected DOM defect", r => { r.result.steps[2].target.backgroundHidden = false; }],
  ["unrelated missing background", r => { r.result.steps[2].target.backgroundPresent = false; }],
  ["wrong overlay identity", r => { r.result.build.control.sha256 = "f".repeat(64); }],
  ["cleanup failure", r => { r.result.cleanup.finalState.voiceOverRunning = true; }],
  ["wrong exit code", r => { r.exitCode = 0; }],
  ["timeout", r => { r.timedOut = true; }],
  ["missing result", r => { delete r.result; }],
  ["malformed result", r => { r.result.environment.browser.browserName = {}; }],
]) {
  test(`${name} cannot establish broken-control calibration`, () => {
    const records = pair();
    mutate(records[1]);
    const evaluated = evaluateCalibration(records);
    assert.equal(evaluated.calibrationValid, false);
    assert.equal(evaluated.status, "failed");
    assert.ok(evaluated.problems.length > 0);
  });
}

test("corrected nonpass is retained; later passes never erase it", () => {
  const records = [...pair(), ...Array.from({ length: 9 }, () => attempt())];
  records[4].result.status = "inconclusive";
  records[4].exitCode = 1;
  const evaluated = evaluateCalibration(records);
  assert.equal(evaluated.status, "failed");
  assert.equal(evaluated.correctedPassed, 9);
});

test("a forged corrected passed flag cannot override its missing evidence", () => {
  const records = pair();
  records[0].result.steps.pop();
  assert.equal(evaluateCalibration(records).calibrationValid, false);
});

test("missing records, unexpected order and duplicated sessions remain nonpassing", () => {
  assert.equal(evaluateCalibration([]).status, "incomplete");
  assert.equal(evaluateCalibration([null]).status, "failed");
  assert.equal(evaluateCalibration([attempt("broken"), attempt()]).status, "failed");
  const records = pair();
  records.push(structuredClone(records[0]));
  assert.match(evaluateCalibration(records).problems.join("\n"), /Reused/);
});

test("repeat artifact substitution cannot count toward the same sample", () => {
  const records = [...pair(), attempt()];
  records[2].sourceRevision = "f".repeat(40);
  records[2].result.build.revision = records[2].sourceRevision;
  assert.match(evaluateCalibration(records).problems.join("\n"), /Artifact identity changed/);
});

test("static path mapping rejects traversal, backslash, null bytes and malformed escapes", () => {
  assert.equal(staticFilePath("/tmp/fixture", "/assets/test.js?cache=1"), "/tmp/fixture/assets/test.js");
  assert.equal(staticFilePath("/tmp/fixture", "/"), "/tmp/fixture/index.html");
  for (const target of ["/../secret", "/%2e%2e/secret", "/a/%2e%2e/secret", "/%5csecret", "/%00", "/%zz", "https://other.test/a"]) {
    assert.throws(() => staticFilePath("/tmp/fixture", target));
  }
});

test("loopback server serves exact JS bytes and refuses links outside its fixture", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-calibration-server-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const site = path.join(root, "site");
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, "fixture.js"), "window.fixture = true;\n");
  await fs.writeFile(path.join(root, "secret.txt"), "outside");
  await fs.symlink(path.join(root, "secret.txt"), path.join(site, "linked.txt"));
  const server = await startStaticServer(site);
  t.after(() => server.close());
  assert.equal(new URL(server.story).hostname, "127.0.0.1");
  const response = await fetch(new URL("/fixture.js", server.story));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "window.fixture = true;\n");
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(new URL("/linked.txt", server.story))).status, 404);
});

test("artifact validation binds downloaded bytes, source metadata and declared runtime overrides", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-calibration-artifact-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const site = path.join(root, "site");
  await fs.mkdir(site);
  await fs.writeFile(path.join(site, "iframe.html"), "fixture");
  await fs.writeFile(path.join(site, "index.json"), JSON.stringify({ entries: { "components-modal--test-teardown": {} } }));
  const hash = (await buildDigest(site)).sha256;
  const manifest = { schemaVersion: 1, kind: "clean-source-build", sourceRepository: "uswds/uswds", sourceRevision: SOURCE_REVISION, buildSha256: hash };
  const manifestPath = path.join(root, "build-provenance.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await readArtifact(root, hash, "corrected")).manifest.sourceRevision, manifest.sourceRevision);
  await assert.rejects(readArtifact(root, "f".repeat(64), "corrected"), /digest/);
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, sourceRevision: "main" }));
  await assert.rejects(readArtifact(root, hash, "corrected"), /source identity/);
  const control = { name: "modal-base", tree: "core-modal-teardown", ref: CONTROL_REVISION, files: RUNTIME_FILES };
  await fs.writeFile(path.join(root, "control.json"), JSON.stringify(control));
  const broken = { ...manifest, kind: "hybrid-runtime-control", runtimeOverrides: control.files.map(file => ({ path: file, sourceRevision: control.ref, sha256: "c".repeat(64), replacedSha256: "d".repeat(64) })) };
  await fs.writeFile(manifestPath, JSON.stringify(broken));
  assert.equal((await readArtifact(root, hash, "broken")).control.manifest.ref, control.ref);
  broken.runtimeOverrides[0].sourceRevision = "e".repeat(40);
  await fs.writeFile(manifestPath, JSON.stringify(broken));
  await assert.rejects(readArtifact(root, hash, "broken"), /override metadata/);
});


test("sparse arrays cannot turn missing repeats into ten corrected passes", () => {
  const records = pair();
  records.length = 11;
  const evaluated = evaluateCalibration(records);
  assert.equal(evaluated.status, "failed");
  assert.equal(evaluated.correctedPassed, 1);
});

test("reevaluation rejects mismatched source identities or identical control bytes", () => {
  for (const field of ["sourceRevision", "buildSha256"]) {
    const records = pair();
    records[1][field] = field === "sourceRevision" ? "f".repeat(40) : records[0].buildSha256;
    records[1].result.build[field === "sourceRevision" ? "revision" : "sha256"] = records[1][field];
    const evaluated = evaluateCalibration(records);
    assert.equal(evaluated.calibrationValid, false);
    assert.equal(evaluated.status, "failed");
  }
});
