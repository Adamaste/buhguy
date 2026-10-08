# Local-first CI and GitHub Actions cost control

The repository runs substantial local checks before a PR is pushed. GitHub CI is an independent clean-environment safety gate, not the primary development/test loop.

## Local validation (Node.js 22)

```sh
npm ci
npm run check
npm run test:unit
npm run test:integration
```

The integration suite uses a disposable PostgreSQL 16 container when Docker is available, or `TEST_DATABASE_URL` targeting a dedicated throwaway test database. **Never use the production database for tests.** The default `npm test` remains available for backwards compatibility and the curated full suite.

For Android changes, use Java 17, Android SDK 35, Gradle 8.9 and from `android/buhguy-bank-collector` run `gradle --no-daemon testDebugUnitTest assembleDebug`. Release signing remains restricted to the protected master workflow with GitHub secrets.

## GitHub CI policy

- The lightweight `changes` job classifies changed paths and runs on PRs and master pushes.
- Non-documentation, non-Android changes run Node unit tests and the PostgreSQL integration suite **once each**. This suite includes the cases previously unique to `npm test`.
- Android changes run Android unit tests/debug build/signing-negative checks. Backend-only PRs do **not** build Android.
- Documentation-only changes skip the expensive jobs (the `changes` check still runs).
- Manual workflow dispatch runs the full test and Android jobs. A **signed release APK** is built only when `build_signed_apk=true` is explicitly selected on `master`; regular master pushes do not sign/build release APKs.
- Superseded PR workflow runs are canceled. Master runs are never auto-canceled.
- If the file-difference check fails or is incomplete, CI runs **both** test families rather than silently skipping a gate.
- A green relevant PR check is still required before merge. For release-critical code or a manual full preflight, dispatch the full workflow on master. Do not treat a skipped job as executed proof.
- Avoid pushing a sequence of partially-tested commits just to observe GitHub results; run local checks first and push once when ready.

This CI policy does not change production ingestion, financial writes, deployment, signing credentials, or database permissions. The separate current-state certification approval rules still apply.
