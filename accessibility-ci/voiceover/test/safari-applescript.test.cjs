const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createSafariAppleScript, assertHostedSafariEnvironment, appleScriptString,
  scriptEnvelope, decodeEnvelope, loopbackURL } = require("../safari-applescript.cjs");

test("ordinary Safari production guard requires the dedicated hosted macOS desktop", () => {
  const allowed = { RUNNER_ENVIRONMENT: "github-hosted", USWDS_AT_DEDICATED_SESSION: "1" };
  assert.doesNotThrow(() => assertHostedSafariEnvironment(allowed, "darwin"));
  for (const [env, platform] of [[allowed, "linux"], [{ ...allowed, RUNNER_ENVIRONMENT: "self-hosted" }, "darwin"],
    [{ ...allowed, USWDS_AT_DEDICATED_SESSION: "0" }, "darwin"], [{}, "darwin"]]) {
    assert.throws(() => assertHostedSafariEnvironment(env, platform), /disposable GitHub-hosted macOS/);
  }
  assert.throws(() => createSafariAppleScript({ runDir: "relative", command: async () => "" }), /absolute/);
});

test("JavaScript envelopes preserve JSON values, arguments, escaping and errors without shell evaluation", () => {
  const text = 'quoted " text \\ newline\n\r\t`tick` $(untouched) ☃';
  assert.equal(JSON.parse(appleScriptString(text)), text);
  const args = [null, text, [true, 7, { nested: "value" }]];
  const raw = vm.runInNewContext(scriptEnvelope("return arguments[0];", [args]));
  assert.deepEqual(decodeEnvelope(raw), args);
  assert.equal(decodeEnvelope(vm.runInNewContext(scriptEnvelope("return null;"))), null);
  assert.equal(decodeEnvelope(vm.runInNewContext(scriptEnvelope("return undefined;"))), null);
  assert.throws(() => decodeEnvelope(vm.runInNewContext(scriptEnvelope('throw new TypeError("native JS failure");'))),
    { name: "TypeError", message: "Safari JavaScript failed: native JS failure" });
  assert.throws(() => decodeEnvelope(vm.runInNewContext(scriptEnvelope("return 1n;"))), /not JSON serializable/);
  assert.throws(() => decodeEnvelope("missing value\n"), /malformed/);
  assert.throws(() => decodeEnvelope('{"ok":true}'), /no value/);
});

test("ordinary Safari only navigates to loopback HTTP fixture URLs", () => {
  for (const value of ["http://127.0.0.1:1234/test?q=one", "http://localhost:1234/", "http://[::1]:1234/"])
    assert.equal(loopbackURL(value), value);
  for (const value of ["https://127.0.0.1/", "file:///tmp/test.html", "http://example.com/", "http://localhost.example.com/",
    "http://user:secret@localhost/", "javascript:alert(1)", "/relative"])
    assert.throws(() => loopbackURL(value), /loopback/);
});

function mockSafari(options = {}) {
  const calls = [];
  const closedIds = [];
  const state = { url: "about:blank", bounds: [0, 0, 1024, 768] };
  const command = async (file, args) => {
    calls.push({ file, args });
    if (file === "/usr/libexec/PlistBuddy") return args[1].includes("ShortVersion") ? "26.6\n" : "20622.3.4.11.5\n";
    if (file === "/usr/sbin/screencapture") {
      await fs.writeFile(args.at(-1), options.invalidScreenshot ? "invalid" : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
      return "";
    }
    assert.equal(file, "/usr/bin/osascript");
    const script = args[1];
    if (script.includes("return id of every window")) return "12, 15\n";
    if (script.includes("make new document")) return `${options.reusedWindow ? 12 : 99}\n`;
    if (script.includes("then close window id")) {
      const id = Number(script.match(/then close window id (\d+)/)[1]);
      closedIds.push(id);
      if (options.closeFails) throw new Error("close refused");
      return "closed";
    }
    assert.ok(script.includes("window id 99"), "All post-creation native operations must target the owned numeric window ID");
    if (script.includes("return id of front window")) return String(options.wrongFrontWindow ? 12 : 99);
    assert.ok(!script.includes("front window"), "Post-creation operations must not follow a changed foreground window");
    if (script.includes("return do JavaScript")) {
      if (options.jsDenied) throw new Error("JavaScript from Apple Events is disabled");
      const literal = script.match(/return do JavaScript ("(?:\\.|[^"\\])*") in current tab/)[1];
      const source = JSON.parse(literal);
      if (options.wrongNonce && source.includes("return arguments[0];")) return '{"ok":true,"value":"wrong-nonce"}';
      return vm.runInNewContext(source, { location: { href: state.url }, document: { readyState: "complete" } });
    }
    if (script.includes("set URL")) {
      const literal = script.match(/set URL[^\n]+ to ("(?:\\.|[^"\\])*")/)[1];
      state.url = JSON.parse(literal);
      return "";
    }
    if (script.includes("return bounds")) {
      const setter = script.match(/set bounds[^\n]+ to \{([^}]+)\}/);
      if (setter) state.bounds = setter[1].split(",").map(Number);
      return state.bounds.join(", ");
    }
    if (script.includes("set index")) return "";
    if (script.includes("return id of window id 99")) return "99";
    throw new Error(`Unrecognized mocked native operation: ${script}`);
  };
  return { calls, closedIds, state, command };
}

const sessionRequest = { capabilities: { alwaysMatch: { browserName: "safari" } } };

test("status reads bundle metadata without launching Safari; requests retain owned-window identity", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "safari-adapter-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mock = mockSafari();
  const adapter = createSafariAppleScript({ runDir: dir, command: mock.command });
  const status = await adapter.request("GET", "/status");
  assert.equal(status.ready, true);
  assert.equal(status.browser.browserVersion, "26.6");
  assert.equal(status.browser.javascriptPermission, "not-yet-probed");
  assert.ok(mock.calls.every(call => call.file === "/usr/libexec/PlistBuddy"));
  const created = await adapter.request("POST", "/session", sessionRequest);
  const base = `/session/${created.sessionId}`;
  assert.equal(created.capabilities.ownedWindowId, 99);
  assert.equal(created.capabilities.transport, "safari-applescript-experimental");
  assert.equal(created.capabilities.automationWindow, false);
  assert.equal(created.capabilities.screenshotKind, "native-full-desktop-png");
  assert.equal(created.capabilities.javascriptPermission, "verified-by-nonce-probe");
  assert.equal((await adapter.request("GET", "/status")).ready, false);
  assert.deepEqual(await adapter.request("POST", `${base}/window/rect`, { x: 0, y: 0, width: 1280, height: 900 }),
    { x: 0, y: 0, width: 1280, height: 900 });
  assert.deepEqual(await adapter.request("GET", `${base}/window/rect`), { x: 0, y: 0, width: 1280, height: 900 });
  await adapter.request("POST", `${base}/url`, { url: "http://127.0.0.1:4321/fixture.html?token=abc" });
  assert.equal(mock.state.url, "http://127.0.0.1:4321/fixture.html?token=abc");
  const data = { text: 'line\n"quoted"\\', nested: [null, true] };
  assert.deepEqual(await adapter.request("POST", `${base}/execute/sync`, { script: "return arguments[0];", args: [data] }), data);
  const screenshot = await adapter.request("GET", `${base}/screenshot`);
  assert.equal(Buffer.from(screenshot, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await adapter.request("DELETE", base);
  assert.deepEqual(mock.closedIds, [99]);
  assert.equal((await adapter.request("GET", "/status")).ready, true);
  await assert.rejects(adapter.request("GET", `${base}/screenshot`), /Unknown Safari session/);
});

test("failed JavaScript permission or nonce probes close only the newly created window", async () => {
  for (const options of [{ jsDenied: true }, { wrongNonce: true }]) {
    const mock = mockSafari(options);
    const adapter = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: mock.command });
    await assert.rejects(adapter.request("POST", "/session", sessionRequest), /disabled|nonce/);
    assert.deepEqual(mock.closedIds, [99]);
    assert.equal((await adapter.request("GET", "/status")).ready, true);
  }
  const mock = mockSafari({ jsDenied: true, closeFails: true });
  const adapter = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: mock.command });
  await assert.rejects(adapter.request("POST", "/session", sessionRequest), /cleanup failed: close refused/);
  assert.equal((await adapter.request("GET", "/status")).ready, false);
});

test("preexisting window IDs, unknown sessions and unsupported routes cannot trigger unrelated native actions", async () => {
  const reused = mockSafari({ reusedWindow: true });
  const failed = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: reused.command });
  await assert.rejects(failed.request("POST", "/session", sessionRequest), /new owned window/);
  assert.deepEqual(reused.closedIds, []);
  assert.equal(reused.calls.some(call => call.args[1].includes("do JavaScript")), false);
  const mock = mockSafari();
  const adapter = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: mock.command });
  const { sessionId } = await adapter.request("POST", "/session", sessionRequest);
  const before = mock.calls.length;
  for (const [method, route, body] of [["DELETE", "/session/other"], ["GET", `/session/${sessionId}/unknown`],
    ["POST", `/session/${sessionId}/url`, { url: "https://example.com/" }],
    ["POST", `/session/${sessionId}/window/rect`, { x: 0, y: 0, width: -1, height: 900 }]])
    await assert.rejects(adapter.request(method, route, body));
  assert.equal(mock.calls.length, before);
  await adapter.request("DELETE", `/session/${sessionId}`);
});

test("concurrent session requests serialize so only one owned window is created", async () => {
  const mock = mockSafari();
  const adapter = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: mock.command });
  const results = await Promise.allSettled([adapter.request("POST", "/session", sessionRequest), adapter.request("POST", "/session", sessionRequest)]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /already owns/);
  assert.equal(mock.calls.filter(call => call.args[1].includes("make new document")).length, 1);
  await adapter.request("DELETE", `/session/${results[0].value.sessionId}`);
});


test("owned-window verification rejects another front window without moving or closing it", async () => {
  for (const wrongFrontWindow of [false, true]) {
    const mock = mockSafari({ wrongFrontWindow });
    const adapter = createSafariAppleScript({ runDir: path.resolve(os.tmpdir()), command: mock.command });
    const { sessionId } = await adapter.request("POST", "/session", sessionRequest);
    const before = mock.calls.length;
    if (wrongFrontWindow) await assert.rejects(adapter.request("GET", `/session/${sessionId}/window`), /not the front/);
    else assert.equal(await adapter.request("GET", `/session/${sessionId}/window`), "99");
    assert.equal(mock.calls.length, before + 1);
    assert.deepEqual(mock.closedIds, []);
    await adapter.request("DELETE", `/session/${sessionId}`);
    assert.deepEqual(mock.closedIds, [99]);
  }
});
