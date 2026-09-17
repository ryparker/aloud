const { CAPTURE_POLICY } = require("./evidence.cjs");

// Guidepup's native commands return after populating their internal caches. Its
// public getters do not poll live speech. In particular, do not nest a native
// Guidepup command inside voiceOver.capture(): both queue work on the same client.
async function collectCommandCapture(reader, action) {
  await reader.clearSpokenPhraseLog();
  await reader.clearItemTextLog();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await action();
  const commandDurationMs = performance.now() - started;
  const commandFinishedAt = new Date().toISOString();
  return {
    startedAt,
    speech: await reader.spokenPhraseLog(),
    itemText: await reader.itemText(),
    capture: { ...CAPTURE_POLICY, logCleared: true, itemLogCleared: true,
      commandCompleted: true, commandDurationMs, commandFinishedAt },
  };
}

module.exports = { collectCommandCapture };
