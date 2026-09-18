const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { sha256, requireEvidence } = require("./evidence.cjs");
const { collectCommandCapture } = require("./capture.cjs");

const now = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const READS = Object.freeze({
  phrase: 'tell application "VoiceOver"\nwith transaction\nreturn content of last phrase\nend transaction\nend tell',
  cursor: 'tell application "VoiceOver"\nwith transaction\nreturn text under cursor of vo cursor\nend transaction\nend tell',
  keyboardCursor: 'tell application "VoiceOver"\nwith transaction\nreturn text under cursor of keyboard cursor\nend transaction\nend tell',
  captionEnabled: 'tell application "VoiceOver"\nreturn enabled of caption window\nend tell',
});

function rawNativeRead(kind, execute = execFile) {
  requireEvidence(Object.hasOwn(READS, kind), "Unknown native diagnostic read");
  const startedAt = now();
  return new Promise(resolve => {
    execute("/usr/bin/osascript", ["-e", READS[kind]], { timeout: 3000, maxBuffer: 65536 }, (error, stdout, stderr) => {
      resolve({ kind, startedAt, finishedAt: now(), stdout: stdout ?? null, stderr: stderr ?? null,
        error: error ? { message: error.message, code: error.code ?? null, signal: error.signal ?? null, killed: error.killed === true } : null });
    });
  });
}

async function startReaderControl(file = path.join(__dirname, "reader-control.html")) {
  const bytes = await fs.readFile(file);
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/reader-control.html") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store" });
    res.end(bytes);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/reader-control.html`, sha256: sha256(bytes), bytes: bytes.length, source: bytes,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

// Diagnostics run only after the original failure has been recorded. Their
// observations never replace scenario steps or contribute passing assertions.
async function diagnoseModalCapture({ reader, script, navigate, foreground, desktop, originalSnapshot, outputDir,
  read = rawNativeRead, startControl = startReaderControl, pause = delay }) {
  const result = { schemaVersion: 1, purpose: "diagnostic-only", startedAt: now(), originalSnapshot,
    limitations: ["These probes follow a failed activation capture and cannot establish prior automatic speech.",
      "Explicit describe-focus and cursor-sync commands elicit new output.", "Caption output is not proof of audible delivery."], records: [], errors: [] };
  let control;
  const save = async () => {
    if (!outputDir) return;
    const file = path.join(outputDir, "diagnostics.json");
    await fs.writeFile(`${file}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
    await fs.rename(`${file}.tmp`, file);
  };
  const state = () => script("return {url:location.href,focus:document.activeElement?.outerHTML,viewport:{width:innerWidth,height:innerHeight},nativeDialogOpen:document.querySelector('#native-dialog')?.open,token:window.__readerControlToken};");
  const checkForeground = async () => requireEvidence(await foreground() === "com.apple.Safari", "Safari lost foreground during diagnostics");
  const passive = async label => {
    await checkForeground();
    const record = { label, method: "passive-native-reads", startedAt: now(), samples: [] };
    result.records.push(record);
    await save();
    for (let index = 0; index < 3; index++) {
      record.samples.push({ phrase: await read("phrase"), cursor: await read("cursor") });
      await save();
      if (index < 2) await pause(200);
    }
    record.state = await state(); record.finishedAt = now();
    await save();
  };
  const elicited = async (label, command) => {
    await checkForeground();
    const record = { label, method: "elicited-native-command", command: command.description, startedAt: now() };
    result.records.push(record);
    await save();
    Object.assign(record, await collectCommandCapture(reader, () => reader.perform(command, { timeout: 5000, retries: 0 })));
    record.state = await state(); record.finishedAt = now();
    await save();
  };
  try {
    await checkForeground();
    try { result.originalDesktop = await desktop("failed-modal-before-probes.png"); }
    catch (error) { result.errors.push({ stage: "desktop-before-probes", message: error.message }); }
    result.nativeMetadata = { keyboardCursor: await read("keyboardCursor"), captionEnabled: await read("captionEnabled") };
    await passive("original-modal-after-empty-capture");
    await elicited("original-modal-describe-keyboard-focus", reader.keyboardCommands.describeItemWithKeyboardFocus);
    await passive("original-modal-after-requested-description");

    control = await startControl();
    result.control = { url: control.url, sha256: control.sha256, bytes: control.bytes, token: randomUUID() };
    if (outputDir) {
      requireEvidence(control.source && sha256(control.source) === control.sha256, "Diagnostic control source differs from its served hash");
      await fs.writeFile(path.join(outputDir, "reader-control.html"), control.source, { flag: "wx" });
    }
    await navigate(control.url);
    requireEvidence(await script("return window.readerControlReady === true && location.href === arguments[0];", [control.url]), "Wrong or unready reader control document");
    await script("window.__readerControlToken=arguments[0];document.getElementById('plain-open').focus();", [result.control.token]);
    await elicited("plain-focus-opener-cursor-sync", reader.keyboardCommands.moveCursorToKeyboardFocus);
    await elicited("plain-focus-keyboard-activation", reader.keyboardCommands.performDefaultActionForItem);
    await passive("plain-focus-after-activation");
    await elicited("plain-focus-describe-keyboard-focus", reader.keyboardCommands.describeItemWithKeyboardFocus);
    await script("document.getElementById('native-open').focus();");
    await elicited("native-dialog-opener-cursor-sync", reader.keyboardCommands.moveCursorToKeyboardFocus);
    await elicited("native-dialog-keyboard-activation", reader.keyboardCommands.performDefaultActionForItem);
    await passive("native-dialog-after-activation");
    await elicited("native-dialog-describe-keyboard-focus", reader.keyboardCommands.describeItemWithKeyboardFocus);
    try { result.controlDesktop = await desktop("native-control-after-probes.png"); }
    catch (error) { result.errors.push({ stage: "desktop-after-probes", message: error.message }); }
  } catch (error) { result.errors.push({ stage: "diagnostic-probes", message: error.message }); }
  finally {
    if (control) await control.close();
    result.finishedAt = now();
    await save();
  }
  return result;
}

module.exports = { READS, rawNativeRead, startReaderControl, diagnoseModalCapture };
