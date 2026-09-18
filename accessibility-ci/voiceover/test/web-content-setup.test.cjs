const { test } = require("node:test");
const assert = require("node:assert/strict");
const { enterSafariWebContent, LIMITS } = require("../web-content-setup.cjs");

function dependencies(settings = {}) {
  let clock = 0;
  let speech = ["stale item chooser web content"];
  let itemText = "stale item chooser web content";
  const native = [];
  const actions = [];
  const contexts = [];
  const events = [];
  const record = {};
  const chooserCommand = { keyCode: 34, modifiers: [59, 58], description: "Open Item Chooser" };
  const operate = async (id, options) => {
    events.push(id);
    native.push({ id, options });
    assert.equal(options.retries, 1);
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    clock += settings.duration?.[native.length - 1] || 0;
    if (settings.errorAt === id) throw settings.error;
    const output = id === "chooser" ? settings.chooser || { speech: ["Item Chooser\n"], item: "Item Chooser" } :
      id === "type" ? settings.selection || { speech: ["web content, one item\n"], item: "web content" } :
        settings.interaction || { speech: ["entered web content\n"], item: "Background content heading level 1" };
    if (options.capture) { speech = output.speech; itemText = output.item; }
  };
  const reader = {
    keyboardCommands: { openItemChooser: chooserCommand },
    perform: (command, options) => operate(command === chooserCommand ? "chooser" :
      command.keyCode === 59 ? "control" : command.keyCode === 53 ? "escape" : "enter", options),
    type: (text, options) => { assert.equal(text, "web content"); return operate("type", options); },
    interact: options => operate("interact", options),
    clearSpokenPhraseLog: async () => { events.push("clear-speech"); speech = []; },
    clearItemTextLog: async () => { events.push("clear-item"); itemText = ""; },
    spokenPhraseLog: async () => speech,
    itemText: async () => itemText,
  };
  return { reader, keyCodes: { Control: 59, Escape: 53, Enter: 36 }, record, native, actions, contexts, events,
    clock: () => clock,
    verifyContext: async phase => {
      contexts.push(phase);
      clock += settings.contextDuration?.[phase] || 0;
      if (settings.contextError === phase) throw new Error("Owned Safari window changed");
      return { ownedWindow: true, runToken: "fixture-token" };
    },
    recordAction: async (kind, description, action) => { actions.push({ kind, description }); return action(); },
  };
}

test("browser entry records exactly six native setup commands and preserves fresh captured strings", async () => {
  const deps = dependencies();
  assert.equal(await enterSafariWebContent(deps), deps.record);
  assert.deepEqual(deps.native.map(item => item.id), ["control", "escape", "chooser", "type", "enter", "interact"]);
  assert.deepEqual(deps.native.map(item => item.options.capture), [false, false, true, true, false, true]);
  assert.deepEqual(deps.contexts, ["before", "after"]);
  assert.equal(deps.record.status, "completed-awaiting-opener-sentinel");
  assert.equal(deps.record.purpose, "assisted-browser-entry");
  assert.equal(deps.record.commands[2].speech[0], "Item Chooser\n");
  assert.equal(deps.record.commands[3].speech[0], "web content, one item\n");
  assert.equal(deps.record.commands[5].itemText, "Background content heading level 1");
  assert.equal(deps.record.commands[2].identityVerified, "item chooser");
  assert.equal(deps.record.commands[3].searchTextObserved, "web content");
  assert.equal(deps.record.commands[3].candidateSelectionVerified, false);
  assert.equal(Object.hasOwn(deps.record.commands[3], "identityVerified"), false);
  assert.equal(deps.record.commands[5].fixtureIdentityVerified, false);
  assert.equal(deps.events.filter(event => event === "clear-speech").length, 3);
  assert.equal(deps.events.filter(event => event === "clear-item").length, 3);
  assert.equal(deps.actions.length, LIMITS.commandLimit);
  assert.ok(deps.record.commands.every(item => item.commandCompleted && item.finishedAt));
  assert.equal(Object.hasOwn(deps.record, "assertions"), false);
  assert.equal(Object.hasOwn(deps.record, "steps"), false);
});

test("wrong or empty chooser identity stops before typing and retains completed setup captures", async () => {
  for (const chooser of [{ speech: ["Safari toolbar"], item: "toolbar" }, { speech: [""], item: "" }]) {
    const deps = dependencies({ chooser });
    await assert.rejects(enterSafariWebContent(deps), /did not identify the VoiceOver Item Chooser/);
    assert.deepEqual(deps.native.map(item => item.id), ["control", "escape", "chooser"]);
    assert.deepEqual(deps.record.commands[2].speech, chooser.speech);
    assert.equal(deps.record.status, "failed");
    assert.match(deps.record.error.message, /Item Chooser/);
  }
});

test("wrong selection or no matching items stops before Enter without a fallback", async () => {
  for (const selection of [{ speech: ["toolbar"], item: "toolbar" }, { speech: ["web content, 0 items"], item: "web content" }]) {
    const deps = dependencies({ selection });
    await assert.rejects(enterSafariWebContent(deps), /did not observe its web content search text|no matching web content/);
    assert.deepEqual(deps.native.map(item => item.id), ["control", "escape", "chooser", "type"]);
    assert.deepEqual(deps.record.commands[3].speech, selection.speech);
    assert.equal(deps.record.status, "failed");
  }
});

test("echoed search text does not establish selected web content or excuse a toolbar interaction", async () => {
  const deps = dependencies({ selection: { speech: ["web content"], item: "search text field" },
    interaction: { speech: ["toolbar"], item: "toolbar" } });
  await assert.rejects(enterSafariWebContent(deps), /remained on browser chrome/);
  assert.equal(deps.record.commands[3].searchTextObserved, "web content");
  assert.equal(deps.record.commands[3].candidateSelectionVerified, false);
  assert.equal(deps.record.commands[5].itemText, "toolbar");
  assert.equal(deps.record.status, "failed");
});

test("native command failure propagates unchanged with earlier observations and failed command retained", async () => {
  const error = new Error("VoiceOver typing failed");
  const deps = dependencies({ errorAt: "type", error });
  await assert.rejects(enterSafariWebContent(deps), observed => observed === error);
  assert.equal(deps.record.commands.length, 4);
  assert.equal(deps.record.commands[2].identityVerified, "item chooser");
  assert.equal(deps.record.commands[3].commandCompleted, false);
  assert.equal(deps.record.commands[3].error.message, error.message);
  assert.ok(deps.record.commands[3].finishedAt);
  assert.equal(deps.record.status, "failed");
});

test("deadline limits remaining native timeouts and prevents any subsequent command", async () => {
  const deps = dependencies({ contextDuration: { before: 57000 }, duration: [1000, 1000, 1000] });
  await assert.rejects(enterSafariWebContent(deps), /60000ms deadline/);
  assert.deepEqual(deps.native.map(item => item.options.timeout), [3000, 2000, 1000]);
  assert.deepEqual(deps.native.map(item => item.id), ["control", "escape", "chooser"]);
  assert.equal(deps.record.commands[2].commandCompleted, true);
  assert.deepEqual(deps.record.commands[2].speech, ["Item Chooser\n"]);
  assert.equal(deps.record.durationMs, 60000);
  assert.equal(deps.record.status, "failed");
});

test("an SDK capture overrun fails after it returns and never reports completed entry", async () => {
  const deps = dependencies({ duration: [0, 0, 61000] });
  await assert.rejects(enterSafariWebContent(deps), /60000ms deadline/);
  assert.equal(deps.record.commands.length, 3);
  assert.equal(deps.record.durationMs, 61000);
  assert.equal(deps.record.status, "failed");
  assert.deepEqual(deps.contexts, ["before"]);
});

test("context failure stops native work before setup or preserves all observations after setup", async () => {
  for (const contextError of ["before", "after"]) {
    const deps = dependencies({ contextError });
    await assert.rejects(enterSafariWebContent(deps), /Owned Safari window changed/);
    assert.equal(deps.native.length, contextError === "before" ? 0 : 6);
    assert.equal(deps.record.contexts.at(-1).verified, false);
    assert.ok(deps.record.contexts.at(-1).finishedAt);
    assert.equal(deps.record.status, "failed");
  }
});

test("existing browser entry evidence cannot be reused or overwritten", async () => {
  const deps = dependencies();
  deps.record.previous = "retained evidence";
  await assert.rejects(enterSafariWebContent(deps), /fresh mutable record/);
  assert.deepEqual(deps.record, { previous: "retained evidence" });
  assert.equal(deps.native.length, 0);
});
