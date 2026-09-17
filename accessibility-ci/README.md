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

Hosted startup currently tests an explicit compatibility patch to Guidepup 0.34.0. It moves the existing native process/AppleScript readiness check before VoiceOver activation; no product assertion changes. The installer checks the original and patched file hashes, and every replay verifies and records its patch manifest. This is an experimental patched dependency, not an upstream Guidepup release or a proven resolution until native execution succeeds.

## Local checks

```sh
node --test accessibility-ci/voiceover/test/*.test.cjs accessibility-ci/fixtures/test/*.test.cjs
```

These checks run without a desktop, browser or installed screen reader. Real execution requires the workflow's disposable macOS desktop or an independently authorized dedicated test user. Guidepup setup changes desktop permissions and preferences and can leave profile trust and symlinks behind; do not run it on a normal working account as an incidental test.

The experiment is informational until real corrected/broken controls, repeated execution and independent expectation review establish its scope and reliability. It does not claim Section 508 conformance or satisfy all of USWDS issue #6925.
