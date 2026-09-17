const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { SCENARIO, GUIDE_VERSION, CAPTURE_POLICY, requireEvidence, productAssert, sha256,
  assessObservation, errorRecord, evaluateResult } = require("./evidence.cjs");
const { collectCommandCapture } = require("./capture.cjs");
const { verifyInstalledStartup } = require("./guidepup-startup-patch.cjs");

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString();

function config(env = process.env) {
  const story = env.USWDS_AT_STORY || "http://127.0.0.1:8774/iframe.html?id=components-modal--test-teardown&viewMode=story";
  const driver = env.USWDS_SAFARI_DRIVER || "http://127.0.0.1:8773";
  for (const value of [story, driver]) {
    const url = new URL(value);
    requireEvidence(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
      "This pilot requires loopback HTTP fixture and driver URLs");
  }
  requireEvidence(new URL(story).pathname === "/iframe.html" &&
    new URL(story).searchParams.get("id") === "components-modal--test-teardown" &&
    new URL(story).searchParams.get("viewMode") === "story", "Expected the dedicated modal teardown story");
  requireEvidence(path.isAbsolute(env.USWDS_AT_BUILD_DIR || ""), "Set absolute USWDS_AT_BUILD_DIR to the served Storybook build");
  requireEvidence(/^[a-f0-9]{40}$/.test(env.USWDS_AT_REVISION || ""), "Set USWDS_AT_REVISION to the tested full commit SHA");
  requireEvidence(path.isAbsolute(env.GUIDEPUP_SCREEN_READERS_PATH || ""), "Set absolute GUIDEPUP_SCREEN_READERS_PATH to existing test profiles");
  requireEvidence(path.isAbsolute(env.USWDS_AT_OUTPUT_DIR || ""), "Set absolute USWDS_AT_OUTPUT_DIR outside this source directory");
  requireEvidence(!env.USWDS_GUIDEPUP_PATCH_MANIFEST || path.isAbsolute(env.USWDS_GUIDEPUP_PATCH_MANIFEST), "Startup patch manifest must be absolute");
  const outputDir = path.resolve(env.USWDS_AT_OUTPUT_DIR);
  requireEvidence(outputDir !== __dirname && !outputDir.startsWith(`${__dirname}${path.sep}`), "Run outputs must be outside the source directory");
  return { story, driver, buildDir: path.resolve(env.USWDS_AT_BUILD_DIR), revision: env.USWDS_AT_REVISION,
    assets: path.resolve(env.GUIDEPUP_SCREEN_READERS_PATH), outputDir,
    dedicatedSession: env.USWDS_AT_DEDICATED_SESSION === "1",
    patchManifest: env.USWDS_GUIDEPUP_PATCH_MANIFEST || null,
    controlManifest: env.USWDS_AT_CONTROL_MANIFEST ? path.resolve(env.USWDS_AT_CONTROL_MANIFEST) : null,
    dependencyRoot: env.USWDS_AT_DEPENDENCY_ROOT ? path.resolve(env.USWDS_AT_DEPENDENCY_ROOT) : __dirname };
}

async function command(file, args) {
  const { stdout } = await exec(file, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function runtimeState() {
  let voiceOverRunning = false;
  try { await command("/usr/bin/pgrep", ["-x", "VoiceOver"]); voiceOverRunning = true; }
  catch (error) { if (error.code !== 1) throw error; }
  const mounts = await command("/sbin/mount", []);
  return { voiceOverRunning, profileMounted: mounts.includes(" on /Volumes/GuidepupVoiceOverPreferences ("), checkedAt: timestamp() };
}

async function controlMetadata(file) {
  if (!file) return null;
  const raw = await fs.readFile(file, "utf8");
  const manifest = JSON.parse(raw);
  requireEvidence(/^[a-f0-9]{40}$/.test(manifest.ref || "") &&
    typeof manifest.tree === "string" && typeof manifest.name === "string" &&
    Array.isArray(manifest.files) && manifest.files.length > 0 &&
    manifest.files.every(value => typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split("/").includes("..")),
  "Control manifest needs a pinned runtime ref, fixture tree, name and repository-relative overridden files");
  return { path: file, sha256: sha256(raw), manifest,
    interpretation: "Hybrid control: USWDS_AT_REVISION identifies fixture source; manifest.ref identifies only the listed runtime overrides." };
}

async function request(url, method = "GET", body) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  requireEvidence(response.ok && !payload.value?.error, payload.value?.message || `WebDriver HTTP ${response.status}`);
  return payload.value;
}

async function buildDigest(directory) {
  const records = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      requireEvidence(!entry.isSymbolicLink(), `Build contains a symlink: ${path.relative(directory, file)}`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) records.push([path.relative(directory, file), sha256(await fs.readFile(file))]);
    }
  }
  await walk(directory);
  requireEvidence(records.length > 0, "Build directory is empty");
  return { sha256: sha256(JSON.stringify(records)), fileCount: records.length };
}

async function verifyServedFiles(cfg, urls) {
  const records = [];
  for (const value of [...new Set(urls)]) {
    const url = new URL(value, cfg.story);
    requireEvidence(url.origin === new URL(cfg.story).origin, `Unexpected external resource: ${url.origin}`);
    const file = path.resolve(cfg.buildDir, `.${decodeURIComponent(url.pathname)}`);
    requireEvidence(file.startsWith(`${cfg.buildDir}${path.sep}`), "Resource path leaves the build directory");
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    // Safari probes this optional icon even when the fixture declares none.
    // Record an absent file and matching 404; every supplied build file and
    // every other resource still requires a successful byte comparison.
    if (url.pathname === "/favicon.ico" && response.status === 404) {
      let absent = false;
      try { await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") absent = true; else throw error; }
      if (absent) {
        records.push({ pathname: url.pathname, status: 404, optionalIconAbsent: true });
        continue;
      }
    }
    requireEvidence(response.ok, `Resource fetch failed: ${url.pathname}`);
    const served = sha256(Buffer.from(await response.arrayBuffer()));
    requireEvidence(served === sha256(await fs.readFile(file)), `Served resource differs from declared build: ${url.pathname}`);
    records.push({ pathname: url.pathname, sha256: served });
  }
  return records;
}

async function preflight(cfg) {
  requireEvidence(process.platform === "darwin", "Actual replay requires macOS");
  const load = createRequire(path.join(cfg.dependencyRoot, "package.json"));
  const dependency = load("@guidepup/guidepup/package.json");
  requireEvidence(dependency.version === GUIDE_VERSION, `Expected Guidepup ${GUIDE_VERSION}, found ${dependency.version}`);
  const guidepupCompatibilityPatch = await verifyInstalledStartup(cfg.dependencyRoot, cfg.patchManifest);
  requireEvidence((await fs.stat(cfg.assets)).isDirectory(), "Guidepup profile directory is missing");
  const status = await request(`${cfg.driver}/status`);
  requireEvidence(status && status.ready !== false, "Safari driver is not ready for a new session");
  const build = await buildDigest(cfg.buildDir);
  const served = await verifyServedFiles(cfg, [cfg.story, new URL("/index.json", cfg.story).href]);
  const initialState = await runtimeState();
  requireEvidence(!initialState.voiceOverRunning, "VoiceOver is already running; use a dedicated test session with VoiceOver initially off");
  requireEvidence(!initialState.profileMounted, "A Guidepup profile volume is already mounted; resolve the existing test session first");
  return { ready: true, mode: "preflight-only", guidepup: dependency.version, guidepupCompatibilityPatch, platform: process.platform,
    osVersion: await command("/usr/bin/sw_vers", ["-productVersion"]), osBuild: await command("/usr/bin/sw_vers", ["-buildVersion"]),
    kernel: os.release(), arch: process.arch, node: process.version, driver: status, build, served, initialState,
    control: await controlMetadata(cfg.controlManifest),
    limitations: ["No Safari session was created. Remote automation permission and VoiceOver capture are not verified by preflight."] };
}

async function replay(cfg) {
  requireEvidence(cfg.dedicatedSession === true,
    "Real replay requires USWDS_AT_DEDICATED_SESSION=1 after an authorized dedicated test session is prepared; the flag is not user approval");
  // Separate unique run directory; never overwrite historical evidence.
  const runDir = path.join(cfg.outputDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(runDir, { recursive: true });
  const result = { schemaVersion: 2, scenario: SCENARIO, mode: "real-at", startedAt: timestamp(), story: cfg.story,
    runToken: randomUUID(), status: "inconclusive", steps: [], assertions: [], actions: [], errors: [],
    cleanup: { voiceOver: "not-started", safariSession: "not-created", errors: [] },
    limitations: ["One modal teardown regression; fixture setup and post-teardown positioning use explicit JavaScript assistance.",
      "Captures VoiceOver caption output through Guidepup, not microphone audio or proof of audible delivery.",
      "Guidepup command logs are cached, library-processed caption output. Poll exhaustion versus stable caption is not exposed; full speech coverage is unknown.",
      "Source SHA is operator-declared; build bytes are hashed and served document/resources checked, not a signed CI attestation.",
      "Pilot expectations await actual broken/fixed calibration; no complete AT traversal, initial-focus, duplicate-announcement or conformance claim.",
      "Dedicated-session acknowledgment is an operator assertion, not user permission; Guidepup portable-profile trust and symlinks may remain."] };
  let session;
  let voiceOver;
  let voiceOverStarted = false;
  let voiceOverStartAttempted = false;
  let stage = "preflight";
  const webdriver = (method, route, body) => request(`${cfg.driver}${route}`, method, body);
  const script = (source, args = []) => webdriver("POST", `/session/${session}/execute/sync`, { script: source, args });
  const recordAction = async (kind, description, action) => {
    const item = { kind, description, startedAt: timestamp() };
    result.actions.push(item);
    try { const value = await action(); item.completed = true; return value; }
    finally { item.finishedAt = timestamp(); }
  };
  const assertBehavior = (condition, id, message) => {
    result.assertions.push({ id, passed: condition === true });
    productAssert(condition === true, id, message);
  };
  const foreground = () => command("/usr/bin/osascript", ["-e", 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true']);
  const snapshot = async () => ({ ...await script(`return {
    url: location.href, runToken: window.__uswdsAtRunToken,
    fixtureReady: window.uswdsTest?.ready === true,
    focus: document.activeElement?.outerHTML,
    backgroundPresent: !!document.querySelector('#test-background'),
    backgroundHidden: !!document.querySelector('#test-background')?.closest('[aria-hidden="true"]'),
    authoredHidden: document.querySelector('#test-authored-hidden')?.getAttribute('aria-hidden'),
    modalOpen: !!document.querySelector('.usa-modal-wrapper.is-visible[aria-modal="true"]'),
    viewport: {width: innerWidth, height: innerHeight, devicePixelRatio}, language: document.documentElement.lang
  };`), foregroundApp: await foreground() });
  async function capture(id, action) {
    requireEvidence(await foreground() === "com.apple.Safari", "Safari lost foreground before screen-reader command");
    const observation = { id, source: "voiceover-guidepup-caption", startedAt: timestamp(),
      capture: { ...CAPTURE_POLICY, logCleared: false, itemLogCleared: false, commandCompleted: false }, speech: [] };
    result.steps.push(observation);
    try {
      Object.assign(observation, await collectCommandCapture(voiceOver,
        () => recordAction("assistive-technology", id, action)));
      observation.target = await snapshot();
      observation.finishedAt = timestamp();
      try {
        const screenshot = await webdriver("GET", `/session/${session}/screenshot`);
        const bytes = Buffer.from(screenshot, "base64");
        await fs.writeFile(path.join(runDir, `${id}.png`), bytes, { flag: "wx" });
        observation.screenshot = { file: `${id}.png`, sha256: sha256(bytes) };
      } catch (error) {
        // A diagnostic failure must not prevent classification of captured behavior.
        result.errors.push(errorRecord(error, `${id} screenshot`));
      }
      const assessed = assessObservation(observation, result);
      result.assertions.push(...assessed.assertions);
      // Keep every known DOM defect plus missing-speech diagnostics. Product failure
      // outranks incomplete evidence, while wrong identity never reaches DOM assertions.
      const primary = assessed.errors.find(error => error.kind === "product") || assessed.errors[0];
      result.errors.push(...assessed.errors.filter(error => error !== primary));
      if (primary) {
        const error = new Error(primary.message);
        Object.assign(error, primary);
        throw error;
      }
      return observation;
    } finally { observation.finishedAt ||= timestamp(); }
  }
  try {
    const info = await preflight(cfg);
    result.environment = { platform: info.platform, osVersion: info.osVersion, osBuild: info.osBuild,
      kernel: info.kernel, arch: info.arch, node: info.node, guidepup: info.guidepup,
      locale: Intl.DateTimeFormat().resolvedOptions().locale, profilePath: cfg.assets,
      profileDigest: (await buildDigest(cfg.assets)).sha256, activationMethod: "voiceover-keyboard-default-action", settings: "Guidepup pinned test profile; no runtime override",
      zoom: "not explicitly set or evaluated by this pilot", guidepupCompatibilityPatch: info.guidepupCompatibilityPatch };
    result.build = { ...info.build, revision: cfg.revision, source: "operator-declared SHA with local/HTTP byte checks", servedFilesVerified: false };
    if (info.control) {
      result.build.control = info.control;
      result.build.source = "hybrid control: declared fixture revision plus separately pinned runtime overlay";
      await fs.writeFile(path.join(runDir, "control-manifest.json"), `${JSON.stringify(info.control, null, 2)}\n`, { flag: "wx" });
    }
    result.cleanup.initialState = info.initialState;
    result.cleanup.preferences = "Guidepup can retain portable-profile trust and symlinks; complete preference restoration is not claimed";
    result.servedResources = info.served;
    stage = "Safari session";
    const created = await webdriver("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
    session = created.sessionId;
    requireEvidence(typeof session === "string" && session.length > 0, "Safari returned no session ID");
    result.cleanup.safariSession = "pending";
    result.environment.browser = created.capabilities;
    requireEvidence(created.capabilities?.browserName?.toLowerCase() === "safari", "Driver did not create actual Safari");
    await recordAction("setup", "Navigate Safari to the dedicated fixture URL", () => webdriver("POST", `/session/${session}/url`, { url: cfg.story }));
    stage = "Fixture readiness";
    const deadline = Date.now() + 20000;
    while (!await script("return window.uswdsTest?.ready === true && typeof window.uswdsTest.teardown === 'function' && document.fonts.status === 'loaded';")) {
      requireEvidence(Date.now() < deadline, "Modal fixture did not become ready");
      await delay(200);
    }
    requireEvidence(await script("return document.querySelector('#test-background h1')?.textContent.trim() === 'Background content' && !!document.querySelector('[data-open-modal]') && !!document.querySelector('#test-before') && !!document.querySelector('#test-authored-hidden');"), "Wrong or incomplete modal fixture");
    await script("window.__uswdsAtRunToken = arguments[0];", [result.runToken]);
    const urls = await script("return performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /^https?:/.test(name));");
    result.servedResources.push(...await verifyServedFiles(cfg, urls));
    result.build.servedFilesVerified = true;
    stage = "VoiceOver startup";
    const load = createRequire(path.join(cfg.dependencyRoot, "package.json"));
    const guidepup = load("@guidepup/guidepup");
    voiceOver = guidepup.voiceOver;
    result.cleanup.voiceOver = "startup-restoration-unverified";
    voiceOverStartAttempted = true;
    await voiceOver.start({ capture: true, timeout: 10000, retries: 1 });
    voiceOverStarted = true;
    result.cleanup.voiceOver = "pending";
    result.environment.guidepupVoiceOverAssetVersion = voiceOver.version;
    result.environment.voiceOver = await command("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleShortVersionString", "/System/Library/CoreServices/VoiceOver.app/Contents/Info.plist"]);
    await recordAction("setup", "Activate Safari in the dedicated desktop session", () => guidepup.macOSActivate(guidepup.MacOSApplications.Safari));
    stage = "Opener capture sentinel";
    const openerLabel = await script("return document.querySelector('[data-open-modal]').textContent.trim();");
    result.fixture = { openerLabel, expectedHeading: "Background content" };
    await recordAction("setup-js-focus", "Place keyboard focus on modal opener; does not establish AT discoverability", () => script("document.querySelector('[data-open-modal]').focus();"));
    const sentinel = await capture("opener-sentinel", () => voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus));
    requireEvidence(sentinel.itemText.includes(openerLabel) && sentinel.speech.some(value => value.includes(openerLabel)), "Capture sentinel did not identify and speak the modal opener");
    stage = "Open modal";
    await capture("modal-open", () => recordAction("assistive-technology-keyboard",
      "Activate the opener with VoiceOver Control-Option-Space (performDefaultActionForItem)",
      () => voiceOver.perform(voiceOver.keyboardCommands.performDefaultActionForItem)));
    stage = "Teardown and heading navigation";
    await recordAction("fixture-lifecycle-js", "Simulate application unmount with window.uswdsTest.teardown()", () => script("window.uswdsTest.teardown();"));
    await recordAction("assisted-js-focus", "Position keyboard focus on Previous page action after teardown; not an assertion of natural focus recovery", () => script("document.getElementById('test-before').focus();"));
    await recordAction("assistive-technology-positioning", "Synchronize VoiceOver cursor with assisted keyboard position before testing heading navigation", () => voiceOver.perform(voiceOver.keyboardCommands.moveCursorToKeyboardFocus));
    const restored = await capture("background-restored", () => voiceOver.previousHeading());
    assertBehavior(restored.itemText.includes("Background content"), "teardown.heading-reachable", "VoiceOver heading navigation did not reach background content");
    const headingObserved = restored.speech.some(value => value.includes("Background content"));
    result.assertions.push({ id: "teardown.heading-spoken", passed: headingObserved });
    requireEvidence(headingObserved, "Expected heading is absent from partial command capture; missing announcement and truncated capture are not distinguishable");
    stage = "Final build verification";
    const finalUrls = await script("return performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /^https?:/.test(name));");
    result.servedResources = await verifyServedFiles(cfg, [cfg.story, ...finalUrls]);
    requireEvidence((await buildDigest(cfg.buildDir)).sha256 === result.build.sha256, "Declared build changed during execution");
  } catch (error) {
    result.errors.push(errorRecord(error, stage));
  } finally {
    if (voiceOverStarted) {
      try { await voiceOver.stop({ timeout: 10000, retries: 1 }); result.cleanup.voiceOver = "stopped"; }
      catch (error) { result.cleanup.voiceOver = "failed"; result.cleanup.errors.push(errorRecord(error, "VoiceOver cleanup")); }
    }
    if (voiceOverStartAttempted) {
      try {
        result.cleanup.finalState = await runtimeState();
        requireEvidence(!result.cleanup.finalState.voiceOverRunning && !result.cleanup.finalState.profileMounted,
          "VoiceOver process or Guidepup profile volume remains active after cleanup");
        if (!voiceOverStarted) result.cleanup.voiceOver = "startup-failed-process-and-volume-restored";
      } catch (error) {
        result.cleanup.voiceOver = "failed";
        result.cleanup.errors.push(errorRecord(error, "Verify VoiceOver cleanup"));
      }
    }
    if (session) {
      try { await webdriver("DELETE", `/session/${session}`); result.cleanup.safariSession = "deleted"; }
      catch (error) { result.cleanup.safariSession = "failed"; result.cleanup.errors.push(errorRecord(error, "Safari session cleanup")); }
    }
    result.finishedAt = timestamp();
    Object.assign(result, evaluateResult(result));
    await fs.writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  }
  return { result, runDir };
}

async function main() {
  try {
    requireEvidence(process.argv.slice(2).every(arg => arg === "--preflight"), "Only --preflight is supported");
    const cfg = config();
    if (process.argv.includes("--preflight")) console.log(JSON.stringify(await preflight(cfg), null, 2));
    else {
      const { result, runDir } = await replay(cfg);
      console.log(JSON.stringify({ status: result.status, evidenceComplete: result.evidenceComplete,
        errors: result.errors, cleanup: result.cleanup, result: path.join(runDir, "result.json") }, null, 2));
      process.exitCode = result.status === "passed" ? 0 : 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: "inconclusive", error: errorRecord(error, "configuration/preflight") }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { config, buildDigest, verifyServedFiles, controlMetadata, preflight, replay };
