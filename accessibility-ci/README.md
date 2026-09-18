# USWDS modal accessibility calibration

This experiment builds a corrected USWDS modal fixture and a historical broken runtime control, then compares their behavior using actual Safari and VoiceOver on a disposable macOS runner. It is a companion experiment on this fork branch, separate from Aloud's native Android/iOS commands.

The workflow is restricted to `ryparker/aloud` and the `ci/uswds-voiceover-pilot` branch. A push changing the workflow or tooling starts one bounded run. Its token has read-only repository and Actions permissions. It does not change required release checks or publish packages.

## Pinned fixture inputs

| Input | Revision | Interpretation |
| --- | --- | --- |
| Corrected fixture source | `351b20c283528bcc88e442f42cbbc0edcafd4be5` | Exact USWDS source archive, including the dedicated modal teardown story |
| Broken runtime source | `2af5c54c3e3140cc44cefddf3444132a071405eb` | Only modal and header JavaScript override the corrected fixture source |

The broken artifact is a hybrid control. Its provenance preserves both revisions and the overridden file identities; it is never described as a clean build of the older revision. Both artifacts are built from scratch with the pinned dependency lock and transferred to the macOS job by their immutable artifact IDs. The consumer verifies each directory digest against the producer job's output.

## Acceptance sequence

1. Run the corrected fixture once. Require all scoped assertions and observations to pass.
2. Run the broken control once. Require the intended `teardown.restores-background` product failure, real AT observations, valid target identity and complete cleanup. An unrelated failure or missing capture does not establish calibration.
3. Only after both controls behave as expected, execute nine more corrected runs. Preserve every result; do not retry failures into success.

The native reader receives an explicitly assisted starting position. The scenario checks AT activation, modal background isolation, teardown behavior and heading navigation/speech. It does not prove natural focus recovery, complete reader traversal or full speech delivery. Guidepup's command capture is partial and its public API does not distinguish stable termination from capture exhaustion.

Artifacts retain build inputs and hashes, dependency/profile information, actual OS/browser/reader versions, raw returned caption data, screenshots, actions, failures and cleanup state. The final calibration result and the CI job must both be inspected; a missing result cannot pass.

Hosted startup currently tests an explicit compatibility patch to Guidepup 0.34.0. It moves the existing native process/AppleScript readiness check before VoiceOver activation; no product assertion changes. The installer checks the original and patched file hashes, and every replay verifies and records its patch manifest. This is an experimental patched dependency, not an upstream Guidepup release. The recorded run below reached successful startup; broader reliability remains unproven.

## Observed hosted result

[Run 35288143228](https://github.com/ryparker/aloud/actions/runs/35288143228), tooling commit `b7bf12da7c8cb72270e533557b91aee7583f88a4`: all 69 tooling tests and both fixture builds passed. VoiceOver started for both fixtures, captured the opener phrase and activated the modal. Both attempts then remained inconclusive: modal-open speech was empty through 100 SDK polls. Cleanup succeeded, and teardown and repetitions did not run. No complete corrected scenario has passed.

[Run 35288889533](https://github.com/ryparker/aloud/actions/runs/35288889533), tooling commit `3819582b847d48f3062503838bf8687e7991fa36`, tested native VO-Space activation in a fresh replay. It reproduced the same empty modal-open capture in both fixtures. Startup, opener capture, activation and cleanup passed again; both scenario results remained inconclusive. The new method is recorded as `voiceover-keyboard-default-action`. All earlier observations are retained.

[Run 35293476597](https://github.com/ryparker/aloud/actions/runs/35293476597) retained raw native reads. The broken attempt returned only newlines for all 100 modal phrase reads, with no native errors; the corrected attempt failed startup. [Run 35294123940](https://github.com/ryparker/aloud/actions/runs/35294123940) started both readers and executed the separate diagnostic commands. Original modal captures remained empty. Requested native keyboard-focus speech identified the opener while DOM focus identified the modal button. Plain-focus and native-dialog controls did not establish their opener positions, so they do not provide a valid dialog comparison.

The next hosted experiment uses an ordinary Safari window through its AppleScript interface. A nonce probe verifies actual JavaScript permission, and results explicitly identify this transport and its full-desktop screenshots. The startup patch also bounds retries of only the observed activation error `(-600)` within the existing deadline. These changes test capture and startup hypotheses without changing the acceptance contract. See the [transport details](voiceover/README.md#ordinary-safari-transport-experiment). Any requested re-read remains separate and cannot replace automatic activation speech.

## Local checks

```sh
node --test accessibility-ci/voiceover/test/*.test.cjs accessibility-ci/fixtures/test/*.test.cjs
```

These checks run without a desktop, browser or installed screen reader. Real execution requires the workflow's disposable macOS desktop or an independently authorized dedicated test user. Guidepup setup changes desktop permissions and preferences and can leave profile trust and symlinks behind; do not run it on a normal working account as an incidental test.

The experiment is informational until real corrected/broken controls, repeated execution and independent expectation review establish its scope and reliability. It does not claim Section 508 conformance or satisfy all of USWDS issue #6925.

Full-desktop diagnostics now use `/usr/sbin/screencapture` and were captured successfully in runs 35293476597 and 35294123940. Earlier missing desktop captures remain recorded as missing evidence.

[Run 35295064401](https://github.com/ryparker/aloud/actions/runs/35295064401) verified the ordinary Safari adapter and JavaScript permission, and both VoiceOver startups and cleanup succeeded. Both attempts stopped at the opener sentinel because native focus remained on the toolbar despite the expected DOM active element. The next change adds bounded native web-content entry before the unchanged opener sentinel. Modal activation, teardown and repetitions have not yet been reached with this transport.
