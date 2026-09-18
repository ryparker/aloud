const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { sha256 } = require("../evidence.cjs");
const { ORIGINAL_SHA256, PATCHED_SHA256, RELATIVE_PATH, patchSource, applyPatch, verifyInstalledStartup } = require("../guidepup-startup-patch.cjs");

// Exact original compiled startup module from Guidepup 0.34.0. Executed only with mocked dependencies.
const ORIGINAL_SOURCE = "\"use strict\";\nObject.defineProperty(exports, \"__esModule\", { value: true });\nexports.start = start;\nconst activate_1 = require(\"../activate\");\nconst Applications_1 = require(\"../Applications\");\nconst debug_1 = require(\"../../debug\");\nconst delay_1 = require(\"../../delay\");\nconst errors_1 = require(\"../errors\");\nconst child_process_1 = require(\"child_process\");\nconst debug = debug_1.base.extend(\"start\");\nconst VOICE_OVER_STARTER = \"/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter\";\nasync function start(options) {\n    debug(\"executing VoiceOver Starter\");\n    await new Promise((resolve, reject) => {\n        (0, child_process_1.exec)(VOICE_OVER_STARTER, (error) => {\n            if (error) {\n                debug(\"VoiceOver Starter failed\", error);\n                reject(new Error(`${errors_1.ERR_VOICE_OVER_CANNOT_BE_STARTED}\\n${error.message}`));\n            }\n            else {\n                debug(\"VoiceOver Starter succeeded\");\n                resolve();\n            }\n        });\n    });\n    await (0, delay_1.delay)(500);\n    await (0, activate_1.activate)(Applications_1.Applications.VoiceOver, options);\n}\n";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-startup-patch-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const packageDir = path.join(directory, "node_modules/@guidepup/guidepup");
  const target = path.join(packageDir, RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), "{}");
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@guidepup/guidepup", version: "0.34.0" }));
  await fs.writeFile(target, ORIGINAL_SOURCE);
  return { directory, packageDir, target, manifest: path.join(directory, "patch.json") };
}

async function mockedStartup(waitFails = false) {
  const events = [];
  let ready = false;
  const exports = {};
  const options = { timeout: 10000, retries: 1 };
  const dependencies = {
    "../activate": { activate: async (app, received) => { assert.equal(app, "VoiceOver"); assert.equal(received.timeout, options.timeout); assert.equal(received.retries, 1); assert.equal(ready, true); events.push("activate"); } },
    "./waitForRunning": { waitForRunning: async received => { assert.equal(received, options); events.push("wait-for-native-readiness"); if (waitFails) throw new Error("Native reader did not start"); ready = true; } },
    "../Applications": { Applications: { VoiceOver: "VoiceOver" } },
    "../../debug": { base: { extend: () => () => {} } },
    "../../delay": { delay: async ms => { assert.equal(ms, 500); events.push("existing-delay"); } },
    "../errors": { ERR_VOICE_OVER_CANNOT_BE_STARTED: "VoiceOver cannot be started" },
    "child_process": { exec: (file, callback) => { assert.match(file, /VoiceOverStarter$/); events.push("native-starter"); callback(null); } },
  };
  vm.runInNewContext(patchSource(ORIGINAL_SOURCE), { exports, performance: { now: () => 0 }, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; } });
  if (waitFails) await assert.rejects(exports.start(options), /Native reader did not start/);
  else await exports.start(options);
  return events;
}

test("reviewed startup patch waits for native readiness before activating VoiceOver", async () => {
  assert.equal(sha256(ORIGINAL_SOURCE), ORIGINAL_SHA256);
  assert.equal(sha256(patchSource(ORIGINAL_SOURCE)), PATCHED_SHA256);
  assert.deepEqual(await mockedStartup(), ["native-starter", "existing-delay", "wait-for-native-readiness", "activate"]);
});

test("native readiness failure propagates without calling activation", async () => {
  assert.deepEqual(await mockedStartup(true), ["native-starter", "existing-delay", "wait-for-native-readiness"]);
});

function activationScenario(outcomes, options = { timeout: 1000, retries: 9 }) {
  let clock = 0;
  let readinessChecks = 0;
  let nativeStarts = 0;
  const calls = [];
  const delays = [];
  const logs = [];
  const exports = {};
  const dependencies = {
    "../activate": { activate: async (application, received) => {
      assert.equal(application, "VoiceOver");
      assert.equal(readinessChecks, 1);
      assert.equal(received.retries, 1);
      calls.push({ elapsed: clock - 500, timeout: received.timeout });
      const outcome = outcomes[calls.length - 1];
      assert.ok(outcome, "Unexpected activation attempt");
      clock += outcome.duration || 0;
      if (outcome.error) throw outcome.error;
    } },
    "./waitForRunning": { waitForRunning: async received => { assert.equal(received, options); readinessChecks += 1; } },
    "../Applications": { Applications: { VoiceOver: "VoiceOver" } },
    "../../debug": { base: { extend: () => (...args) => logs.push(args) } },
    "../../delay": { delay: async milliseconds => { delays.push(milliseconds); clock += milliseconds; } },
    "../errors": { ERR_VOICE_OVER_CANNOT_BE_STARTED: "VoiceOver cannot be started" },
    "child_process": { exec: (_file, callback) => { nativeStarts += 1; callback(null); } },
  };
  vm.runInNewContext(patchSource(ORIGINAL_SOURCE), { exports, performance: { now: () => clock },
    require: name => { assert.ok(dependencies[name], name); return dependencies[name]; } });
  return { run: () => exports.start(options), calls, delays, logs,
    elapsed: () => clock - 500, nativeStarts: () => nativeStarts };
}

test("startup retries transient activation -600 after readiness without relaunching VoiceOver", async () => {
  const first = new Error("Unable to activate application: VoiceOver\nApplication isn’t running. (-600)");
  const second = new Error("Unable to activate application: VoiceOver\nApplication isn't running. (-600)");
  const scenario = activationScenario([{ error: first, duration: 50 }, { error: second, duration: 25 }, { duration: 100 }]);
  await scenario.run();
  assert.deepEqual(scenario.calls, [{ elapsed: 0, timeout: 1000 }, { elapsed: 250, timeout: 750 }, { elapsed: 475, timeout: 525 }]);
  assert.deepEqual(scenario.delays, [500, 200, 200]);
  assert.equal(scenario.nativeStarts(), 1);
  const failedAttempts = scenario.logs.filter(([message]) => message === "VoiceOver activation not ready");
  assert.deepEqual(failedAttempts.map(([, detail]) => detail.attempt), [1, 2]);
  assert.deepEqual(failedAttempts.map(([, detail]) => detail.error), [first.message, second.message]);
});

test("permanent startup -600 preserves the final native error at one deadline", async () => {
  const failures = Array.from({ length: 4 }, (_, index) => new Error(`Attempt ${index + 1}: Application isn’t running. (-600)`));
  const scenario = activationScenario(failures.map(error => ({ error, duration: 100 })));
  await assert.rejects(scenario.run(), error => error === failures.at(-1));
  assert.deepEqual(scenario.calls, [{ elapsed: 0, timeout: 1000 }, { elapsed: 300, timeout: 700 }, { elapsed: 600, timeout: 400 }, { elapsed: 900, timeout: 100 }]);
  assert.equal(scenario.elapsed(), 1000);
  assert.equal(scenario.nativeStarts(), 1);
  assert.equal(scenario.logs.filter(([message]) => message === "VoiceOver activation not ready").length, 4);
});

test("startup does not retry unrelated activation errors or a mismatched -600 message", async () => {
  for (const message of ["AppleEvent timed out. (-1712)", "Automation permission denied. (-1743)", "Other failure (-600)", "Application isn’t running."]) {
    const error = new Error(message);
    const scenario = activationScenario([{ error, duration: 10 }]);
    await assert.rejects(scenario.run(), observed => observed === error);
    assert.equal(scenario.calls.length, 1);
    assert.deepEqual(scenario.delays, [500]);
  }
});

test("startup shortens its last retry interval and rejects a success after the deadline", async () => {
  const error = new Error("Application isn’t running. (-600)");
  const exhausted = activationScenario([{ error, duration: 50 }], { timeout: 100 });
  await assert.rejects(exhausted.run(), observed => observed === error);
  assert.deepEqual(exhausted.delays, [500, 50]);
  assert.equal(exhausted.calls.length, 1);
  assert.equal(exhausted.elapsed(), 100);
  const late = activationScenario([{ duration: 101 }], { timeout: 100 });
  await assert.rejects(late.run(), /completed after its deadline/);
  assert.equal(late.calls.length, 1);
});

test("patch installation records explicit provenance; modified startup cannot run without its manifest", async t => {
  const f = await fixture(t);
  assert.equal(await verifyInstalledStartup(f.directory), null);
  const record = await applyPatch(f.directory, f.manifest);
  assert.equal(record.packageVersion, "0.34.0");
  assert.equal(record.upstreamRelease, false);
  assert.equal(record.status, "experimental-compatibility-patch");
  assert.equal(record.verifiedTargetSha256, PATCHED_SHA256);
  await assert.rejects(verifyInstalledStartup(f.directory), /requires the known/);
  assert.equal((await verifyInstalledStartup(f.directory, f.manifest)).id, record.id);
  await assert.rejects(applyPatch(f.directory, f.manifest), /pinned original/);
});

test("wrong package versions and original bytes fail before mutation", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.packageDir, "package.json"), JSON.stringify({ name: "@guidepup/guidepup", version: "0.35.0" }));
  await assert.rejects(applyPatch(f.directory, f.manifest), /requires Guidepup/);
  assert.equal(await fs.readFile(f.target, "utf8"), ORIGINAL_SOURCE);
  await fs.writeFile(path.join(f.packageDir, "package.json"), JSON.stringify({ name: "@guidepup/guidepup", version: "0.34.0" }));
  await fs.appendFile(f.target, "// changed");
  await assert.rejects(applyPatch(f.directory, f.manifest), /pinned original/);
  await assert.rejects(fs.access(f.manifest));
});

test("preflight verification rejects a forged manifest or post-install source change", async t => {
  const f = await fixture(t);
  await applyPatch(f.directory, f.manifest);
  const originalManifest = await fs.readFile(f.manifest, "utf8");
  const altered = JSON.parse(originalManifest);
  altered.patchedSha256 = "a".repeat(64);
  await fs.writeFile(f.manifest, JSON.stringify(altered));
  await assert.rejects(verifyInstalledStartup(f.directory, f.manifest), /does not match the reviewed/);
  await fs.writeFile(f.manifest, originalManifest);
  await fs.appendFile(f.target, "// changed");
  await assert.rejects(verifyInstalledStartup(f.directory, f.manifest), /bytes do not match/);
});
