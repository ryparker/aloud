#!/usr/bin/env node
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { sha256 } = require("../voiceover/evidence.cjs");
const { buildDigest } = require("../voiceover/replay.cjs");

const exec = promisify(execFile);
const SOURCE_REVISION = "351b20c283528bcc88e442f42cbbc0edcafd4be5";
const CONTROL_REVISION = "2af5c54c3e3140cc44cefddf3444132a071405eb";
const RUNTIME_FILES = ["packages/usa-header/src/index.js", "packages/usa-modal/src/index.js"];
const STORY_FILE = "packages/usa-modal/src/usa-modal.stories.js";
const INPUT_FILES = ["package.json", "package-lock.json", ".storybook/main.js", STORY_FILE, ...RUNTIME_FILES];
const STORY_ID = "components-modal--test-teardown";
const REQUIRED_DIST = ["css/uswds.css", "css/uswds.min.css", "js/uswds.min.js", "img/sprite.svg",
  "fonts/source-sans-pro/sourcesanspro-regular-webfont.woff2"];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(args) {
  const options = { offline: false };
  const keys = { "--repo": "repo", "--work-dir": "workDir", "--output": "output", "--variant": "variant", "--npm-cache": "npmCache" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--offline") { options.offline = true; continue; }
    requireCondition(keys[arg] && args[index + 1] && !args[index + 1].startsWith("--"), `Unknown option or missing value: ${arg}`);
    requireCondition(options[keys[arg]] === undefined, `Duplicate option: ${arg}`);
    options[keys[arg]] = args[++index];
  }
  requireCondition(["corrected", "broken"].includes(options.variant), "--variant must be corrected or broken");
  for (const key of ["repo", "workDir", "output", ...(options.npmCache ? ["npmCache"] : [])]) {
    requireCondition(path.isAbsolute(options[key] || ""), `${key} must be an absolute path`);
    options[key] = path.resolve(options[key]);
  }
  return options;
}

function inside(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function freshPath(file) {
  const canonical = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  try { await fs.lstat(canonical); } catch (error) {
    if (error.code === "ENOENT") return canonical;
    throw error;
  }
  throw new Error(`Refusing to reuse an existing path: ${canonical}`);
}

async function git(repo, args, binary = false) {
  const { stdout } = await exec("git", ["-C", repo, ...args], {
    encoding: binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000,
  });
  return binary ? stdout : stdout.trim();
}

function validateTree(tree) {
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    requireCondition(match && ["100644", "100755"].includes(match[1]), "Source archive must contain only ordinary tracked files");
    const file = match[3];
    requireCondition(!path.posix.isAbsolute(file) && !file.split("/").includes("..") && !file.includes("\\"), "Invalid archive path");
    requireCondition(!["node_modules", "dist", "_site"].includes(file.split("/")[0]), `Tracked generated output is not allowed: ${file}`);
  }
}

async function inputRecord(repo, directory, file, revision) {
  const expected = await git(repo, ["show", `${revision}:${file}`], true);
  const actual = await fs.readFile(path.join(directory, file));
  requireCondition(actual.equals(expected), `Source file does not match declared revision: ${file}`);
  return { path: file, sourceRevision: revision, sha256: sha256(actual) };
}

async function prepareSource(options) {
  requireCondition(Number(process.versions.node.split(".")[0]) === 24, "This pinned fixture producer requires Node.js 24");
  const repo = await fs.realpath(options.repo);
  const workDir = await freshPath(options.workDir);
  const output = await freshPath(options.output);
  requireCondition(!inside(repo, workDir) && !inside(repo, output), "Work and artifact directories must be outside the source repository");
  requireCondition(!inside(workDir, output) && !inside(output, workDir), "Work and artifact directories must be separate");
  const revision = await git(repo, ["rev-parse", `${SOURCE_REVISION}^{commit}`]);
  requireCondition(revision === SOURCE_REVISION, "Corrected source revision mismatch");
  if (options.variant === "broken") requireCondition(await git(repo, ["rev-parse", `${CONTROL_REVISION}^{commit}`]) === CONTROL_REVISION, "Control revision mismatch");
  validateTree(await git(repo, ["ls-tree", "-rz", SOURCE_REVISION]));
  await fs.mkdir(workDir);
  const sourceDir = path.join(workDir, "source");
  await fs.mkdir(sourceDir);
  await fs.mkdir(path.join(workDir, "logs"));
  const archive = path.join(workDir, "source.tar");
  await git(repo, ["archive", "--format=tar", "-o", archive, SOURCE_REVISION]);
  await exec("tar", ["-xf", archive, "-C", sourceDir], { timeout: 60000 });
  const sourceInputs = [];
  for (const file of INPUT_FILES) sourceInputs.push(await inputRecord(repo, sourceDir, file, SOURCE_REVISION));
  const story = await fs.readFile(path.join(sourceDir, STORY_FILE), "utf8");
  for (const marker of ["TestTeardown", "test-authored-hidden", "test-before", "window.uswdsTest"]) {
    requireCondition(story.includes(marker), `Pinned modal fixture is missing ${marker}`);
  }
  const runtimeOverrides = [];
  if (options.variant === "broken") {
    for (const file of RUNTIME_FILES) {
      const original = sourceInputs.find(value => value.path === file);
      await fs.writeFile(path.join(sourceDir, file), await git(repo, ["show", `${CONTROL_REVISION}:${file}`], true));
      const replacement = await inputRecord(repo, sourceDir, file, CONTROL_REVISION);
      requireCondition(original.sha256 !== replacement.sha256, `Control override has no effect: ${file}`);
      runtimeOverrides.push({ ...replacement, replacedSha256: original.sha256 });
    }
  }
  return { ...options, repo, workDir, output, sourceDir, sourceInputs, runtimeOverrides,
    sourceTree: await git(repo, ["rev-parse", `${SOURCE_REVISION}^{tree}`]),
    sourceArchiveSha256: sha256(await fs.readFile(archive)) };
}

async function runCommand(file, args, context, label, timeout = 15 * 60 * 1000) {
  const logPath = path.join(context.workDir, "logs", `${label}.log`);
  const log = createWriteStream(logPath, { flags: "wx" });
  const startedAt = new Date().toISOString();
  process.stdout.write(`${label}: ${file} ${args.join(" ")}\n`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(file, args, { cwd: context.sourceDir, shell: false,
        env: { ...process.env, CI: "true", STORYBOOK_DISABLE_TELEMETRY: "1", npm_config_update_notifier: "false" }, timeout });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("error", reject);
      child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}, signal ${signal}); see ${logPath}`)));
    });
  } finally {
    await new Promise((resolve, reject) => { log.on("error", reject); log.end(resolve); });
  }
  return { command: [file, ...args], startedAt, completedAt: new Date().toISOString(), log: `logs/${label}.log`, logSha256: sha256(await fs.readFile(logPath)) };
}

async function requireNonempty(directory, relative) {
  const file = path.join(directory, relative);
  const stat = await fs.lstat(file);
  requireCondition(stat.isFile() && stat.size > 0, `Required generated artifact is missing or empty: ${relative}`);
  return { path: relative, sha256: sha256(await fs.readFile(file)), bytes: stat.size };
}

async function verifyOutput(sourceDir) {
  const dist = [];
  for (const file of REQUIRED_DIST) dist.push(await requireNonempty(path.join(sourceDir, "dist"), file));
  const siteDir = path.join(sourceDir, "_site");
  await requireNonempty(siteDir, "iframe.html");
  await requireNonempty(siteDir, "index.html");
  const index = JSON.parse(await fs.readFile(path.join(siteDir, "index.json"), "utf8"));
  requireCondition(index.entries?.[STORY_ID]?.importPath === `./${STORY_FILE}`, "Built Storybook index does not identify the pinned teardown fixture");
  for (const record of dist) {
    const served = await requireNonempty(siteDir, record.path);
    requireCondition(served.sha256 === record.sha256, `Storybook static asset differs from fresh dist: ${record.path}`);
  }
  return { siteDir, dist, build: await buildDigest(siteDir) };
}

async function produce(options) {
  let context;
  try {
    context = await prepareSource(options);
    const npmArgs = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    if (context.npmCache) npmArgs.push("--cache", context.npmCache);
    if (context.offline) npmArgs.push("--offline");
    const commands = [];
    commands.push(await runCommand("npm", npmArgs, context, "01-install"));
    await inputRecord(context.repo, context.sourceDir, "package-lock.json", SOURCE_REVISION);
    commands.push(await runCommand("npm", ["run", "build"], context, "02-build"));
    commands.push(await runCommand("npm", ["run", "build:storybook", "--", "--disable-telemetry"], context, "03-storybook"));
    for (const input of context.sourceInputs) await inputRecord(context.repo, context.sourceDir, input.path,
      context.runtimeOverrides.find(value => value.path === input.path)?.sourceRevision || SOURCE_REVISION);
    const verified = await verifyOutput(context.sourceDir);
    const npmVersion = (await exec("npm", ["--version"], { timeout: 10000 })).stdout.trim();
    const manifest = {
      schemaVersion: 1, kind: context.variant === "broken" ? "hybrid-runtime-control" : "clean-source-build",
      variant: context.variant, sourceRepository: "uswds/uswds", sourceRevision: SOURCE_REVISION,
      sourceTree: context.sourceTree, sourceArchiveSha256: context.sourceArchiveSha256,
      sourceInputs: context.sourceInputs, runtimeOverrides: context.runtimeOverrides,
      fixture: { id: STORY_ID, path: STORY_FILE },
      buildSha256: verified.build.sha256, buildFileCount: verified.build.fileCount,
      generatedAssets: verified.dist, commands,
      environment: { node: process.version, npm: npmVersion, platform: process.platform, arch: process.arch, kernel: os.release() },
      builtAt: new Date().toISOString(),
      limitations: ["The source revision identifies the fixture and build configuration; runtimeOverrides identifies control substitutions.",
        "The build digest binds the produced bytes; identical bytes across different build environments are not asserted.",
        "Build validation is not evidence of browser or assistive-technology behavior."]
    };
    await fs.mkdir(context.output);
    await fs.cp(verified.siteDir, path.join(context.output, "site"), { recursive: true, errorOnExist: true, force: false });
    requireCondition((await buildDigest(path.join(context.output, "site"))).sha256 === verified.build.sha256, "Artifact copy digest mismatch");
    await fs.cp(path.join(context.workDir, "logs"), path.join(context.output, "logs"), { recursive: true, errorOnExist: true, force: false });
    if (context.variant === "broken") await fs.writeFile(path.join(context.output, "control.json"), `${JSON.stringify({
      name: "modal-base", tree: "core-modal-teardown", ref: CONTROL_REVISION, files: RUNTIME_FILES,
    }, null, 2)}\n`, { flag: "wx" });
    await fs.writeFile(path.join(context.output, "build-provenance.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${context.variant}: ${manifest.buildSha256} (${manifest.buildFileCount} files)\n${context.output}\n`);
    return manifest;
  } catch (error) {
    if (context) await fs.writeFile(path.join(context.workDir, "failure.json"), `${JSON.stringify({ error: error.message, failedAt: new Date().toISOString() }, null, 2)}\n`);
    throw error;
  }
}

if (require.main === module) {
  if (process.argv.includes("--help")) process.stdout.write("node produce.cjs --repo ABSOLUTE_GIT_REPO --work-dir FRESH_ABSOLUTE_DIR --output FRESH_ABSOLUTE_DIR --variant corrected|broken [--npm-cache ABSOLUTE_DIR] [--offline]\n");
  else Promise.resolve().then(() => produce(parseArgs(process.argv.slice(2)))).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { SOURCE_REVISION, CONTROL_REVISION, RUNTIME_FILES, STORY_FILE, STORY_ID, REQUIRED_DIST,
  parseArgs, freshPath, validateTree, inputRecord, prepareSource, verifyOutput, produce };
