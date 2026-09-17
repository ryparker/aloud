const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parseArgs, freshPath, validateTree, verifyOutput, REQUIRED_DIST, STORY_ID, STORY_FILE } = require("../produce.cjs");

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "uswds-fixture-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function args() {
  return ["--repo", "/repo", "--work-dir", "/work", "--output", "/artifact", "--variant", "corrected"];
}

test("requires explicit variant and absolute paths; rejects ambiguous CLI arguments", () => {
  assert.equal(parseArgs(args()).variant, "corrected");
  assert.equal(parseArgs([...args(), "--offline"]).offline, true);
  for (const invalid of [args().slice(0, -2), [...args(), "--variant", "broken"], [...args(), "--unknown"],
    ["--repo", "relative", ...args().slice(2)], [...args().slice(0, -1), "arbitrary"]]) {
    assert.throws(() => parseArgs(invalid));
  }
});

test("fresh destinations resolve parent symlinks and reject existing files or directories", async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, "actual"));
  await fs.symlink(path.join(root, "actual"), path.join(root, "alias"));
  assert.equal(await freshPath(path.join(root, "alias", "new")), path.join(await fs.realpath(root), "actual", "new"));
  await assert.rejects(freshPath(path.join(root, "actual")), /existing path/);
  await fs.writeFile(path.join(root, "file"), "do not replace");
  await assert.rejects(freshPath(path.join(root, "file")), /existing path/);
  assert.equal(await fs.readFile(path.join(root, "file"), "utf8"), "do not replace");
});

test("archive input excludes symlinks, submodules, path traversal and generated dependencies", () => {
  const sha = "a".repeat(40);
  assert.doesNotThrow(() => validateTree(`100644 blob ${sha}\tpackage.json\0`));
  for (const entry of [
    `120000 blob ${sha}\tlink\0`, `160000 commit ${sha}\tsubmodule\0`,
    `100644 blob ${sha}\t../escape\0`, `100644 blob ${sha}\t/escape\0`,
    `100644 blob ${sha}\tfile\\escape\0`,
    ...["node_modules", "dist", "_site"].map(dir => `100644 blob ${sha}\t${dir}/stale\0`),
  ]) assert.throws(() => validateTree(entry));
});

async function sourceWithBuild(root) {
  for (const dir of ["dist", "_site"]) {
    for (const file of REQUIRED_DIST) {
      const target = path.join(root, dir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `fresh bytes for ${file}`);
    }
  }
  for (const file of ["iframe.html", "index.html"]) await fs.writeFile(path.join(root, "_site", file), "<html>fixture</html>");
  await fs.writeFile(path.join(root, "_site", "index.json"), JSON.stringify({ entries: { [STORY_ID]: { importPath: `./${STORY_FILE}` } } }));
}

test("build verification binds copied assets and the exact story identity", async t => {
  const root = await temporary(t);
  await sourceWithBuild(root);
  const verified = await verifyOutput(root);
  assert.match(verified.build.sha256, /^[a-f0-9]{64}$/);
  assert.equal(verified.build.fileCount, REQUIRED_DIST.length + 3);
  await fs.writeFile(path.join(root, "_site", "index.json"), JSON.stringify({ entries: { [STORY_ID]: { importPath: "./wrong-story.js" } } }));
  await assert.rejects(verifyOutput(root), /pinned teardown fixture/);
});

test("missing or empty CSS cannot pass when Gulp swallows a Sass compilation error", async t => {
  const root = await temporary(t);
  await sourceWithBuild(root);
  await fs.writeFile(path.join(root, "dist/css/uswds.css"), "");
  await assert.rejects(verifyOutput(root), /missing or empty/);
  await fs.rm(path.join(root, "dist/css/uswds.css"));
  await assert.rejects(verifyOutput(root), /ENOENT/);
});

test("stale static assets and build symlinks fail artifact verification", async t => {
  const root = await temporary(t);
  await sourceWithBuild(root);
  const font = REQUIRED_DIST.find(file => file.startsWith("fonts/"));
  await fs.writeFile(path.join(root, "_site", font), "stale font");
  await assert.rejects(verifyOutput(root), /differs from fresh dist/);
  await fs.copyFile(path.join(root, "dist", font), path.join(root, "_site", font));
  await fs.symlink(path.join(root, "dist/css/uswds.css"), path.join(root, "_site/extra-link.css"));
  await assert.rejects(verifyOutput(root), /symlink/);
});
