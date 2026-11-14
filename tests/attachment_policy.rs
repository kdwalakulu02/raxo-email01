mod common;

use common::*;
use raxo_email::config::AttachmentPolicy;
use raxo_email::storage::Area;
use uuid::Uuid;

const CLEAN: &[u8] = b"%PDF-1.4 harmless quarterly report body";
const EICAR_PDF: &[u8] = b"%PDF-1.4 EICAR-STANDARD-ANTIVIRUS-TEST-FILE payload-bytes-AAAA";
const SUSPECT_PDF: &[u8] = b"%PDF-1.4 SUSPECT javascript launcher payload-bytes-BBBB";

async fn storage_keys(e: &Env, sid: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT storage_key FROM attachments WHERE submission_id = $1")
        .bind(sid)
        .fetch_all(&e.pool)
        .await
        .unwrap()
}

/// No attachment file of the submission is left in the clean or quarantine area.
async fn assert_attachment_files_purged(e: &Env, sid: Uuid) {
    for key in storage_keys(e, sid).await {
        assert!(!e.storage.exists(&key, Some(Area::Clean)), "clean attachment file must be removed");
        assert!(!e.storage.exists(&key, Some(Area::Quarantine)), "quarantined attachment file must be removed");
    }
}

async fn mime_key(e: &Env, nid: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT mime_key FROM notifications WHERE id = $1").bind(nid).fetch_one(&e.pool).await.unwrap()
}

fn only_message(e: &Env) -> Vec<u8> {
    let m = e.smtp.messages.lock().unwrap();
    assert_eq!(m.len(), 1, "exactly one email must be delivered");
    m[0].clone()
}

/// The withheld bytes (raw or base64) and their hash must never appear in a delivered message.
fn assert_not_leaked(msg: &[u8], content: &[u8]) {
    assert!(!contains_bytes(msg, content), "raw withheld content leaked");
    let enc = b64(content);
    assert!(!contains_bytes(msg, enc.as_bytes()), "base64 withheld content leaked");
    assert!(!contains_bytes(msg, sha(content).as_bytes()), "withheld sha256 leaked");
}

#[tokio::test(flavor = "multi_thread")]
async fn one_clean_attachment_is_delivered_without_notice() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "hello there", &[("report.pdf", CLEAN)]).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.outcome.as_deref(), Some("submitted"));
    assert_eq!(notif_state(&e, s.notification_id).await, "submitted");

    let msg = only_message(&e);
    assert_eq!(attached_filenames(&msg), vec!["report.pdf"]);
    assert!(contains_bytes(&msg, b64(CLEAN).as_bytes()), "clean content must be attached");
    assert!(!as_text(&msg).contains("SECURITY NOTICE"));
    assert!(!headers(&msg).contains("X-Raxo-Attachments-Withheld"));
    assert!(plain_body(&msg).contains("hello there"));

    let a = &att_rows(&e, s.submission_id).await[0];
    assert_eq!((a.scan_state.as_str(), a.disposition.as_str(), a.category.as_deref()), ("clean", "delivered", None));
    assert_eq!(verdicts(&e, s.submission_id).await, vec![("report.pdf".to_string(), "CLEAN".to_string())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn file_promoted_before_a_failed_commit_is_rescanned() {
    for (content, verdict, included) in [(CLEAN, "CLEAN", true), (EICAR_PDF, "DETECTED", false)] {
        let e = env(EnvOpts::default()).await;
        let s = seed(&e, "recovery", &[("report.pdf", content)]).await;
        let key: String = sqlx::query_scalar("SELECT storage_key FROM attachments WHERE submission_id = $1")
            .bind(s.submission_id)
            .fetch_one(&e.pool)
            .await
            .unwrap();
        e.storage.move_to_clean(&key).unwrap();
        assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
        assert_eq!(verdicts(&e, s.submission_id).await, vec![("report.pdf".to_string(), verdict.to_string())]);
        let msg = only_message(&e);
        assert_eq!(!attached_filenames(&msg).is_empty(), included);
        if !included {
            assert_not_leaked(&msg, content);
        }
        assert!(!e.storage.exists(&key, None), "attachment files are not kept after the MIME is built");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn quarantined_file_with_clean_database_state_is_rescanned() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "recovery", &[("report.pdf", EICAR_PDF)]).await;
    sqlx::query("UPDATE attachments SET scan_state = 'clean', scanned_at = now() WHERE submission_id = $1")
        .bind(s.submission_id)
        .execute(&e.pool)
        .await
        .unwrap();
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert_eq!(verdicts(&e, s.submission_id).await, vec![("report.pdf".to_string(), "DETECTED".to_string())]);
    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty());
    assert_not_leaked(&msg, EICAR_PDF);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_suspicious_attachment_is_withheld_and_email_still_delivered() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "please review", &[("invoice.pdf", EICAR_PDF)]).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.outcome.as_deref(), Some("submitted"), "email must still be delivered");
    assert_eq!(notif_state(&e, s.notification_id).await, "submitted");

    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty(), "no attachment may be delivered");
    assert_not_leaked(&msg, EICAR_PDF);
    let text = plain_body(&msg);
    assert!(text.contains("please review"), "body must be delivered");
    assert!(text.contains("SECURITY NOTICE: 1 attachment was withheld"));
    assert!(text.contains("invoice.pdf"));
    assert_eq!(headers(&msg).matches("X-Raxo-Attachments-Withheld: 1").count(), 1);

    let a = &att_rows(&e, s.submission_id).await[0];
    assert_eq!(
        (a.scan_state.as_str(), a.disposition.as_str(), a.category.as_deref()),
        ("blocked", "withheld", Some("flagged"))
    );
    assert_eq!(verdicts(&e, s.submission_id).await, vec![("invoice.pdf".to_string(), "DETECTED".to_string())]);
    // The withheld file is never promoted to the clean area and is not kept once the MIME exists.
    assert_attachment_files_purged(&e, s.submission_id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_clean_and_suspicious_delivers_only_clean() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "mixed", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF), ("odd.pdf", SUSPECT_PDF)]).await;
    run_once(&e).await.unwrap();
    assert_eq!(notif_state(&e, s.notification_id).await, "submitted");

    let msg = only_message(&e);
    assert_eq!(attached_filenames(&msg), vec!["good.pdf"]);
    assert!(contains_bytes(&msg, b64(CLEAN).as_bytes()));
    assert_not_leaked(&msg, EICAR_PDF);
    assert_not_leaked(&msg, SUSPECT_PDF);
    let text = plain_body(&msg);
    assert!(text.contains("SECURITY NOTICE: 2 attachments were withheld"));
    assert!(text.contains("  - bad.pdf") && text.contains("  - odd.pdf"));
    assert!(!text.contains("  - good.pdf") || text.contains("Retained attachments: 1"));
    assert_mime_balanced(&msg);
    let t = as_text(&msg);
    assert!(t.contains("Content-Type: multipart/mixed"), "attachments need multipart/mixed");
    assert!(t.contains("Content-Type: multipart/alternative"), "notice body is text+html alternatives");

    let rows = att_rows(&e, s.submission_id).await;
    let by = |n: &str| rows.iter().find(|r| r.name == n).unwrap();
    assert_eq!(by("good.pdf").disposition, "delivered");
    assert_eq!(by("bad.pdf").disposition, "withheld");
    assert_eq!(by("odd.pdf").disposition, "withheld");
    let v = verdicts(&e, s.submission_id).await;
    assert!(v.contains(&("good.pdf".into(), "CLEAN".into())));
    assert!(v.contains(&("bad.pdf".into(), "DETECTED".into())));
    assert!(v.contains(&("odd.pdf".into(), "SUSPICIOUS".into())));
}

#[tokio::test(flavor = "multi_thread")]
async fn scanner_unavailable_withholds_as_not_inspected_never_infected() {
    let e = env(EnvOpts { sentinel_up: false, ..Default::default() }).await;
    let s = seed(&e, "body text", &[("scan-me.pdf", CLEAN)]).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.outcome.as_deref(), Some("submitted"));

    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty(), "uninspected attachment must be withheld");
    assert_not_leaked(&msg, CLEAN);
    for body in [plain_body(&msg), html_body(&msg)] {
        let lower = body.to_lowercase();
        assert!(lower.contains("could not be inspected"), "must say it could not be inspected");
        assert!(!lower.contains("infected"), "must not describe an unscanned file as infected");
        assert!(!lower.contains("flagged by the security scanner"), "must not claim it was flagged");
        assert!(body.contains("scan-me.pdf"));
    }
    let a = &att_rows(&e, s.submission_id).await[0];
    assert_eq!(
        (a.scan_state.as_str(), a.disposition.as_str(), a.category.as_deref()),
        ("error", "withheld", Some("not_inspected"))
    );
    assert_eq!(verdicts(&e, s.submission_id).await, vec![("scan-me.pdf".to_string(), "ERROR".to_string())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn scanner_timeout_and_unscanned_and_error_verdicts_are_withheld_not_inspected() {
    let e = env(EnvOpts { sentinel_timeout_ms: 400, ..Default::default() }).await;
    let s = seed(
        &e,
        "verdicts",
        &[
            ("hang.pdf", b"%PDF-1.4 HANG forever"),
            ("unscan.pdf", b"%PDF-1.4 UNSCAN nested"),
            ("boom.pdf", b"%PDF-1.4 BOOM crash"),
        ],
    )
    .await;
    run_once(&e).await.unwrap();
    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty());
    let text = plain_body(&msg);
    assert!(text.contains("SECURITY NOTICE: 3 attachments were withheld"));
    assert!(!text.to_lowercase().contains("infected"));
    assert!(!text.contains("Flagged by the security scanner"));
    let v = verdicts(&e, s.submission_id).await;
    assert!(v.contains(&("hang.pdf".into(), "TIMEOUT".into())), "{v:?}");
    assert!(v.contains(&("unscan.pdf".into(), "UNSCANNED".into())), "{v:?}");
    assert!(v.contains(&("boom.pdf".into(), "ERROR".into())), "{v:?}");
    for r in att_rows(&e, s.submission_id).await {
        assert_eq!((r.disposition.as_str(), r.category.as_deref()), ("withheld", Some("not_inspected")));
    }
    let boom_error: Option<String> = sqlx::query_scalar(
        "SELECT r.error FROM scan_results r JOIN attachments a ON a.id = r.attachment_id
         WHERE a.submission_id = $1 AND a.original_name = 'boom.pdf'",
    )
    .bind(s.submission_id)
    .fetch_one(&e.pool)
    .await
    .unwrap();
    assert_eq!(boom_error.as_deref(), Some("internal_failure"), "an empty reported hash must keep the real error");
}

#[tokio::test(flavor = "multi_thread")]
async fn all_attachments_withheld_still_delivers_body_with_notice() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "only the body survives", &[("a.pdf", EICAR_PDF), ("b.pdf", SUSPECT_PDF)]).await;
    run_once(&e).await.unwrap();
    assert_eq!(notif_state(&e, s.notification_id).await, "submitted");
    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty());
    assert_not_leaked(&msg, EICAR_PDF);
    assert_not_leaked(&msg, SUSPECT_PDF);
    let t = as_text(&msg);
    assert!(t.contains("Content-Type: multipart/alternative"));
    assert!(!t.contains("multipart/mixed"), "no attachments => no multipart/mixed wrapper");
    assert_mime_balanced(&msg);
    assert!(plain_body(&msg).contains("only the body survives"));
    assert!(html_body(&msg).contains("only the body survives"));
    assert!(plain_body(&msg).contains("Retained attachments: 0"));
}

#[tokio::test(flavor = "multi_thread")]
async fn notice_text_is_professional_and_lists_categories() {
    let e = env(EnvOpts::default()).await;
    seed(&e, "m", &[("flagged-one.pdf", EICAR_PDF), ("unread.pdf", b"%PDF-1.4 BOOM")]).await;
    run_once(&e).await.unwrap();
    let msg = only_message(&e);
    let text = plain_body(&msg);
    assert!(text.contains("SECURITY NOTICE: 2 attachments were withheld"));
    assert!(text.contains("For your protection, 2 attachments were not delivered with this message."));
    assert!(text.contains("Flagged by the security scanner as potentially unsafe (1):\r\n  - flagged-one.pdf"));
    assert!(text.contains(
        "Could not be inspected, so withheld as a precaution (this does not mean the file is malicious) (1):\r\n  - unread.pdf"
    ));
    assert!(text.contains("contact the sender through another trusted channel"));
    let html = html_body(&msg);
    assert!(html.contains("<strong>SECURITY NOTICE: 2 attachments were withheld</strong>"));
    assert!(html.contains("<li>flagged-one.pdf</li>") && html.contains("<li>unread.pdf</li>"));
}

#[tokio::test(flavor = "multi_thread")]
async fn notice_escapes_html_and_blocks_header_injection() {
    let e = env(EnvOpts::default()).await;
    let nasty = "<img src=x onerror=alert(1)>\"&'.pdf";
    let crlf = "evil\r\nBcc: attacker@example.test\r\n.pdf";
    let bidi = "invoice\u{202E}fdp.exe";
    seed(&e, "<script>alert(1)</script> & body", &[(nasty, EICAR_PDF), (crlf, SUSPECT_PDF), (bidi, b"%PDF-1.4 BOOM")])
        .await;
    run_once(&e).await.unwrap();
    let msg = only_message(&e);
    let html = html_body(&msg);
    assert!(!html.contains("<img"), "raw tag must be escaped: {html}");
    assert!(!html.contains("<script"), "submission text must be escaped too");
    assert!(html.contains("&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;.pdf"));
    assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt; &amp; body"));
    assert!(!as_text(&msg).contains("\r\nBcc:"), "no injected header/line");
    assert!(!headers(&msg).to_lowercase().contains("bcc:"));
    let text = plain_body(&msg);
    assert!(text.contains("  - evilBcc: attacker@example.test.pdf"), "CR/LF stripped from display name: {text}");
    assert!(!text.contains('\u{202E}') && !html.contains('\u{202E}'), "bidi override removed");
    assert!(text.contains("invoicefdp.exe"));
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_text_only_notice_when_html_disabled() {
    let e = env(EnvOpts { notice_html: false, ..Default::default() }).await;
    seed(&e, "m", &[("x.pdf", EICAR_PDF), ("ok.pdf", CLEAN)]).await;
    run_once(&e).await.unwrap();
    let msg = only_message(&e);
    let t = as_text(&msg);
    assert!(!t.contains("text/html") && !t.contains("multipart/alternative"));
    assert!(plain_body(&msg).contains("SECURITY NOTICE: 1 attachment was withheld"));
    assert_eq!(attached_filenames(&msg), vec!["ok.pdf"]);
    assert_mime_balanced(&msg);
}

#[tokio::test(flavor = "multi_thread")]
async fn retries_resend_identical_mime_and_never_deliver_withheld() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(2), ..Default::default() }).await;
    let s = seed(&e, "retry me", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF)]).await;

    let r1 = run_once(&e).await.unwrap();
    assert_eq!(r1.outcome.as_deref(), Some("safe_retry"));
    assert_eq!(notif_state(&e, s.notification_id).await, "retry_wait");
    assert!(e.smtp.messages.lock().unwrap().is_empty());
    let scans_after_first = e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst);
    let sha1: String = sqlx::query_scalar("SELECT mime_sha256 FROM notifications WHERE id = $1")
        .bind(s.notification_id)
        .fetch_one(&e.pool)
        .await
        .unwrap();

    // Tamper: pretend the withheld file's row was flipped back to clean; it must stay undelivered.
    sqlx::query("UPDATE attachments SET scan_state = 'clean' WHERE submission_id = $1 AND original_name = 'bad.pdf'")
        .bind(s.submission_id)
        .execute(&e.pool)
        .await
        .unwrap();

    make_due(&e, s.notification_id).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("safe_retry"));
    let sha2: String = sqlx::query_scalar("SELECT mime_sha256 FROM notifications WHERE id = $1")
        .bind(s.notification_id)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    assert_eq!(sha1, sha2, "the persisted MIME is immutable across retries");
    make_due(&e, s.notification_id).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));

    assert_eq!(
        e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst),
        scans_after_first,
        "retries must not rescan or re-decide"
    );

    let msg = only_message(&e);
    assert_eq!(attached_filenames(&msg), vec!["good.pdf"]);
    assert_not_leaked(&msg, EICAR_PDF);
    let rows = att_rows(&e, s.submission_id).await;
    assert_eq!(rows.iter().find(|r| r.name == "good.pdf").unwrap().disposition, "delivered");
    assert_eq!(rows.iter().find(|r| r.name == "bad.pdf").unwrap().disposition, "withheld");
}

#[tokio::test(flavor = "multi_thread")]
async fn rebuild_after_lost_mime_keeps_withheld_sticky_without_rescan() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(1), ..Default::default() }).await;
    let s = seed(&e, "rebuild", &[("bad.pdf", EICAR_PDF)]).await;
    run_once(&e).await.unwrap();
    let scans = e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(scans, 1);

    // Simulate a crash that lost the persisted MIME pointer, and a scanner that is now down/changed.
    sqlx::query("UPDATE notifications SET mime_key = NULL, mime_sha256 = NULL WHERE id = $1")
        .bind(s.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
    make_due(&e, s.notification_id).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));

    assert_eq!(e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst), scans);
    let msg = only_message(&e);
    assert!(attached_filenames(&msg).is_empty());
    assert_not_leaked(&msg, EICAR_PDF);
    assert!(plain_body(&msg).contains("bad.pdf"));
}

#[tokio::test(flavor = "multi_thread")]
async fn rebuild_after_lost_mime_fails_closed_once_attachment_files_are_purged() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(1), ..Default::default() }).await;
    let s = seed(&e, "rebuild", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF)]).await;
    run_once(&e).await.unwrap();
    let scans = e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst);
    sqlx::query("UPDATE notifications SET mime_key = NULL, mime_sha256 = NULL WHERE id = $1")
        .bind(s.notification_id)
        .execute(&e.pool)
        .await
        .unwrap();
    make_due(&e, s.notification_id).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("attachment_integrity_error"));
    assert_eq!(notif_state(&e, s.notification_id).await, "failed");
    assert_eq!(e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst), scans);
    assert!(e.smtp.messages.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_files_are_removed_after_mime_build_and_mime_after_terminal_state() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(1), ..Default::default() }).await;
    let s = seed(&e, "purge", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF)]).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("safe_retry"));
    assert_attachment_files_purged(&e, s.submission_id).await;
    // The MIME must survive while the notification can still be retried.
    let key = mime_key(&e, s.notification_id).await.expect("MIME kept for retries");
    assert!(e.storage.exists(&key, Some(Area::Mime)));

    make_due(&e, s.notification_id).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    assert_eq!(attached_filenames(&only_message(&e)), vec!["good.pdf"]);
    assert!(!e.storage.exists(&key, Some(Area::Mime)), "terminal MIME must be removed");
    assert_eq!(mime_key(&e, s.notification_id).await, None);
    let mime_sha: Option<String> = sqlx::query_scalar("SELECT mime_sha256 FROM notifications WHERE id = $1")
        .bind(s.notification_id)
        .fetch_one(&e.pool)
        .await
        .unwrap();
    assert_eq!(mime_sha, None);
    // Metadata stays.
    let rows = att_rows(&e, s.submission_id).await;
    assert_eq!(rows.iter().find(|r| r.name == "good.pdf").unwrap().disposition, "delivered");
    assert_eq!(rows.iter().find(|r| r.name == "bad.pdf").unwrap().category.as_deref(), Some("flagged"));
    assert_eq!(verdicts(&e, s.submission_id).await.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn retention_sweep_removes_stragglers_but_keeps_files_of_held_unverified() {
    let e = env(EnvOpts::default()).await;
    let held = seed(&e, "held", &[("held.pdf", CLEAN)]).await;
    let cancelled = seed(&e, "cancelled", &[("c.pdf", CLEAN)]).await;
    let built = seed(&e, "built", &[("b.pdf", CLEAN)]).await;
    let (mime, digest) = e.storage.persist_mime(b"Subject: straggler\r\n\r\nbody\r\n").unwrap();
    for (id, state, key) in [
        (held.notification_id, "held_unverified", None),
        (cancelled.notification_id, "cancelled", None),
        (built.notification_id, "submitted", Some(&mime)),
    ] {
        sqlx::query("UPDATE notifications SET state = $1, mime_key = $2, mime_sha256 = $3 WHERE id = $4")
            .bind(state)
            .bind(key)
            .bind(key.map(|_| &digest))
            .bind(id)
            .execute(&e.pool)
            .await
            .unwrap();
    }
    raxo_email::retention::run_retention(&e.pool, &e.storage, chrono::Utc::now()).await.unwrap();

    for key in storage_keys(&e, held.submission_id).await {
        assert!(e.storage.exists(&key, Some(Area::Quarantine)), "held_unverified files are needed until verified");
    }
    assert_attachment_files_purged(&e, cancelled.submission_id).await;
    assert_attachment_files_purged(&e, built.submission_id).await;
    assert!(!e.storage.exists(&mime, Some(Area::Mime)));
    assert_eq!(mime_key(&e, built.notification_id).await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn exporting_a_purged_attachment_reports_it_is_not_retained() {
    let e = env(EnvOpts::default()).await;
    let s = seed(&e, "export", &[("good.pdf", CLEAN)]).await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    let scans = e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst);
    let out = e._dir.path().join("exported.pdf");
    let id = s.attachments[0].0.to_string();
    let output = run_cli(&e, &["attachments", "export", &id, "--out", out.to_str().unwrap()]).await;
    assert_eq!(output.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("Attachment content is not retained after the notification is built"));
    assert!(!out.exists());
    assert_eq!(e.sentinel.as_ref().unwrap().scans.load(std::sync::atomic::Ordering::SeqCst), scans, "no scan");
}

#[tokio::test(flavor = "multi_thread")]
async fn partially_inspected_clean_is_delivered_with_note_and_policy_files_are_withheld() {
    let e = env(EnvOpts::default()).await;
    let s = seed(
        &e,
        "partial",
        &[("huge.pdf", b"%PDF-1.4 PARTIAL many objects"), ("setup.exe", b"MZ POLICYEXE stub"), ("ok.pdf", CLEAN)],
    )
    .await;
    assert_eq!(run_once(&e).await.unwrap().outcome.as_deref(), Some("submitted"));
    let msg = only_message(&e);
    assert_eq!(attached_filenames(&msg), vec!["huge.pdf", "ok.pdf"]);
    assert_not_leaked(&msg, b"MZ POLICYEXE stub");
    assert!(headers(&msg).contains("X-Raxo-Attachments-Withheld: 1"));
    assert!(headers(&msg).contains("X-Raxo-Attachments-Partially-Inspected: 1"));
    let text = plain_body(&msg);
    assert!(text.contains("SECURITY NOTICE: 1 attachment was withheld"));
    assert!(text.contains("Not accepted by this form's file-type policy (executables, scripts, disk images and macro-enabled documents are not delivered) (1):\r\n  - setup.exe"));
    assert!(text.contains("Delivered, but could only be partially inspected by the security scanner (for example a very large or unusual document). Treat it with normal caution. (1):\r\n  - huge.pdf"));
    assert!(!text.contains("Flagged by the security scanner"));
    let html = html_body(&msg);
    assert!(html.contains("file-type policy") && html.contains("<li>setup.exe</li>"));
    assert!(html.contains("partially inspected") && html.contains("<li>huge.pdf</li>"));

    let rows = att_rows(&e, s.submission_id).await;
    let by = |n: &str| rows.iter().find(|r| r.name == n).unwrap();
    assert_eq!(by("huge.pdf").disposition, "delivered");
    assert_eq!(
        (
            by("setup.exe").scan_state.as_str(),
            by("setup.exe").disposition.as_str(),
            by("setup.exe").category.as_deref()
        ),
        ("blocked", "withheld", Some("policy"))
    );
    let incomplete: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT a.original_name, r.incomplete FROM scan_results r JOIN attachments a ON a.id = r.attachment_id
         WHERE a.submission_id = $1 ORDER BY a.original_name",
    )
    .bind(s.submission_id)
    .fetch_all(&e.pool)
    .await
    .unwrap();
    assert_eq!(
        incomplete,
        vec![
            ("huge.pdf".into(), Some("too_many_pdf_objects".into())),
            ("ok.pdf".into(), None),
            ("setup.exe".into(), None)
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_scanner_failure_can_be_retried_before_withholding() {
    let e = env(EnvOpts { sentinel_up: false, scan_retries: 1, ..Default::default() }).await;
    let s = seed(&e, "m", &[("a.pdf", CLEAN)]).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.status, "retry_wait");
    assert_eq!(notif_state(&e, s.notification_id).await, "retry_wait");
    assert!(e.smtp.messages.lock().unwrap().is_empty());
    assert_eq!(att_rows(&e, s.submission_id).await[0].disposition, "pending");
    make_due(&e, s.notification_id).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.outcome.as_deref(), Some("submitted"));
    assert_eq!(att_rows(&e, s.submission_id).await[0].disposition, "withheld");
    assert!(attached_filenames(&only_message(&e)).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn block_message_policy_keeps_legacy_whole_message_block() {
    let e = env(EnvOpts { policy: AttachmentPolicy::BlockMessage, ..Default::default() }).await;
    let s = seed(&e, "m", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF)]).await;
    let r = run_once(&e).await.unwrap();
    assert_eq!(r.status, "blocked");
    assert_eq!(notif_state(&e, s.notification_id).await, "blocked");
    assert!(e.smtp.messages.lock().unwrap().is_empty(), "nothing is delivered under block_message");
    assert_attachment_files_purged(&e, s.submission_id).await;
    assert!(e.storage.list_keys(Area::Mime).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn smtp_unavailable_keeps_withheld_decision_and_nothing_is_marked_delivered() {
    let e = env(EnvOpts { smtp: SmtpMode::TempFailFirst(99), ..Default::default() }).await;
    let s = seed(&e, "m", &[("good.pdf", CLEAN), ("bad.pdf", EICAR_PDF)]).await;
    run_once(&e).await.unwrap();
    let rows = att_rows(&e, s.submission_id).await;
    assert_eq!(rows.iter().find(|r| r.name == "good.pdf").unwrap().disposition, "included");
    assert_eq!(rows.iter().find(|r| r.name == "bad.pdf").unwrap().disposition, "withheld");
}
