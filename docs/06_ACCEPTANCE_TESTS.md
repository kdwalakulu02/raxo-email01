# 06 — Concrete acceptance tests

These are instructions to implement tests, not test results. Every required row must pass before calling the software release complete.

## Test harness

Use node:test + assert. test/helpers.ts exports:

- createTestContext(): unique PostgreSQL schema in DB_TEST_URL, private temporary storage, fake clock and loaded synthetic form config.
- makePdf(label): small VALID PDF Buffer produced locally, no download.
- makeMultipart(fields, files): bounded multipart request builder.
- startSmtpPeer(behavior): controlled local SMTP peer for stage-specific failure injection.
- startClamdPeer(behavior): local deterministic framing/error peer.
- cleanup(): closes processes/pools and removes only that test's temp directory/schema.

Refuse cleanup unless database name contains _test and schema name starts test_. Do not truncate/drop other schemas, development records or Mailpit inboxes.

Integration tests inject dependencies into buildApp/worker, but must use real PostgreSQL and real private storage. At least one scanner test uses actual ClamAV; at least one mail test uses actual Mailpit. Failure peers supplement, not replace, those integrations.

Synthetic sample fields:
full_name="Alex Example", email="alex@example.test", position="Frontend Developer", portfolio="https://example.test/alex", message="Synthetic application — no real applicant data".
Demo PDF text: "Raxo Email synthetic CV fixture".

A generated valid PDF must include proper objects/xref offsets/trailer; simply prefixing random text with %PDF is not the valid fixture.

## Test assertions and location

| ID  | File suffix           | Action                                          | Must assert                                              |
| --- | --------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| U01 | unit.config           | Production + DEMO_MODE=true                     | Startup rejects before listen                            |
| U02 | unit.config           | Unknown config field, duplicate ID, bad address | Specific validation failure                              |
| U03 | unit.input            | CR/LF mail fields, path filename, script text   | Header injection rejected; text retained inertly         |
| U04 | unit.input            | PDF type mismatch, oversized UTF-8/code points  | Correct bounded rejection                                |
| U05 | unit.smtp-outcomes    | Explicit SMTP4xx/5xx                            | Safe retry versus failed                                 |
| U06 | unit.smtp-outcomes    | Unknown error/disconnect after DATA             | unknown, never safe retry                                |
| A01 | integration.accept    | Valid fields + one PDF                          | 202; one submission, attachment and queued notification  |
| A02 | integration.accept    | Same _submission_id concurrently twice          | Same receipt; one notification; no extra referenced file |
| A03 | integration.accept    | Same ID changed body/checksum                   | 409; original unchanged                                  |
| A04 | integration.accept    | Missing field/duplicate text/unknown _to        | 422; zero accepted record                                |
| A05 | integration.accept    | Raw total limit+1 and chunked limit+1           | 413; temp files cleaned                                  |
| A06 | integration.accept    | Sixth file or combined file bytes+1             | 413; no partial acceptance                               |
| A07 | integration.accept    | Force DB commit failure after staging           | No202, no committed record/job; orphan reclaimed         |
| A08 | integration.accept    | Honeypot at last multipart part                 | Generic receipt, no retained files/record/send           |
| A09 | integration.accept    | Invalid CAPTCHA/wrong origin                    | 422/403; no record/send                                  |
| A10 | integration.accept    | Final allowed rate slot concurrent              | One permitted increment; remainder429                    |
| A11 | integration.accept    | /send, /emails, /owner, production /demo/*      | 404                                                      |
| W01 | integration.worker    | One queued clean submission                     | One captured message; submitted state                    |
| W02 | integration.worker    | SMTP connection refused                         | retry_wait; submission/file survive                      |
| W03 | integration.worker    | SMTP positive acceptance                        | submitted, no delivered field/claim                      |
| W04 | integration.worker    | Test peer accepts DATA then drops response      | unknown; advancing clock never resubmits                 |
| W05 | integration.worker    | Crash after remote acceptance before DB update  | Expired submitting becomes unknown                       |
| W06 | integration.worker    | Crash in preparing before SMTP                  | Safe reclaim, one handoff                                |
| W07 | integration.worker    | Start second worker                             | Advisory lock prevents second sender                     |
| W08 | integration.worker    | Explicit transient rejection four retries       | Same Message-ID/MIME; initial+4 maximum attempts         |
| W09 | integration.worker    | Stale lease tries final state update            | Compare-and-swap rejects stale write                     |
| W10 | integration.worker    | File scan blocked/offline/stale                 | No SMTP call; visible state, bounded preparation retries |
| W11 | integration.worker    | Final MIME over configured cap                  | failed mime_too_large; record retained; no send          |
| C01 | integration.cli       | list/show/export valid record                   | Metadata/fields correct; checksum identical              |
| C02 | integration.cli       | Export blocked or missing file                  | No output; nonzero exit                                  |
| C03 | integration.cli       | Export to existing output or storage dir        | No overwrite/no modification                             |
| C04 | integration.cli       | Bad args, missing ID, offline DB                | Exit2,3,4 respectively                                   |
| R01 | integration.retention | Delete queued record                            | Tombstone immediate, no new handoff                      |
| R02 | integration.retention | Disk deletion fails once                        | cleanup_done=false then true after retry                 |
| R03 | integration.retention | 90-day boundary                                 | Only expired content removed                             |
| R04 | integration.retention | Orphan older24h vs referenced object            | Orphan removed, referenced object retained               |
| R05 | integration.retention | Repost ID after deletion within24h              | 410, no new notification                                 |
| S01 | integration.clamav    | Real generated clean PDF                        | Explicit complete OK and version stored                  |
| S02 | integration.clamav    | Protocol error/timeout/old signature            | Cannot become clean or exported                          |
| S03 | integration.clamav    | Harmless standard scanner detection fixture     | Blocked result, no notification                          |

Scanner detection fixture must follow upstream test guidance in isolated local tests. Do not distribute real malware or send the fixture externally.

## Integration evidence details

W01 parses raw captured MIME with mailparser. Compare:

- trusted From and To exactly;
- applicant email only in Reply-To;
- subject contains prefix and submission UUID;
- one attached PDF has the exact original SHA-256;
- plain-text body contains normalized synthetic fields;
- no URL fetch, arbitrary file path or HTML interpretation occurred.

W04/W05 must control actual SMTP protocol timing. Rejecting an arbitrary mocked Promise cannot prove post-DATA behavior. Record a clear test trace using synthetic IDs without AUTH/body dumps.

## Release gates

1. npm ci on a clean checkout.
2. npm run services:up and migrations; readiness failures visible.
3. npm run check with no required suite skipped.
4. npm run demo:verify with exact DB/Mailpit/CLI checksum assertions.
5. npm run check:release and a maintained secret scan on exact archive.
6. Fresh-checkout README quickstart verified.
7. README feature state and BUILD_STATUS evidence agree.
8. Source archive contains no runtime config/data, secrets, real applicant records or private planning packs.

No performance or Internet-deliverability test is required for this local component release. Do not claim those results.
