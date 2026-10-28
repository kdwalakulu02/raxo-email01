# Contributing

Read AGENTS.md and docs/01_LOCKED_SCOPE.md first. This repository is currently at specification stage.

Work on one numbered implementation ticket at a time. Do not add features outside the locked v0.1 scope.

A code pull request must state the concrete change, tests run, and remaining limitations. Use synthetic data. Do not include credentials, applicant records, raw runtime logs or private plans.

Changes to route names, field meanings, SQL schema, state transitions or attachment rules require matching contract/test updates. Never fix a failure by removing a required assertion.

Before release run npm run check, npm run demo:verify and npm run check:release once these scripts have been implemented. A missing DB/scanner is a failed dependency, not a silently skipped test.

No upstream project should be relabeled as Raxo work. Preserve dependency notices. The project makes no support response-time promise.
