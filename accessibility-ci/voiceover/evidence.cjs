const crypto = require("node:crypto");

const SCENARIO = "modal-teardown-background-v1";
const STEP_IDS = ["opener-sentinel", "modal-open", "background-restored"];
const GUIDE_VERSION = "0.34.0";
const CAPTURE_POLICY = Object.freeze({
  method: "guidepup-command-cache", captureMode: true,
  terminationReason: "not-exposed", speechCoverage: "partial",
  libraryPollIntervalMs: 50, libraryStablePollCount: 25, libraryMaxPollCount: 100,
  libraryApproxWordsPerSecond: 7.5,
});
const ASSERTION_IDS = ["modal.opens-through-at", "modal.isolates-background", "teardown.restores-background",
  "teardown.preserves-authored-hidden", "teardown.heading-reachable", "teardown.heading-spoken"];

class EvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvidenceError";
    this.kind = "infrastructure";
  }
}

class ProductFailure extends Error {
  constructor(assertionId, message) {
    super(message);
    this.name = "ProductFailure";
    this.kind = "product";
    this.assertionId = assertionId;
  }
}

function requireEvidence(condition, message) {
  if (!condition) throw new EvidenceError(message);
}

function productAssert(condition, assertionId, message) {
  if (!condition) throw new ProductFailure(assertionId, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameTarget(actual, expected) {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    return a.origin === b.origin && a.pathname === b.pathname &&
      a.searchParams.get("id") === b.searchParams.get("id") &&
      a.searchParams.get("viewMode") === b.searchParams.get("viewMode");
  } catch {
    return false;
  }
}

function validateTarget(observation, expected) {
  requireEvidence(observation && typeof observation === "object", "Missing observation");
  requireEvidence(STEP_IDS.includes(observation.id), "Unknown step identity");
  requireEvidence(observation.source === "voiceover-guidepup-caption", "Actual VoiceOver capture is required");
  requireEvidence(typeof expected.runToken === "string" && expected.runToken.trim().length > 0,
    "Required run token is missing");
  requireEvidence(typeof observation.target?.runToken === "string" && observation.target.runToken.trim().length > 0,
    "Observed run token is missing");
  requireEvidence(sameTarget(observation.target?.url, expected.story), "Browser navigated away from the required fixture");
  requireEvidence(observation.target?.runToken === expected.runToken, "Fixture session identity changed");
  requireEvidence(observation.target?.fixtureReady === true, "Fixture readiness was lost");
  requireEvidence(observation.target?.foregroundApp === "com.apple.Safari", "Safari is not the foreground application");
}

function validateObservation(observation, expected) {
  validateTarget(observation, expected);
  requireEvidence(Array.isArray(observation.speech) && observation.speech.length > 0 &&
    observation.speech.every(value => typeof value === "string") &&
    observation.speech.some(value => value.trim().length > 0), "Required step speech is missing or malformed");
  requireEvidence(typeof observation.itemText === "string" && observation.itemText.trim().length > 0,
    "VoiceOver navigation item is missing");
  requireEvidence(Number.isFinite(Date.parse(observation.startedAt)) &&
    Number.isFinite(Date.parse(observation.finishedAt)) &&
    Date.parse(observation.finishedAt) >= Date.parse(observation.startedAt), "Invalid capture time window");
  requireEvidence(observation.capture?.logCleared === true && observation.capture?.itemLogCleared === true &&
    observation.capture?.commandCompleted === true, "The command and current-command cache collection are incomplete");
  requireEvidence(Object.entries(CAPTURE_POLICY).every(([key, value]) => observation.capture?.[key] === value),
    "Required Guidepup capture policy or its limitations are missing");
  requireEvidence(!Object.hasOwn(observation.capture, "settled") && !Object.hasOwn(observation.capture, "completeSpeechCoverage"),
    "Guidepup does not expose verified speech settlement or complete delivery");
  requireEvidence(Number.isFinite(observation.capture.commandDurationMs) && observation.capture.commandDurationMs >= 0,
    "Observed command duration is missing");
}

function assessObservation(observation, expected) {
  const assertions = [];
  const errors = [];
  try { validateTarget(observation, expected); }
  catch (error) { return { assertions, errors: [errorRecord(error, observation?.id || "observation")] }; }
  const checkState = (condition, id, message) => {
    assertions.push({ id, passed: condition === true });
    if (!condition) errors.push(errorRecord(new ProductFailure(id, message), observation.id));
  };
  // Snapshot identity and explicit state can establish DOM defects even when speech is absent.
  // Do not infer an activation defect if the AT command itself never completed.
  if (observation.id === "modal-open" && observation.capture?.commandCompleted === true) {
    requireEvidence(typeof observation.target.modalOpen === "boolean" && typeof observation.target.backgroundHidden === "boolean",
      "Modal state observations are missing or malformed");
    checkState(observation.target.modalOpen, "modal.opens-through-at", "VoiceOver activation did not open the modal");
    checkState(observation.target.backgroundHidden, "modal.isolates-background", "Open modal failed to hide background content");
  } else if (observation.id === "background-restored") {
    requireEvidence(typeof observation.target.backgroundPresent === "boolean" && typeof observation.target.backgroundHidden === "boolean" &&
      (typeof observation.target.authoredHidden === "string" || observation.target.authoredHidden === null),
    "Teardown state observations are missing or malformed");
    checkState(observation.target.backgroundPresent && !observation.target.backgroundHidden,
      "teardown.restores-background", "Teardown left background missing or hidden");
    checkState(observation.target.authoredHidden === "true", "teardown.preserves-authored-hidden", "Teardown exposed authored hidden content");
  }
  try { validateObservation(observation, expected); }
  catch (error) { errors.push(errorRecord(error, observation.id)); }
  return { assertions, errors };
}

function errorRecord(error, stage) {
  return {
    kind: error.kind === "product" ? "product" : "infrastructure",
    stage,
    name: error.name,
    message: error.message,
    assertionId: error.assertionId || null,
    cause: error.cause?.message || null,
  };
}

function evaluateResult(result) {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  check(result.schemaVersion === 2 && result.scenario === SCENARIO, "Invalid result schema/scenario");
  check(result.mode === "real-at", "Only an actual AT execution can produce a passing replay");
  check(result.environment?.guidepup === GUIDE_VERSION, "Guidepup version is not pinned");
  check(result.environment?.platform === "darwin", "Expected macOS execution");
  check(result.environment?.browser?.browserName?.toLowerCase() === "safari", "Expected actual Safari WebDriver");
  check(typeof result.environment?.browser?.browserVersion === "string" && result.environment.browser.browserVersion.length > 0,
    "Browser version missing");
  check(typeof result.environment?.voiceOver === "string" && result.environment.voiceOver.length > 0, "VoiceOver version missing");
  for (const field of ["osVersion", "osBuild", "kernel", "arch", "node", "locale", "profilePath", "guidepupVoiceOverAssetVersion", "settings", "zoom"]) {
    check(typeof result.environment?.[field] === "string" && result.environment[field].trim().length > 0, `Environment ${field} missing`);
  }
  check(/^[a-f0-9]{64}$/.test(result.environment?.profileDigest || ""), "Profile digest missing");
  check(/^[a-f0-9]{40}$/.test(result.build?.revision || ""), "Source revision missing");
  check(/^[a-f0-9]{64}$/.test(result.build?.sha256 || ""), "Build digest missing");
  check(result.build?.servedFilesVerified === true, "Served build identity is unverified");
  check(Array.isArray(result.steps) && result.steps.length === STEP_IDS.length &&
    STEP_IDS.every((id, index) => result.steps[index]?.id === id), "Required steps are missing, duplicated or reordered");
  for (const step of result.steps || []) {
    try { validateObservation(step, result); } catch (error) { problems.push(`${step.id}: ${error.message}`); }
  }
  check(result.assertions?.length === ASSERTION_IDS.length &&
    ASSERTION_IDS.every((id, index) => result.assertions[index]?.id === id && result.assertions[index]?.passed === true),
  "Behavior assertions are incomplete or inconsistent");
  const [sentinel, opened, restored] = result.steps || [];
  check(typeof result.fixture?.openerLabel === "string" && result.fixture.openerLabel.length > 0 &&
    sentinel?.itemText?.includes(result.fixture.openerLabel) &&
    sentinel?.speech?.some(value => typeof value === "string" && value.includes(result.fixture.openerLabel)), "Opener capture sentinel is unverified");
  // Recheck the observed values: a stored passed flag is not proof.
  check(opened?.target?.modalOpen === true && opened?.target?.backgroundHidden === true,
    "Open-state observations contradict the passing assertions");
  check(restored?.target?.backgroundPresent === true && restored?.target?.backgroundHidden === false &&
    restored?.target?.authoredHidden === "true", "Teardown observations contradict the passing assertions");
  check(restored?.itemText?.includes("Background content") &&
    restored?.speech?.some(value => typeof value === "string" && value.includes("Background content")),
  "Background heading was not both reached and spoken");
  check(result.cleanup?.voiceOver === "stopped" && result.cleanup?.safariSession === "deleted", "Cleanup was incomplete");
  check((result.cleanup?.errors || []).length === 0, "Cleanup failed");
  check((result.errors || []).length === 0, "Execution errors were recorded");
  // Preserve observed product defects even if later capture or cleanup also fails.
  const productFailed = (result.errors || []).some(error => error.kind === "product");
  return {
    status: productFailed ? "failed" : problems.length ? "inconclusive" : "passed",
    evidenceComplete: problems.length === 0,
    speechCoverage: "partial-command-capture",
    problems,
  };
}

module.exports = { SCENARIO, STEP_IDS, ASSERTION_IDS, GUIDE_VERSION, CAPTURE_POLICY, EvidenceError, ProductFailure,
  requireEvidence, productAssert, sha256, sameTarget, validateTarget, validateObservation, assessObservation, errorRecord, evaluateResult };
