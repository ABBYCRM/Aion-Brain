# Supply-chain audit addendum

Audit date: 2026-08-04

This addendum records the final dependency-install policy added after the main file-by-file report.

## Reviewed files

- `.npmrc`: enables `strict-allow-scripts`, npm audit, and disables funding output.
- `package.json`: pins npm `11.16.0`, requires npm 11, and approves only the reviewed native install script `better-sqlite3@12.11.1`.
- `.github/workflows/ci.yml`: installs the pinned npm version before the locked install on both Node 22 and Node 24.
- `package-lock.json`: regenerated under npm 11 after the policy change.

## Proof

Strict lock-refresh workflow run `30953339658`, job `92140501254`, completed all of the following successfully:

1. installed the pinned npm version;
2. regenerated the portable lockfile;
3. completed `npm ci` with `strict-allow-scripts=true`;
4. passed every syntax check;
5. passed 6/6 unit tests;
6. passed 18/18 real Express/SQLite smoke checks;
7. completed the production dependency audit;
8. committed the verified lockfile.

The one-time lock-refresh workflow was removed in commit `9aa38ef6b1d1b263731cfec68b3aaaef7b1ca27e`.

## Residual warning

`better-sqlite3@12.11.1` currently depends on deprecated `prebuild-install@7.1.3`. This is an upstream maintenance warning, not a reported vulnerability; the final dependency audit reports zero vulnerabilities. Replacing or removing that transitive package requires an upstream `better-sqlite3` release or a deliberate database-driver migration and is not represented as fixed here.

Final acceptance remains the clean Node 22/24 PR-head CI matrix after this addendum is committed.
