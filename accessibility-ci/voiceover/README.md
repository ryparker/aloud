# Scoped Safari and VoiceOver modal regression

This tooling promotes the earlier workspace pilot without modifying its code, dependencies, assets or historical results. It exercises one existing `components-modal--test-teardown` Storybook fixture with **actual Safari and VoiceOver controlled by Guidepup 0.34.0**. WebDriver remains the default transport; the hosted diagnostic experiment uses an ordinary Safari window through AppleScript, as described below.

The test checks that VoiceOver can activate the modal after explicit setup, the open modal isolates the background, and application teardown restores a background heading that VoiceOver can reach and speak. It also checks that authored hidden content stays hidden. It does not test a complete keyboard journey, natural focus restoration, duplicate announcements, all modal content, browser zoom, mobile AT or Section 508 conformance.

## What counts as evidence

Every required step retains VoiceOver's spoken-phrase log and its navigation item separately. DOM focus, current URL, foreground app identity, nonempty run token, screenshot and action timing are diagnostic evidence. Empty speech, stale fixture identity, another foreground app, wrong source, incomplete command collection, missing steps, inconsistent stored assertions and cleanup failures cannot pass. An identity-verified snapshot that shows a modal failing to open or teardown leaving the background hidden remains a product failure even when speech is absent; the missing speech remains a separate evidence limitation. A snapshot from the wrong target cannot establish a product defect.

Capture source is `voiceover-guidepup-caption`: VoiceOver caption output collected and processed by Guidepup during a native command. This is not microphone recording or proof that sound reached a speaker. The harness preserves the strings Guidepup returns without further normalization. Pinned Guidepup 0.34.0 cleans caption text and joins captured phrases; it does not expose the underlying raw polling samples.

The native command resolves after the library performs its capture loop. `spokenPhraseLog()` and `itemText()` subsequently read cached data; polling these getters cannot prove that actual speech has settled. The harness clears both caches, awaits the native command, and reads each cache once. It does not wrap native commands in `voiceOver.capture()`, which would queue nested work on the same client.

The result records `commandCompleted: true` only when the command resolves, with its observed duration. Capture metadata always says `terminationReason: "not-exposed"` and `speechCoverage: "partial"`. Guidepup does not distinguish a stable-caption stop from poll exhaustion in the public result. Its pinned policy uses a 50 ms base interval, 25 stable polls and at most 100 polls, with additional delays estimated from phrase length; there is no five-second total wall-time guarantee. Neither a resolved command nor an unchanged cached phrase establishes complete speech delivery, silence or absence of later announcements. This pilot can assert that a required phrase was observed; an absent required phrase remains inconclusive when capture truncation cannot be ruled out.

Setup and assistance are explicit in the action log:

1. Safari loads the fixture; JavaScript places keyboard focus on its opener.
2. VoiceOver moves its cursor to that focused opener. This must produce an opener speech sentinel.
3. VoiceOver activates the opener; no JavaScript click opens the modal.
4. JavaScript invokes the fixture lifecycle teardown, then places focus on `Previous page action`.
5. VoiceOver synchronizes to the assisted keyboard position, then uses its previous-heading command. The harness clears both caches after positioning and before heading navigation. This excludes earlier stored entries; it does not eliminate the library's limitations distinguishing repeated or delayed captions.

The final heading navigation is real AT behavior from an assisted starting position. It must not be reported as proof of independent AT discovery or natural focus recovery. Expectations require calibration against known broken and corrected builds before this becomes a required release check. The target after validation is automatic repeated execution, not permanent manual approval of covered runs.

## Device-free checks

```sh
cd /absolute/workspace/accessibility-ci/voiceover
npm test
```

Tests use synthetic records to verify evidence rules and artifact hashing. They do not load Guidepup, start Safari/VoiceOver, touch desktop settings, or constitute real AT passes. No dependency installation is needed for these checks on Node 22 or later.

## Dedicated Mac prerequisites

- Built modal Storybook fixture with the full commit SHA recorded. Existing corrected fixture source: `worktrees/core-modal-teardown`, tested revision `351b20c283528bcc88e442f42cbbc0edcafd4be5`. Recheck that checkout/build before use. `USWDS_AT_REVISION` is an explicit operator declaration, not an automatic assertion that an old `_site` matches current source.
- Static HTTP server on loopback serving exactly that build. The pilot expects `iframe.html` and `index.json`; downloaded same-origin browser resources must match local build bytes. External resources and symlinked build files are rejected.
- Safari **Settings → Developer → Allow remote automation** enabled by the runner operator. This tool never enables it and never calls `safaridriver --enable`.
- A separately started `/usr/bin/safaridriver --port 8773` process. Preflight only requests its status; it does not create a browser session or verify remote-automation permission.
- A dedicated, unlocked macOS desktop session with VoiceOver initially off and no existing Guidepup profile volume mounted. Preflight refuses to interrupt an existing reader/session. Avoid other work during real execution; Guidepup uses a mounted test profile, starts/stops VoiceOver, and Safari takes foreground focus.
- Accessibility/Automation permissions for the Node process as required by Guidepup, Safari and System Events. Grant through the normal OS flow. The generic Guidepup setup command is not required or executed here.
- The existing pinned Guidepup installation and downloaded test profiles, or an independently installed **exactly 0.34.0** package/profile pair. No `node_modules` or assets are copied into this directory.

**Guidepup setup has persistent effects in the test user's preferences.** Inspection of pinned 0.34.0 shows that startup adds a trusted portable-profile identifier to the local VoiceOver plist and creates portable-preference symlinks. Its stop path detaches the profile volume and removes its temporary shadow, but does not remove those trust/symlink entries. Use a dedicated macOS test user or an ephemeral CI desktop. Running on a normal user account needs permission for these specific changes and an independently reviewed restoration procedure if complete reversal is required; this harness does not claim or attempt complete preference restoration. Failed startup invokes the library's best-effort cleanup, which can swallow errors, so the harness independently verifies process and mount state and keeps failures nonpassing.

## Configure and preflight

```sh
export USWDS_AT_BUILD_DIR=/absolute/workspace/worktrees/core-modal-teardown/_site
export USWDS_AT_REVISION=351b20c283528bcc88e442f42cbbc0edcafd4be5
export USWDS_AT_DEPENDENCY_ROOT=/absolute/workspace/audits/2026-09-16/backlog-next/pilot/voiceover
export GUIDEPUP_SCREEN_READERS_PATH=/absolute/workspace/audits/2026-09-16/backlog-next/pilot/voiceover/assets
export USWDS_AT_OUTPUT_DIR=/absolute/workspace/research/aloud-accessibility-ci/evidence/voiceover-runs
export USWDS_AT_STORY='http://127.0.0.1:8774/iframe.html?id=components-modal--test-teardown&viewMode=story'
export USWDS_SAFARI_DRIVER=http://127.0.0.1:8773
node /absolute/workspace/accessibility-ci/voiceover/replay.cjs --preflight
```

Preflight is read-only: validates configuration and pinned dependency, reads OS/process state, hashes build bytes, checks served iframe/index bytes, and queries driver readiness. A successful preflight reports the exact build SHA-256, source revision remains the configured declaration, and no AT assertion has run. It cannot establish Safari's remote-automation permission, successful VoiceOver startup, available screen-reader permission, complete downloaded profile compatibility or speech capture. A failed preflight exits nonzero.

`USWDS_AT_DEPENDENCY_ROOT` points to a directory containing a normal package installation; omitted, the tool resolves from this directory. `GUIDEPUP_SCREEN_READERS_PATH` is always explicit. The package declares the exact optional peer dependency so device-free tests remain standalone.

## Execute after runner setup is authorized

Real replay requires `USWDS_AT_DEDICATED_SESSION=1`. This is an operator acknowledgment that the dedicated environment has been prepared; it is not user approval and must never substitute for required permission. Preflight does not require the flag and never activates AT. Do not set it merely to bypass the check on the user's current working desktop.

```sh
USWDS_AT_DEDICATED_SESSION=1 node /absolute/workspace/accessibility-ci/voiceover/replay.cjs
```

Each invocation writes a unique timestamped run directory under `USWDS_AT_OUTPUT_DIR`. Outputs cannot go inside this source directory. Schema version 2 `result.json` includes returned step speech, explicit partial-capture metadata, screenshot hashes, browser/OS/native VoiceOver/Guidepup/profile versions, build hash, loaded resource hashes, classified errors and cleanup state. It also records Guidepup's separate VoiceOver asset version; that package asset identifier is not misrepresented as the native VoiceOver version. `evidenceComplete` refers to the required pilot records, not exhaustive speech coverage; `speechCoverage` remains `partial-command-capture` even when the scoped scenario passes.

The build hash is a SHA-256 over sorted relative-file/hash pairs. Iframe and loaded resource bytes are compared to the static server before AT execution and after a successful scenario; build bytes must remain unchanged during the run. This is local provenance, not a signed CI attestation or protection against a malicious process able to rewrite both evidence and hashes. A release integration must bind source/build identity to trusted CI metadata.

Safari may request `/favicon.ico` without a declared icon. If that optional file is absent from the build and the server returns 404, the resource record explicitly stores that absence. A supplied icon, every other resource, external origin, and redirect still undergoes strict validation.

For an existing hybrid negative control, also set `USWDS_AT_CONTROL_MANIFEST` to its `control.json`. For example, `audits/2026-09-16/backlog-next/pilot/controls/modal-base/control.json` records runtime overrides from `2af5c54c3e3140cc44cefddf3444132a071405eb` for modal and header JS. Keep `USWDS_AT_REVISION` set to the independently established fixture-source revision, not that runtime-only ref. The output preserves the complete overlay manifest, its digest and its explicit hybrid interpretation. A copied control build is not a clean checkout of the override SHA; unknown fixture provenance must be resolved before claiming a passing comparison.

- `passed`, exit 0: all six scoped behavior assertions, three capture checkpoints, identity checks and cleanup succeeded.
- `failed`, exit 1: an observed behavior contradicted an assertion, regardless of its execution stage. The original defect remains `failed` if later cleanup also fails; `evidenceComplete: false` preserves the operational limitation.
- `inconclusive`, exit 1: missing capture, wrong target, unavailable setup, unverified provenance or incomplete cleanup prevented a passing record. Never convert this to a pass by omitting a step.

The tool does not silently retry a failing scenario or adjust expectations. Guidepup has startup/command retries internally, and its capture uses the poll limits described above. The public API provides no exhaustion/completeness signal; the harness records this limitation instead of inventing a quiet-period verdict. Screenshot failures are retained as infrastructure errors without preventing classification of captured product behavior. Ordinary errors trigger cleanup attempts and independent process/mount checks; forced process termination can prevent final output, which is missing evidence and cannot satisfy any gate.

For acceptance, preserve separate outputs for the current corrected and pinned broken builds, inspect that the broken build fails for the intended behavior, then repeat corrected runs. Record every inconclusive run. The historical `60/60` browser measurements do not apply to this new AT harness.

### Experimental startup compatibility patch

The hosted startup experiment uses Guidepup **0.34.0 plus a local compatibility patch**, not a new upstream release. `guidepup-startup-patch.cjs` accepts only the reviewed 0.34.0 startup file and inserts its existing native process/AppleScript readiness wait before activation. Patch version 2 also retries only activation errors reporting `Application isn’t running. (-600)` within the existing startup deadline. Process presence alone did not establish activation readiness in run [35293476597](https://github.com/ryparker/aloud/actions/runs/35293476597). Other activation errors still fail immediately; product scenarios are not retried. The later readiness check, capture rules, product assertions and cleanup checks remain required. This targets the observed `Application isn’t running. (-600)` launch failure; hosted run [35288143228](https://github.com/ryparker/aloud/actions/runs/35288143228) started VoiceOver and captured opener speech in both attempts. The full scenario remains inconclusive because modal-open speech was empty; broader startup reliability is not established.

After installing dependencies on the disposable hosted macOS runner, invoke `node accessibility-ci/voiceover/guidepup-startup-patch.cjs --dependency-root "$USWDS_AT_DEPENDENCY_ROOT" --manifest "$CI_EVIDENCE/guidepup-startup-patch.json"`, then set `USWDS_GUIDEPUP_PATCH_MANIFEST` to that absolute manifest path for replay/calibration. The manifest identifies the patch and both source hashes. Preflight checks the installed bytes against that manifest and records `environment.guidepupCompatibilityPatch`. Without a manifest, only the original pinned startup bytes are accepted. Installation refuses unknown versions, changed source or a second application; it does not change local developer tooling.

### Raw capture diagnostics

The hosted diagnostic experiment installs an exact-byte guarded Guidepup 0.34.0 native-read trace patch and records its manifest. Each fresh replay writes bounded raw stdout, stderr and native error metadata before SDK trimming or normalization. A sticky trace failure, truncated trace or malformed trace prevents a passing result. This observes the existing reads; it does not change the expected captions.

With `USWDS_AT_DIAGNOSTICS=1`, an empty modal-open capture is saved before any new commands. Separate diagnostic records then collect passive native phrase/cursor reads, an explicit describe-keyboard-focus command, and plain-focus/native-dialog controls. Requested output cannot replace the original activation capture. Probe progress, full-desktop screenshots and exact control HTML are retained. The controller allows up to five minutes per attempt in this mode and preserves all failures; normal attempts remain bounded at two minutes. Safari uses a verified 1280 by 900 outer window for comparisons.

### Ordinary Safari transport experiment

Set `USWDS_SAFARI_TRANSPORT=applescript` only on the prepared disposable GitHub-hosted macOS runner. This adapter uses Safari's native AppleScript interface to create an ordinary browser window, verify JavaScript execution with a fresh nonce, navigate to the loopback fixture, and run the same DOM observations and setup assistance. The workflow enables JavaScript from Apple Events on that disposable runner. A preference value alone does not establish permission: the actual nonce probe must succeed before the scenario starts. This transport does not require a Safari WebDriver process or remote-automation permission.

Each result records the actual installed Safari version, the explicit experimental transport, owned window identifier, verified JavaScript permission, and full-desktop screenshot provenance. Cleanup closes only the newly created window. Production execution refuses non-hosted or non-dedicated desktops. Preflight reads metadata without opening a window, and leaves the permission probe pending.

This comparison tests whether the observed native-focus mismatch also occurs in ordinary Safari. Apple's [WebDriver documentation](https://developer.apple.com/documentation/safari-developer-tools/webdriver/) describes the automation window's interaction glass pane, but the existing evidence does not establish it as the cause. Neither a transport change nor requested diagnostic speech can substitute for the original required AT captures. Corrected/broken calibration and ten corrected runs remain required.
