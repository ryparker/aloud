const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { requireEvidence } = require("./evidence.cjs");

const execute = promisify(execFile);
const SAFARI_INFO = "/Applications/Safari.app/Contents/Info.plist";
const TRANSPORT = "safari-applescript-experimental";
const SCREENSHOT_KIND = "native-full-desktop-png";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertHostedSafariEnvironment(env = process.env, platform = process.platform) {
  requireEvidence(platform === "darwin" && env.RUNNER_ENVIRONMENT === "github-hosted" &&
    env.USWDS_AT_DEDICATED_SESSION === "1",
  "Ordinary Safari automation requires the prepared disposable GitHub-hosted macOS desktop");
}

function appleScriptString(value) {
  requireEvidence(typeof value === "string", "AppleScript text must be a string");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
    .replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")}"`;
}

function loopbackURL(value) {
  let url;
  try { url = new URL(value); } catch { requireEvidence(false, "Expected an absolute loopback fixture URL"); }
  requireEvidence(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    !url.username && !url.password, "Ordinary Safari navigation requires a loopback HTTP fixture URL");
  return url.href;
}

// Use a JSON envelope because AppleScript's native coercion of JavaScript
// objects loses distinctions such as null, arrays and embedded newlines.
function scriptEnvelope(source, args = []) {
  requireEvidence(typeof source === "string" && Array.isArray(args), "Expected JavaScript source and an argument array");
  const serializedArgs = JSON.stringify(args);
  return `(() => {
    try {
      const value = (function () {\n${source}\n}).apply(null, ${serializedArgs});
      return JSON.stringify({ok:true,value:value === undefined ? null : value}, (_key, item) => {
        if (typeof item === 'bigint' || typeof item === 'symbol' || typeof item === 'function' ||
            (typeof item === 'number' && !Number.isFinite(item))) throw new TypeError('Result is not JSON serializable');
        return item === undefined ? null : item;
      });
    } catch (error) {
      return JSON.stringify({ok:false,error:{name:String(error?.name || 'Error'),message:String(error?.message || error)}});
    }
  })()`;
}

function decodeEnvelope(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { requireEvidence(false, "Safari returned malformed JavaScript JSON"); }
  requireEvidence(parsed && typeof parsed === "object" && typeof parsed.ok === "boolean", "Safari returned no JavaScript result envelope");
  if (!parsed.ok) {
    const error = new Error(`Safari JavaScript failed: ${parsed.error?.message || "Unknown error"}`);
    error.name = typeof parsed.error?.name === "string" ? parsed.error.name : "Error";
    error.kind = "infrastructure";
    throw error;
  }
  requireEvidence(Object.hasOwn(parsed, "value"), "Safari JavaScript result has no value");
  return parsed.value;
}

function numberList(raw, expectedLength) {
  const text = raw.trim();
  const values = text === "" ? [] : text.split(",").map(value => Number(value.trim()));
  requireEvidence(values.every(Number.isSafeInteger) && (expectedLength === undefined || values.length === expectedLength),
    "Safari returned malformed window identifiers or bounds");
  return values;
}

// This adapter implements the replay's small internal request interface. It is
// not a WebDriver server. It controls an ordinary Safari window through Safari's
// installed scripting dictionary and labels that transport in every session.
// Supplying command is an explicit unit-test seam. Production callers omit it,
// which enforces the hosted-desktop guard both at creation and on each request.
function createSafariAppleScript({ runDir, command } = {}) {
  requireEvidence(path.isAbsolute(runDir || ""), "Set an absolute Safari artifact directory");
  const injected = command !== undefined;
  requireEvidence(!injected || typeof command === "function", "Injected Safari command must be a function");
  if (!injected) assertHostedSafariEnvironment();
  const runCommand = command || (async (file, args) => {
    const { stdout } = await execute(file, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  });
  const apple = source => runCommand("/usr/bin/osascript", ["-e", `with timeout of 10 seconds\n${source}\nend timeout`]);
  let session = null;
  let browser = null;
  let queue = Promise.resolve();

  const metadata = async () => {
    if (!browser) {
      const browserVersion = (await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleShortVersionString", SAFARI_INFO])).trim();
      const browserBuild = (await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleVersion", SAFARI_INFO])).trim();
      requireEvidence(/^\d+(?:\.\d+)*$/.test(browserVersion) && browserBuild.length > 0, "Unable to read the installed Safari version");
      browser = { browserName: "safari", browserVersion, browserBuild, platformName: "macOS", transport: TRANSPORT,
        browserBundle: "/Applications/Safari.app", screenshotKind: SCREENSHOT_KIND, setWindowRect: true,
        automationWindow: false, javascriptPermission: "not-yet-probed" };
    }
    return { ...browser };
  };
  const owned = source => {
    requireEvidence(session && Number.isSafeInteger(session.windowId) && session.windowId > 0, "No owned Safari window");
    return apple(`tell application "Safari"\nif not (exists window id ${session.windowId}) then error "Owned Safari window no longer exists"\n${source}\nend tell`);
  };
  const evaluate = async (source, args) => decodeEnvelope(await owned(
    `return do JavaScript ${appleScriptString(scriptEnvelope(source, args))} in current tab of window id ${session.windowId}`));
  const closeOwned = async () => {
    requireEvidence(session, "No owned Safari session to close");
    await apple(`tell application "Safari"\nif exists window id ${session.windowId} then close window id ${session.windowId} saving no\nreturn "closed"\nend tell`);
    session = null;
  };

  async function routeRequest(method, route, body) {
    if (!injected) assertHostedSafariEnvironment();
    requireEvidence(typeof route === "string" && ["GET", "POST", "DELETE"].includes(method), "Unsupported Safari request");
    if (method === "GET" && route === "/status") return { ready: session === null, transport: TRANSPORT, browser: await metadata() };
    if (method === "POST" && route === "/session") {
      requireEvidence(session === null, "Ordinary Safari adapter already owns a session");
      requireEvidence(body?.capabilities?.alwaysMatch?.browserName?.toLowerCase() === "safari", "Ordinary Safari adapter only supports Safari");
      const capabilities = await metadata();
      const priorIds = numberList(await apple('tell application "Safari" to return id of every window'));
      const created = await apple('tell application "Safari"\nmake new document with properties {URL:"about:blank"}\nreturn id of front window\nend tell');
      const [windowId] = numberList(created, 1);
      requireEvidence(windowId > 0 && !priorIds.includes(windowId), "Safari did not create a new owned window");
      session = { id: randomUUID(), windowId };
      try {
        const nonce = randomUUID();
        requireEvidence(await evaluate("return arguments[0];", [nonce]) === nonce,
          "Safari Apple Events JavaScript permission probe returned the wrong nonce");
        await owned(`set index of window id ${windowId} to 1\nactivate`);
        return { sessionId: session.id, capabilities: { ...capabilities, ownedWindowId: windowId,
          javascriptPermission: "verified-by-nonce-probe" } };
      } catch (error) {
        try { await closeOwned(); }
        catch (cleanupError) { error.message += `; owned-window cleanup failed: ${cleanupError.message}`; }
        throw error;
      }
    }

    requireEvidence(session !== null, "Unknown Safari session");
    const prefix = `/session/${session.id}`;
    requireEvidence(route === prefix || route.startsWith(`${prefix}/`), "Unknown Safari session");
    const suffix = route.slice(prefix.length);
    if (method === "DELETE" && suffix === "") { await closeOwned(); return null; }
    if ((method === "GET" || method === "POST") && suffix === "/window/rect") {
      let setter = "";
      if (method === "POST") {
        requireEvidence(body && [body.x, body.y, body.width, body.height].every(Number.isSafeInteger) &&
          body.width > 0 && body.height > 0 && Number.isSafeInteger(body.x + body.width) && Number.isSafeInteger(body.y + body.height),
        "Expected integer Safari window bounds with positive dimensions");
        setter = `set bounds of window id ${session.windowId} to {${body.x},${body.y},${body.x + body.width},${body.y + body.height}}\n`;
      }
      const [left, top, right, bottom] = numberList(await owned(`${setter}return bounds of window id ${session.windowId}`), 4);
      requireEvidence(right > left && bottom > top, "Safari returned invalid window dimensions");
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    if (method === "POST" && suffix === "/url") {
      const url = loopbackURL(body?.url);
      await owned(`set URL of current tab of window id ${session.windowId} to ${appleScriptString(url)}`);
      const deadline = Date.now() + 15000;
      do {
        const state = await evaluate("return {url:location.href,ready:document.readyState};");
        if (state?.url === url && state.ready === "complete") return null;
        requireEvidence(Date.now() < deadline, "Ordinary Safari fixture navigation did not become ready");
        await pause(100);
      } while (true);
    }
    if (method === "POST" && suffix === "/execute/sync") return evaluate(body?.script, body?.args || []);
    if (method === "GET" && suffix === "/screenshot") {
      await owned(`return id of window id ${session.windowId}`);
      const file = path.join(runDir, `safari-desktop-${randomUUID()}.png`);
      await runCommand("/usr/sbin/screencapture", ["-x", "-t", "png", file]);
      const bytes = await fs.readFile(file);
      requireEvidence(bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        "Safari desktop capture did not produce a PNG");
      return bytes.toString("base64");
    }
    requireEvidence(false, "Unsupported ordinary Safari route");
  }

  return { transport: TRANSPORT, screenshotKind: SCREENSHOT_KIND,
    request(method, route, body) {
      const pending = queue.then(() => routeRequest(method, route, body));
      queue = pending.catch(() => {});
      return pending;
    } };
}

module.exports = { createSafariAppleScript, assertHostedSafariEnvironment, appleScriptString, scriptEnvelope, decodeEnvelope, loopbackURL };
