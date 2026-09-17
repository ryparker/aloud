const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { GUIDE_VERSION, sha256, requireEvidence } = require("./evidence.cjs");

const PATCH_ID = "guidepup-0.34.0-wait-before-voiceover-activation-v1";
const RELATIVE_PATH = "lib/macOS/VoiceOver/start.js";
const ORIGINAL_SHA256 = "c51a16b693020013cab9862942df951d70b388ea2e1bdbb2a9564602abddde44";
const PATCHED_SHA256 = "34d3047fa3a8124a866356c6340b30ed7f3d1b397e34bf41d22ec74ea4e39e29";
const MANIFEST_FIELDS = Object.freeze({ schemaVersion: 1, id: PATCH_ID, packageName: "@guidepup/guidepup",
  packageVersion: GUIDE_VERSION, relativePath: RELATIVE_PATH, originalSha256: ORIGINAL_SHA256, patchedSha256: PATCHED_SHA256 });

function patchSource(source) {
  requireEvidence(sha256(source) === ORIGINAL_SHA256, "Guidepup startup source does not match the pinned original bytes");
  const patched = source.replace('const activate_1 = require("../activate");',
    'const activate_1 = require("../activate");\nconst waitForRunning_1 = require("./waitForRunning");')
    .replace('    await (0, activate_1.activate)(Applications_1.Applications.VoiceOver, options);',
      '    await (0, waitForRunning_1.waitForRunning)(options);\n    await (0, activate_1.activate)(Applications_1.Applications.VoiceOver, options);');
  requireEvidence(sha256(patched) === PATCHED_SHA256, "Guidepup startup patch did not produce the reviewed bytes");
  return patched;
}

async function installedTarget(dependencyRoot) {
  requireEvidence(path.isAbsolute(dependencyRoot || ""), "Set absolute USWDS_AT_DEPENDENCY_ROOT");
  const load = createRequire(path.join(dependencyRoot, "package.json"));
  const packageFile = load.resolve("@guidepup/guidepup/package.json");
  const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
  requireEvidence(pkg.name === MANIFEST_FIELDS.packageName && pkg.version === GUIDE_VERSION, "Startup patch requires Guidepup 0.34.0");
  const target = path.join(path.dirname(packageFile), RELATIVE_PATH);
  requireEvidence((await fs.lstat(target)).isFile(), "Startup patch target must be an ordinary file");
  return target;
}

async function applyPatch(dependencyRoot, manifestPath) {
  requireEvidence(path.isAbsolute(manifestPath || ""), "Set an absolute startup patch manifest path");
  const target = await installedTarget(dependencyRoot);
  const patched = patchSource(await fs.readFile(target, "utf8"));
  // A fresh dependency install and manifest are required; never silently patch twice.
  try { await fs.lstat(manifestPath); throw new Error("Startup patch manifest already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifest = { ...MANIFEST_FIELDS, appliedAt: new Date().toISOString(),
    change: "Wait for the native VoiceOver process and AppleScript running state before activation. Existing readiness, capture and behavior checks remain required.",
    status: "experimental-compatibility-patch", upstreamRelease: false };
  const temporary = `${target}.guidepup-startup-patch.tmp`;
  await fs.writeFile(temporary, patched, { flag: "wx", mode: (await fs.stat(target)).mode });
  await fs.rename(temporary, target);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return verifyInstalledStartup(dependencyRoot, manifestPath);
}

async function verifyInstalledStartup(dependencyRoot, manifestPath = null) {
  const target = await installedTarget(dependencyRoot);
  const actualHash = sha256(await fs.readFile(target));
  if (!manifestPath) {
    requireEvidence(actualHash === ORIGINAL_SHA256, "Modified Guidepup startup requires the known compatibility patch manifest");
    return null;
  }
  requireEvidence(path.isAbsolute(manifestPath), "Startup patch manifest must be an absolute path");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  requireEvidence(Object.entries(MANIFEST_FIELDS).every(([key, value]) => manifest?.[key] === value) &&
    manifest?.status === "experimental-compatibility-patch" && manifest?.upstreamRelease === false &&
    Number.isFinite(Date.parse(manifest?.appliedAt)), "Startup compatibility patch manifest does not match the reviewed patch");
  requireEvidence(actualHash === PATCHED_SHA256, "Installed Guidepup startup bytes do not match the compatibility patch");
  return { ...manifest, manifestPath, manifestSha256: sha256(raw), verifiedTargetSha256: actualHash };
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    requireEvidence(process.platform === "darwin" && process.env.RUNNER_ENVIRONMENT === "github-hosted", "Install this patch only on the disposable hosted macOS runner");
    requireEvidence(path.isAbsolute(process.env.CI_EVIDENCE || ""), "Set absolute CI_EVIDENCE");
    const args = process.argv.slice(2);
    requireEvidence(args.length === 4 && args[0] === "--dependency-root" && args[2] === "--manifest", "Expected --dependency-root ABSOLUTE_PATH --manifest ABSOLUTE_PATH");
    console.log(JSON.stringify(await applyPatch(args[1], args[3]), null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { PATCH_ID, RELATIVE_PATH, ORIGINAL_SHA256, PATCHED_SHA256, MANIFEST_FIELDS, patchSource, applyPatch, verifyInstalledStartup };
