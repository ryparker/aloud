# Pinned modal fixture producer

This producer builds the corrected USWDS modal fixture and an explicit hybrid negative control in independent clean directories. It does not reuse historical `dist`, `_site`, or `node_modules` output, edit the source checkout, or run a browser or screen reader.

Requirements: Node.js 24, npm, Git, tar, sufficient disk space for a full USWDS install/build, and access to the locked npm dependencies. The Git object database must contain both revisions:

- Fixture/build source: `351b20c283528bcc88e442f42cbbc0edcafd4be5` from USWDS modal teardown work.
- Broken runtime: `2af5c54c3e3140cc44cefddf3444132a071405eb`, used only for `packages/usa-header/src/index.js` and `packages/usa-modal/src/index.js`.

The CLI fixes these revisions in reviewed code. Fetch them explicitly in the trusted CI producer job; a branch name or caller-supplied SHA cannot substitute another revision. This provenance records the chosen inputs, not an independent claim that a source checkout or artifact uploader is authorized. The CI workflow must establish repository, run, and artifact identity.

## Build both variants

Parent directories must already exist. Work and artifact paths must be absent, separate from each other, and outside the source repository. Each invocation creates its own source archive and locked dependency installation.

```sh
node accessibility-ci/fixtures/produce.cjs \
  --repo /absolute/uswds-source \
  --work-dir /absolute/builds/modal-corrected \
  --output /absolute/artifacts/modal-corrected \
  --variant corrected

node accessibility-ci/fixtures/produce.cjs \
  --repo /absolute/uswds-source \
  --work-dir /absolute/builds/modal-broken \
  --output /absolute/artifacts/modal-broken \
  --variant broken
```

Optional `--npm-cache /absolute/cache` shares npm's integrity-checked download cache. Optional `--offline` requires every necessary package to be cached; a cache miss fails. No dependency directories are copied or linked. Default installation uses the configured npm registry and respects the committed lockfile. Install hooks are disabled with `npm ci --ignore-scripts`; explicit builds then run `npm run build` and `npm run build:storybook -- --disable-telemetry`.

Each successful artifact contains:

```text
site/                    # Serve this directory to Safari
build-provenance.json     # Exact source, override, asset, environment and log hashes
logs/                    # Install, library build and Storybook command output
control.json             # Broken variant only
```

The manifest's `sourceRevision` always identifies the corrected fixture and build configuration. Corrected `kind` is `clean-source-build`, with an empty `runtimeOverrides` array. Broken `kind` is `hybrid-runtime-control`; each override records `{path, sourceRevision, sha256, replacedSha256}`. Broken `control.json` preserves the replay contract `{name, tree, ref, files}` and identifies the two old runtime files, not the entire build. Pass it as `USWDS_AT_CONTROL_MANIFEST` for broken replays.

`buildSha256` uses the same complete site digest function as the VoiceOver replay. It binds the produced bytes; byte-identical output across different operating systems, dependency toolchains, or build times is not asserted. Fresh generated CSS, JavaScript, sprite, font, Storybook page files and exact fixture index identity must exist. Static assets must match the freshly built library. This catches the current Gulp Sass task's behavior of logging some compilation errors without failing its task.

Failure returns a nonzero exit. Command logs remain under the new work directory; after source preparation, `failure.json` records the error. The producer writes `build-provenance.json` only after verification and copy-digest comparison. Consumers must reject incomplete artifacts without that manifest. Failed output is preserved for diagnosis; rerun with fresh paths.

## Device-free checks

```sh
node --test accessibility-ci/fixtures/test/*.test.cjs
```

These checks exercise path safety and output/provenance invariants. Synthetic files in unit tests do not establish accessibility correctness. Only the independent real Safari/VoiceOver calibration can establish whether this negative control is detected and the corrected fixture passes.
