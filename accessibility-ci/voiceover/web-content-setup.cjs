const { collectCommandCapture } = require("./capture.cjs");
const { requireEvidence, errorRecord } = require("./evidence.cjs");

const LIMITS = Object.freeze({ deadlineMs: 60000, commandLimit: 6, nativeTimeoutMaxMs: 5000,
  chooserReadinessSamples: 4, chooserReadinessIntervalMs: 200 });
const now = () => new Date().toISOString();

function hasCapturedIdentity(command, identity) {
  const speech = command.speech;
  requireEvidence(Array.isArray(speech) && speech.every(value => typeof value === "string") &&
    typeof command.itemText === "string", "Browser entry returned malformed native capture");
  return [command.itemText, ...speech].some(value => identity.test(value));
}

// This bounded setup adapts the Item Chooser sequence in Guidepup Playwright's
// navigateToWebContent helper. It does not replace the original opener sentinel.
// Guidepup has no cancellation API for a capture in progress. Check the deadline
// before and after awaited work, retaining an overrun as failure without starting
// another command or leaving a deliberately detached command running.
async function enterSafariWebContent({ reader, keyCodes, record, verifyContext, recordAction,
  clock = () => performance.now(), readNativePhrase, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  requireEvidence(record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).length === 0,
    "Browser entry requires a fresh mutable record");
  requireEvidence(typeof verifyContext === "function" && typeof recordAction === "function" && typeof clock === "function",
    "Browser entry requires context verification and action recording");
  requireEvidence(reader && typeof reader.perform === "function" && typeof reader.type === "function" &&
    typeof reader.interact === "function" && reader.keyboardCommands?.openItemChooser &&
    [keyCodes?.Control, keyCodes?.Escape, keyCodes?.Enter].every(Number.isSafeInteger),
  "Browser entry requires the pinned Guidepup native commands");
  const started = clock();
  Object.assign(record, { schemaVersion: 1, purpose: "assisted-browser-entry", status: "running", startedAt: now(),
    limits: { ...LIMITS, commandLimitUnit: "SDK calls; typing emits one native action per character" }, contexts: [], commands: [],
    limitations: ["Setup output is separate from scenario assertions and cannot replace the opener sentinel.",
      "Item Chooser identity is checked through native captured text; later sentinel verifies the fixture opener.",
      "The deadline is checked around awaited SDK work; an in-flight capture cannot be safely cancelled."] });
  const remaining = () => LIMITS.deadlineMs - (clock() - started);
  const checkDeadline = () => requireEvidence(remaining() > 0, "Browser entry exceeded its 60000ms deadline");
  const context = async phase => {
    checkDeadline();
    const entry = { phase, startedAt: now(), verified: false };
    record.contexts.push(entry);
    try {
      const observed = await verifyContext(phase);
      if (observed !== undefined) entry.observed = observed;
      entry.verified = true;
      checkDeadline();
    } finally { entry.finishedAt = now(); }
  };
  const command = async (id, description, capture, action) => {
    checkDeadline();
    requireEvidence(record.commands.length < LIMITS.commandLimit, "Browser entry exceeded its setup call limit");
    const item = { id, description, startedAt: now(), commandCompleted: false };
    record.commands.push(item);
    const invoke = () => {
      checkDeadline();
      item.options = { timeout: Math.max(1, Math.min(LIMITS.nativeTimeoutMaxMs, Math.floor(remaining()))), retries: 1, capture };
      return recordAction("assistive-technology-browser-setup", description, () => action(item.options));
    };
    try {
      if (capture) {
        Object.assign(item, await collectCommandCapture(reader, invoke));
        // Setup may request initial capture per typed character. Scenario capture
        // retains its existing policy; record the actual setup mode explicitly.
        item.capture.captureMode = capture;
      }
      else await invoke();
      item.commandCompleted = true;
      checkDeadline();
      return item;
    } catch (error) {
      item.error = errorRecord(error, id);
      throw error;
    } finally { item.finishedAt = now(); }
  };

  try {
    await context("before");
    await command("cancel-current-interaction", "Cancel current VoiceOver speech before browser entry", false,
      options => reader.perform({ keyCode: keyCodes.Control }, options));
    await command("close-menus", "Close existing menus before opening the VoiceOver Item Chooser", false,
      options => reader.perform({ keyCode: keyCodes.Escape }, options));
    const chooser = await command("open-item-chooser", "Open VoiceOver Item Chooser once", true,
      options => reader.perform(reader.keyboardCommands.openItemChooser, options));
    let chooserIdentified = hasCapturedIdentity(chooser, /\bitem chooser\b/i);
    chooser.identitySource = chooserIdentified ? "command-capture" : "unverified";
    if (!chooserIdentified && typeof readNativePhrase === "function") {
      chooser.nativeReadinessSamples = [];
      for (let attempt = 0; attempt < LIMITS.chooserReadinessSamples; attempt += 1) {
        checkDeadline();
        const sample = await readNativePhrase();
        chooser.nativeReadinessSamples.push(sample);
        checkDeadline();
        requireEvidence(sample && typeof sample.stdout === "string" && !sample.error,
          "Native Item Chooser readiness read failed");
        if (/\bitem chooser\b/i.test(sample.stdout)) {
          chooserIdentified = true;
          chooser.identitySource = "passive-native-readiness";
          break;
        }
        if (attempt + 1 < LIMITS.chooserReadinessSamples) await pause(LIMITS.chooserReadinessIntervalMs);
      }
    }
    requireEvidence(chooserIdentified, "Browser entry did not identify the VoiceOver Item Chooser");
    chooser.identityVerified = "item chooser";
    const selected = await command("select-web-content", "Search the VoiceOver Item Chooser for web content once", "initial",
      options => reader.type("web content", options));
    requireEvidence(hasCapturedIdentity(selected, /\bweb content\b/i), "Browser entry did not observe its web content search text in the Item Chooser");
    requireEvidence(![selected.itemText, ...selected.speech].some(value => /\b(?:no|zero|0) (?:matching )?(?:items|results)\b/i.test(value)),
      "Browser entry Item Chooser reported no matching web content");
    selected.searchTextObserved = "web content";
    selected.candidateSelectionVerified = false;
    await command("accept-web-content", "Accept the candidate Item Chooser result after observing the search text", false,
      options => reader.perform({ keyCode: keyCodes.Enter }, options));
    const interacted = await command("interact-with-web-content", "Interact with the candidate browser item once", true,
      options => reader.interact(options));
    requireEvidence(typeof interacted.itemText === "string" && interacted.itemText.trim().length > 0 &&
      !/^(?:toolbar|item chooser)$/i.test(interacted.itemText.trim()),
    "Browser entry interaction remained on browser chrome or returned no native item");
    interacted.fixtureIdentityVerified = false;
    await context("after");
    requireEvidence(record.commands.length === LIMITS.commandLimit && record.commands.every(item => item.commandCompleted),
      "Browser entry did not complete its six setup API calls");
    record.status = "completed-awaiting-opener-sentinel";
    return record;
  } catch (error) {
    record.status = "failed";
    record.error = errorRecord(error, "Browser content entry");
    throw error;
  } finally {
    record.finishedAt = now();
    record.durationMs = clock() - started;
  }
}

module.exports = { LIMITS, enterSafariWebContent };
