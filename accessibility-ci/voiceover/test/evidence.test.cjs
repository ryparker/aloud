const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const { SCENARIO, STEP_IDS, ASSERTION_IDS, GUIDE_VERSION, CAPTURE_POLICY, EvidenceError, ProductFailure,
  validateObservation, assessObservation, errorRecord, evaluateResult } = require("../evidence.cjs");
const { collectCommandCapture } = require("../capture.cjs");
const { config, buildDigest, verifyServedFiles, controlMetadata, replay } = require("../replay.cjs");

// These synthetic records exercise validator behavior only. They are not AT test results.
function syntheticEvidence() {
  const story = "http://127.0.0.1:8774/iframe.html?id=components-modal--test-teardown&viewMode=story";
  return { schemaVersion: 2, scenario: SCENARIO, mode: "real-at", story, runToken: "unit-test-only-token",
    fixture: { openerLabel: "Open modal" },
    environment: { platform: "darwin", guidepup: GUIDE_VERSION, voiceOver: "fixture-version", osVersion: "fixture-os",
      osBuild: "fixture-build", kernel: "fixture-kernel", arch: "arm64", node: "v24.19.0", locale: "en-US",
      profilePath: "/synthetic-test-profiles", profileDigest: "c".repeat(64), guidepupVoiceOverAssetVersion: "fixture-asset-version",
      settings: "test-profile", zoom: "not-tested",
      browser: { browserName: "Safari", browserVersion: "fixture-version" } },
    build: { revision: "a".repeat(40), sha256: "b".repeat(64), servedFilesVerified: true },
    steps: STEP_IDS.map(id => ({ id, source: "voiceover-guidepup-caption", startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: "2026-09-17T00:00:01.000Z", capture: { ...CAPTURE_POLICY, logCleared: true, itemLogCleared: true,
        commandCompleted: true, commandDurationMs: 1000 },
      speech: [id === "opener-sentinel" ? "Open modal link" : "Background content heading level 1"],
      itemText: id === "opener-sentinel" ? "Open modal link" : "Background content heading level 1",
      target: { url: story, runToken: "unit-test-only-token", fixtureReady: true, foregroundApp: "com.apple.Safari",
        modalOpen: id === "modal-open", backgroundPresent: true, backgroundHidden: id === "modal-open", authoredHidden: "true" } })),
    assertions: ASSERTION_IDS.map(id => ({ id, passed: true })), errors: [],
    cleanup: { voiceOver: "stopped", safariSession: "deleted", errors: [] } };
}

test("complete synthetic record satisfies the evidence contract, without executing AT", () => {
  assert.equal(evaluateResult(syntheticEvidence()).status, "passed");
});

test("positive requested-speech diagnostics cannot replace an empty activation capture", () => {
  const result = syntheticEvidence();
  result.steps[1].speech = [""];
  result.diagnostics = { purpose: "diagnostic-only", records: [{ label: "describe-focus", speech: ["Modal action button"] }] };
  assert.equal(evaluateResult(result).status, "inconclusive");
  assert.equal(evaluateResult(result).evidenceComplete, false);
});

for (const [name, speech] of [["empty", []], ["blank", [" "]], ["malformed", [{ text: "Background content" }]]]) {
  test(`${name} speech cannot pass even with a correct DOM and reader item`, () => {
    const result = syntheticEvidence();
    result.steps[2].speech = speech;
    assert.throws(() => validateObservation(result.steps[2], result), EvidenceError);
    assert.equal(evaluateResult(result).status, "inconclusive");
  });
}

for (const [name, mutation] of [
  ["wrong URL", step => { step.target.url = "http://127.0.0.1:8774/iframe.html?id=other&viewMode=story"; }],
  ["reloaded fixture", step => { step.target.runToken = "stale-token"; }],
  ["wrong foreground app", step => { step.target.foregroundApp = "com.apple.finder"; }],
  ["computed speech", step => { step.source = "computed-voiceover"; }],
  ["unfinished command", step => { step.capture.commandCompleted = false; }],
  ["fabricated settlement", step => { step.capture.settled = true; }],
  ["fabricated full delivery", step => { step.capture.completeSpeechCoverage = true; }],
  ["reversed capture window", step => { step.finishedAt = "2026-09-16T00:00:00.000Z"; }],
]) {
  test(`${name} prevents an evidence pass`, () => {
    const result = syntheticEvidence();
    mutation(result.steps[2]);
    assert.equal(evaluateResult(result).status, "inconclusive");
  });
}

test("right navigation item with unrelated spoken output cannot pass", () => {
  const result = syntheticEvidence();
  result.steps[2].speech = ["Safari toolbar"];
  assert.equal(evaluateResult(result).status, "inconclusive");
});

test("missing and duplicated required checkpoints cannot be hidden by a passing status", () => {
  for (const mutate of [r => r.steps.pop(), r => { r.steps[1] = structuredClone(r.steps[0]); }]) {
    const result = syntheticEvidence();
    result.status = "passed";
    mutate(result);
    assert.equal(evaluateResult(result).status, "inconclusive");
  }
});

test("stored passed flags cannot override contradictory observations or assertion identities", () => {
  for (const mutate of [r => { r.steps[2].target.backgroundHidden = true; },
    r => { r.assertions[5].id = r.assertions[0].id; }]) {
    const result = syntheticEvidence();
    mutate(result);
    assert.equal(evaluateResult(result).status, "inconclusive");
  }
});

test("observed open-state failure is a product failure independent of its stage", () => {
  const result = syntheticEvidence();
  result.errors.push(errorRecord(new ProductFailure("modal.opens-through-at", "Did not open"), "Open modal"));
  assert.equal(evaluateResult(result).status, "failed");
  assert.equal(result.errors[0].assertionId, "modal.opens-through-at");
});

test("cleanup failure prevents passing and retains a preexisting product failure", () => {
  const result = syntheticEvidence();
  result.cleanup.safariSession = "failed";
  result.cleanup.errors.push(errorRecord(new Error("WebDriver refused cleanup"), "Safari cleanup"));
  assert.equal(evaluateResult(result).status, "inconclusive");
  result.errors.push(errorRecord(new ProductFailure("teardown.heading-spoken", "Wrong announcement"), "Teardown"));
  assert.equal(evaluateResult(result).status, "failed");
  assert.equal(evaluateResult(result).evidenceComplete, false);
});

test("browser emulation, wrong versions and unverified builds cannot be treated as real AT evidence", () => {
  for (const mutate of [r => { r.mode = "preflight-only"; }, r => { r.environment.browser.browserName = "webkit"; },
    r => { r.environment.guidepup = "latest"; }, r => { r.build.servedFilesVerified = false; }, r => { r.build.revision = "main"; }]) {
    const result = syntheticEvidence();
    mutate(result);
    assert.equal(evaluateResult(result).status, "inconclusive");
  }
});

test("configuration refuses external targets and source-directory output", () => {
  const env = { USWDS_AT_BUILD_DIR: "/tmp/build", USWDS_AT_REVISION: "a".repeat(40),
    GUIDEPUP_SCREEN_READERS_PATH: "/tmp/profiles", USWDS_AT_OUTPUT_DIR: "/tmp/results" };
  assert.ok(config(env));
  assert.throws(() => config({ ...env, USWDS_AT_STORY: "https://example.com/" }), /loopback/);
  assert.throws(() => config({ ...env, USWDS_AT_OUTPUT_DIR: path.resolve(__dirname, "..", "results") }), /outside/);
  assert.throws(() => config({ ...env, USWDS_AT_REVISION: "develop" }), /full commit SHA/);
});

test("build digest changes when bytes change, regardless of file count", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-at-digest-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "iframe.html"), "known build");
  const first = await buildDigest(directory);
  await fs.writeFile(path.join(directory, "iframe.html"), "different build");
  assert.notEqual((await buildDigest(directory)).sha256, first.sha256);
  await fs.symlink(path.join(directory, "iframe.html"), path.join(directory, "linked.html"));
  await assert.rejects(buildDigest(directory), /symlink/);
});

test("served-resource verifier rejects another origin before making a request", async () => {
  await assert.rejects(verifyServedFiles({ story: "http://127.0.0.1:8774/", buildDir: "/tmp/build" },
    ["https://example.com/iframe.html"]), /external resource/);
});

test("an absent optional favicon records its 404 while required or supplied resources stay strict", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-at-resource-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const cfg = { story: `http://127.0.0.1:${server.address().port}/iframe.html`, buildDir: directory };
  assert.deepEqual(await verifyServedFiles(cfg, ["/favicon.ico"]),
    [{ pathname: "/favicon.ico", status: 404, optionalIconAbsent: true }]);
  await assert.rejects(verifyServedFiles(cfg, ["/required.js"]), /Resource fetch failed/);
  await fs.writeFile(path.join(directory, "favicon.ico"), "supplied build bytes");
  await assert.rejects(verifyServedFiles(cfg, ["/favicon.ico"]), /Resource fetch failed/);
});

test("hybrid control preserves runtime-only provenance and rejects unpinned overlays", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-at-control-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "control.json");
  const manifest = { name: "modal-base", tree: "core-modal-teardown", ref: "a".repeat(40), files: ["packages/usa-modal/src/index.js"] };
  await fs.writeFile(file, JSON.stringify(manifest));
  const record = await controlMetadata(file);
  assert.deepEqual(record.manifest, manifest);
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.match(record.interpretation, /only the listed runtime overrides/);
  await fs.writeFile(file, JSON.stringify({ ...manifest, ref: "develop" }));
  await assert.rejects(controlMetadata(file), /pinned runtime ref/);
});

test("real replay refuses to start without a dedicated-session acknowledgment", async () => {
  await assert.rejects(replay({ dedicatedSession: false }), /USWDS_AT_DEDICATED_SESSION=1/);
  await assert.rejects(replay({ dedicatedSession: "1" }), /USWDS_AT_DEDICATED_SESSION=1/);
});

test("missing run identity on both sides cannot match undefined to undefined", () => {
  const result = syntheticEvidence();
  delete result.runToken;
  for (const step of result.steps) delete step.target.runToken;
  assert.equal(evaluateResult(result).status, "inconclusive");
  assert.throws(() => validateObservation(result.steps[0], result), /run token is missing/);
});

test("passing evidence requires OS and profile provenance", () => {
  for (const field of ["osVersion", "osBuild", "profilePath", "profileDigest", "guidepupVoiceOverAssetVersion"]) {
    const result = syntheticEvidence();
    delete result.environment[field];
    assert.equal(evaluateResult(result).status, "inconclusive");
  }
});

test("command collection reads each cache once and never invents a live quiet period", async () => {
  const events = [];
  let speechCache = ["stale earlier speech"];
  let itemCache = "stale earlier item";
  const reader = {
    async clearSpokenPhraseLog() { events.push("clear-speech"); speechCache = []; },
    async clearItemTextLog() { events.push("clear-item"); itemCache = ""; },
    async spokenPhraseLog() { events.push("read-speech-cache"); return speechCache; },
    async itemText() { events.push("read-item-cache"); return itemCache; },
  };
  const collected = await collectCommandCapture(reader, async () => {
    events.push("native-command");
    await new Promise(resolve => setTimeout(resolve, 5));
    speechCache = ["command-processed phrase"];
    itemCache = "command-processed item";
    // Actual native commands return void, not a Capture object.
  });
  assert.deepEqual(events, ["clear-speech", "clear-item", "native-command", "read-speech-cache", "read-item-cache"]);
  assert.deepEqual(collected.speech, ["command-processed phrase"]);
  assert.equal(collected.capture.commandCompleted, true);
  assert.equal(collected.capture.terminationReason, "not-exposed");
  assert.equal(collected.capture.speechCoverage, "partial");
  assert.ok(collected.capture.commandDurationMs >= 0);
  assert.equal(Object.hasOwn(collected.capture, "settled"), false);
  assert.equal(Object.hasOwn(collected.capture, "maxWaitMs"), false);
});

for (const [id, mutate, assertionId] of [
  ["modal-open", target => { target.modalOpen = false; }, "modal.opens-through-at"],
  ["background-restored", target => { target.backgroundHidden = true; }, "teardown.restores-background"],
  ["background-restored", target => { target.authoredHidden = null; }, "teardown.preserves-authored-hidden"],
]) {
  test(`${assertionId} remains a product failure when speech is missing`, () => {
    const result = syntheticEvidence();
    const step = result.steps.find(item => item.id === id);
    step.speech = [];
    mutate(step.target);
    const assessment = assessObservation(step, result);
    assert.ok(assessment.errors.some(error => error.kind === "product" && error.assertionId === assertionId));
    assert.ok(assessment.errors.some(error => error.kind === "infrastructure" && /speech/.test(error.message)));
    result.errors.push(...assessment.errors);
    const evaluated = evaluateResult(result);
    assert.equal(evaluated.status, "failed");
    assert.equal(evaluated.evidenceComplete, false);
  });
}

test("wrong target plus bad DOM state remains inconclusive without manufacturing a product defect", () => {
  const result = syntheticEvidence();
  const step = result.steps[1];
  step.target.runToken = "another-session";
  step.target.modalOpen = false;
  step.speech = [];
  const assessment = assessObservation(step, result);
  assert.equal(assessment.assertions.length, 0);
  assert.ok(assessment.errors.every(error => error.kind === "infrastructure"));
  result.errors.push(...assessment.errors);
  assert.equal(evaluateResult(result).status, "inconclusive");
});

test("valid DOM state and absent speech stays inconclusive", () => {
  const result = syntheticEvidence();
  const step = result.steps[2];
  step.speech = [];
  const assessment = assessObservation(step, result);
  assert.ok(assessment.assertions.every(assertion => assertion.passed));
  assert.ok(assessment.errors.every(error => error.kind === "infrastructure"));
  result.errors.push(...assessment.errors);
  assert.equal(evaluateResult(result).status, "inconclusive");
});
