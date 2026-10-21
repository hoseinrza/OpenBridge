# Mobile QA and real CI/CD pipeline

Date: 2026-10-21
Status: approved in chat, ready for implementation

## Context

`ci.yml` has executed on GitHub Actions successfully (the run on `0c5ce48`
completed with every blocking job green, including the Docker compose smoke
test). The pipeline gap is different from what the old docs claimed:

- `deploy.yml` has never run a deployment. Every `workflow_run` attempt is
  `skipped` because `vars.DEPLOY_ENABLED` is not `true`; no SSH secrets exist.
  The production path that is only validated with stubbed `docker`/`curl`
  remains the VPS redeploy/rollback logic in `deploy.sh`.
- The mobile client has no automated tests at all. README states that screen QA
  is manual, and the Expo job only proves that the Hermes bundle builds.
- `DEPLOY.md` still claims the pipeline has never run on GitHub Actions.

The user does not want a production server deployment in this batch. The goal
is to have real automated mobile QA and a real GitHub Actions pipeline in the
repository, with the CD arm honestly documented as opt-in.

## Goals

1. Add a fast automated mobile test layer that runs on every push and PR.
2. Add a real on-device Android UI test layer that runs on `main`, on mobile
   PRs, nightly, and on demand.
3. Keep one required CI gate. The slow emulator job must not block web-only PRs.
4. Correct the documentation so it matches the observable repository state.
5. Ship as version 1.1.11 with a changelog entry.

## Non-goals

- No deployment to the VPS or any production server in this batch.
- No SMS provider, no production OTP changes.
- No iOS simulator job.
- No visual-regression screenshot comparison. Maestro captures screenshots as
  artifacts for inspection, not as pixel-diff assertions.
- No seeded or demo data in the shipped app or in production. E2E fixtures
  exist only in the disposable CI database.

## Architecture

### 1. Unit and component tests — Jest + React Native Testing Library

Files:

- `mobile/jest.config.js` — `jest-expo` preset, `setupFilesAfterEnv`.
- `mobile/jest.setup.js` — mocks for `expo-secure-store`,
  `@react-native-async-storage/async-storage`, `@expo/vector-icons`,
  `react-native-safe-area-context`, and the socket context.
- `mobile/__tests__/` — test files.
- `mobile/package.json` — `"test": "jest"` and
  `"test:ci": "jest --ci --runInBand"`.

Pinned dependencies (Expo SDK 57 line):

- `jest@29.7.0` (jest-expo 57 is built on the Jest 29 toolchain)
- `jest-expo@~57.0.6`
- `@testing-library/react-native@~13.3.3`
- `react-test-renderer@19.2.3` (matches `react@19.2.3`)

Test coverage:

- `utils/phone`: Persian/Arabic digits, `+98`/`0098`/`98` prefixes, the
  10-digit `9...` form, separators, and invalid inputs.
- `utils/time`: `dayKey`, today/yesterday labels, and conversation timestamps.
- `LoginScreen` inside the real `AuthProvider`, with the API service and
  storage mocked:
  - invalid phone number shows the validation error and sends no request;
  - requesting a code moves to the code step and displays the test code;
  - verifying an existing user persists the session and renders the signed-in
    probe;
  - a new user continues to username and name, rejects invalid values, and
    completes signup;
  - a failed verification surfaces the server message.
- `ChatListScreen`, with the API and auth/socket hooks mocked:
  - loaded rows render names and unread counts;
  - search filters by name and username;
  - empty and error states render.
- `ChatScreen`, with `useChat` mocked:
  - own and peer messages render on the correct side;
  - typing and pressing send calls `sendMessage` and clears the composer;
  - a failed send shows the error;
  - long-press opens the reaction picker and choosing an emoji calls
    `toggleReaction`;
  - a disconnected socket disables sending.

The suite is behavioral, not snapshot-based. It runs in the `mobile-tests` CI
job (about 2–3 minutes) on every push and PR.

### 2. On-device E2E — Maestro on an Android emulator

CI build of the app:

- `npx expo prebuild --platform android --no-install` in the job.
- Build a **release** APK: `assembleRelease` is signed with the generated debug
  keystore in the Expo template, and unlike a debug build it packages the JS
  bundle instead of waiting for Metro / showing the dev-client launcher.
- The CI-only E2E APK gets `android:usesCleartextTraffic="true"` added to the
  generated main manifest, because the emulator talks to the backend at
  `http://10.0.2.2:3000`. This patch is applied in the workflow, never
  committed, and never reaches a production build.
- `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api` is set for the Gradle bundle.

Backend in the job:

- `postgres:16-alpine` service with a health check.
- `backend` `npm ci`, `prisma generate`, `prisma db push`, `nest build`, then
  `node dist/main` on port 3000 with `NODE_ENV=test` (so OTP test mode returns
  the code) and a CI-only `JWT_SECRET`.
- `backend/test/mobile-e2e-seed.mjs` waits for `/api/health`, signs up two
  fixed CI-only users through the real OTP endpoints, and creates one group
  (`E2E Group`) with both. It prints nothing secret and is only invoked by the
  workflow.

Maestro flow (`mobile/.maestro/auth-and-chat.yaml`):

1. Launch with `clearState: true`.
2. Enter the seeded phone number and request a code.
3. `copyTextFrom` the test-code element, paste it into the OTP field, verify.
4. Assert the chat list contains `E2E Group`, open it.
5. Type an ASCII message and send it; assert the bubble text.
6. Long-press the sent bubble, tap the 👍 option, assert the chip.
7. Take a screenshot artifact.

ASCII is used for typed message text because Android's ADB text input does not
carry Persian reliably; the Persian UI labels are still asserted by Maestro.

Required `testID`s (added to the app, harmless in production):

- `login-phone`, `login-request-code`, `login-code`, `login-test-code`,
  `login-submit`
- `composer-input`, `composer-send`
- `reaction-option-<emoji>`

Job mechanics:

- Ubuntu runner, JDK 17, Android SDK/emulator API 34 (`google_apis`, x86_64,
  Pixel 6 profile), KVM permissions enabled before the emulator action.
- `ReactiveCircus/android-emulator-runner@v2` installs the APK and runs
  Maestro.
- Maestro CLI is pinned to `2.11.0` and downloaded from its GitHub release
  (`maestro.zip`), not installed by an unpinned shell script.
- Gradle caches are restored with `actions/cache`.
- On failure, upload the Maestro report, screenshots, and `adb logcat`.

### 3. CI triggers, jobs, and the gate

`ci.yml` additions:

- `changes` job: on `push` to `main` (and `workflow_dispatch`, `schedule`) the
  mobile job always runs; on pull requests it runs only when the diff touches
  `mobile/`, `shared/e2ee/`, or the workflow itself.
- `mobile-tests` job: always runs in parallel with the static jobs; added to
  `ci-gate`.
- `mobile-e2e` job: `needs: [changes, mobile-tests]`,
  `if: needs.changes.outputs.mobile == 'true'`, timeout 60 minutes.
- `ci-gate` accepts `mobile-e2e: skipped` **only** when
  `changes.mobile != 'true'`; any failure or an unexpected skip fails the gate.
- Concurrency keeps cancelling superseded pull-request runs but does not cancel
  a main-branch run mid-flight, so a long E2E is not killed by the next push.

Workflow triggers:

- `push` to `main`: all jobs.
- `pull_request`: fast jobs plus E2E when mobile/shared files changed.
- `schedule` (nightly): the workflow runs on a clean `main`, with the E2E as
  the main reason, catching environment drift (emulator images, Maestro, Expo
  toolchain) even when nobody pushes.
- `workflow_dispatch`: everything.

### 4. CD documentation, not a deployment

`deploy.yml` keeps its current behavior. No server deployment happens in this
batch, so the job will continue to report `skipped`. The docs will state:

- CI has run and is green on GitHub Actions; the table includes the mobile
  jobs.
- CD is armed but deliberately inert until `DEPLOY_ENABLED=true` and
  `SSH_HOST`/`SSH_USER`/`SSH_KEY` exist.
- The only unproven part is the SSH redeploy/rollback on a real VPS; the
  Docker/compose/nginx/socket path is exercised for real by `deploy-dry-run`.

### 5. Version and documentation

- Version `1.1.11` in root `package.json`, `backend/package.json`,
  `mobile/package.json`, and `mobile/app.json`.
- `CHANGELOG.md` entry with what changed, tests run, and known limits.
- `README.md`: replace the "mobile QA is manual" sentence, add the automated
  commands, update the CI table and the CD status.
- `DEPLOY.md`: remove the stale "has not run on GitHub Actions" note and
  replace it with the observed state and the remaining server prerequisite.

## Failure handling

- Jest failures block every push/PR through `mobile-tests` and `ci-gate`.
- Maestro flakiness: one retry of the flow, then fail; artifacts are uploaded
  even on failure so the cause is visible.
- Emulator boot/installation failure is a hard failure of `mobile-e2e`, not a
  silent skip, when the job is selected to run.
- The seed script is idempotent within a fresh CI database; it is not intended
  for local databases that already contain the E2E users.

## Verification

Local (this machine):

- `cd mobile && npm test` green.
- `npm run test:e2ee` (unchanged) and `npm run lint` (web) stay green.
- `cd mobile && npx expo export --platform android` still bundles.

CI (after push):

- The public GitHub API is polled for the new run.
- `mobile-tests` and `mobile-e2e` must be `success`; `ci-gate` must be
  `success`; `Deploy` must remain `skipped` (no server in this batch).
- If a job fails, the jobs API exposes per-step conclusions; failures are
  fixed and pushed until the run is green. Job logs require authentication, so
  the user may be asked for `gh auth` if a step-level diagnosis is not enough.
- Local APK build is not a verification step: this machine has JDK 25 and no
  AVD, while the CI uses JDK 17 and a fresh emulator.

## Risks

- First Gradle build on CI is expected to take 20–30 minutes; caching helps
  subsequent runs.
- Emulator jobs are the most common source of flakiness. Pinning API 34,
  disabling animations, and one retry are the mitigations.
- `expo prebuild` is generated in the job, so a future Expo SDK bump can change
  the manifest/Gradle layout; the cleartext patch step must be revisited then.
- The worktree contains unrelated E2EE/upload work in progress. Only files from
  this batch are staged and committed.
