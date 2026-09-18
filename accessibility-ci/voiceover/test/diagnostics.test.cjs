const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rawNativeRead, startReaderControl, diagnoseModalCapture } = require("../diagnostics.cjs");
const { sha256 } = require("../evidence.cjs");

test("passive native reads preserve empty, missing-value, whitespace and subprocess error details", async () => {
  for (const stdout of ["", "missing value\n", "  spoken phrase\n"]) {
    const result = await rawNativeRead("phrase", (file, args, options, callback) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.equal(options.timeout, 3000);
      assert.match(args[1], /content of last phrase/);
      callback(null, stdout, "diagnostic stderr\n");
    });
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, "diagnostic stderr\n");
    assert.equal(result.error, null);
  }
  const failure = await rawNativeRead("cursor", (_file, _args, _options, callback) => {
    callback(Object.assign(new Error("native failure"), { code: 1, signal: "SIGTERM", killed: true }), "partial\n", "error output\n");
  });
  assert.equal(failure.stdout, "partial\n");
  assert.deepEqual(failure.error, { message: "native failure", code: 1, signal: "SIGTERM", killed: true });
  assert.throws(() => rawNativeRead("unsupported"), /Unknown/);
});

test("reader control serves exact declared bytes only from its local fixture route", async t => {
  const control = await startReaderControl();
  t.after(control.close);
  const response = await fetch(control.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(sha256(bytes), control.sha256);
  assert.equal(bytes.length, control.bytes);
  assert.match(bytes.toString(), /dialog\.showModal\(\)/);
  assert.equal((await fetch(new URL("/unknown", control.url))).status, 404);
  assert.equal((await fetch(control.url, { method: "POST" })).status, 404);
});

function dependencies() {
  const events = [];
  const command = description => ({ description });
  const reader = {
    keyboardCommands: { describeItemWithKeyboardFocus: command("describe"), moveCursorToKeyboardFocus: command("sync"), performDefaultActionForItem: command("activate") },
    clearSpokenPhraseLog: async () => {}, clearItemTextLog: async () => {},
    perform: async command => { events.push(command.description); },
    spokenPhraseLog: async () => ["requested output"], itemText: async () => "diagnostic item",
  };
  const originalSnapshot = Object.freeze({ id: "modal-open", speech: Object.freeze([""]), itemText: "stale opener" });
  return { events, reader, originalSnapshot, foreground: async () => "com.apple.Safari", pause: async () => {},
    read: async kind => { events.push(`read:${kind}`); return { kind, stdout: "missing value\n" }; },
    script: async source => source.includes("readerControlReady") ? true : { focus: "fixture", url: "http://127.0.0.1:1234/reader-control.html" },
    navigate: async () => { events.push("navigate-control"); },
    desktop: async file => { events.push(`screenshot:${file}`); return { file }; },
    startControl: async () => ({ url: "http://127.0.0.1:1234/reader-control.html", sha256: "a".repeat(64), bytes: 20,
      close: async () => { events.push("close-control"); } }),
  };
}

test("diagnostics retain original empty capture and separate passive, elicited and control observations", async () => {
  const deps = dependencies();
  const result = await diagnoseModalCapture(deps);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(deps.originalSnapshot.speech, [""]);
  assert.deepEqual(result.originalSnapshot.speech, [""]);
  assert.equal(result.purpose, "diagnostic-only");
  assert.equal(result.records[0].method, "passive-native-reads");
  assert.equal(result.records[0].samples.length, 3);
  assert.equal(result.records[1].method, "elicited-native-command");
  assert.ok(deps.events.indexOf("describe") < deps.events.indexOf("navigate-control"));
  assert.equal(deps.events.at(-1), "close-control");
  assert.equal(Object.hasOwn(result, "assertions"), false);
  assert.equal(Object.hasOwn(result, "status"), false);
});

test("lost Safari foreground stops diagnostic actions without mutating original evidence", async () => {
  const deps = dependencies();
  deps.foreground = async () => "com.apple.finder";
  const result = await diagnoseModalCapture(deps);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /lost foreground/);
  assert.deepEqual(deps.events, []);
  assert.deepEqual(deps.originalSnapshot.speech, [""]);
});
