use crate::config::FormConfig;
use crate::errors::{AppError, Result};
use crate::input::{ParsedInput, StagedAttachment};
use crate::storage::Storage;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Receipt {
    pub submission_id: Option<Uuid>,
    pub status: &'static str,
}

impl Receipt {
    pub fn received(id: Option<Uuid>) -> Self {
        Self { submission_id: id, status: "received" }
    }
}

#[derive(Serialize)]
struct FpAttachment<'a> {
    name: &'a str,
    size: u64,
    sha256: &'a str,
}
#[derive(Serialize)]
struct FpPayload<'a> {
    fields: &'a BTreeMap<String, Option<String>>,
    attachments: Vec<FpAttachment<'a>>,
}

pub fn compute_fingerprint(fields: &BTreeMap<String, Option<String>>, atts: &[StagedAttachment]) -> String {
    let mut sorted: Vec<&StagedAttachment> = atts.iter().collect();
    sorted.sort_by(|a, b| {
        a.original_name
            .cmp(&b.original_name)
            .then(a.size_bytes.cmp(&b.size_bytes))
            .then(a.sha256.cmp(&b.sha256))
    });
    let payload = FpPayload {
        fields,
        attachments: sorted
            .iter()
            .map(|a| FpAttachment { name: &a.original_name, size: a.size_bytes, sha256: &a.sha256 })
            .collect(),
    };
    hex::encode(Sha256::digest(serde_json::to_string(&payload).unwrap().as_bytes()))
}

fn delete_staged(storage: &Storage, atts: &[StagedAttachment]) {
    for a in atts {
        let _ = storage.delete(&a.storage_key, None);
    }
}

type ExistingRow = (Uuid, String, Option<DateTime<Utc>>, DateTime<Utc>);

/// Decides what an already-existing submission with the same client id means for this request.
fn judge_existing(existing: &ExistingRow, fingerprint: &str) -> Result<Receipt> {
    let (id, fp, deleted_at, created_at) = existing;
    if (Utc::now() - *created_at).num_milliseconds() > 24 * 60 * 60 * 1000 {
        return Err(AppError::new(
            "expired_submission_id",
            409,
            "Client submission ID expired (older than 24 hours). Please generate a new submission ID.",
        ));
    }
    if deleted_at.is_some() {
        return Err(AppError::new(
            "idempotency_conflict",
            410,
            "Submission was deleted and cannot be resubmitted.",
        ));
    }
    if fp == fingerprint {
        Ok(Receipt::received(Some(*id)))
    } else {
        Err(AppError::new(
            "idempotency_conflict",
            409,
            "A submission with this _submission_id already exists with different fields or attachments.",
        ))
    }
}

pub async fn accept_submission(
    parsed: &ParsedInput,
    form: &FormConfig,
    pool: &PgPool,
    storage: &Storage,
    message_id_domain: &str,
    initial_state: &str,
) -> Result<Receipt> {
    if parsed.is_honeypot {
        return Ok(Receipt::received(None));
    }
    let fingerprint = compute_fingerprint(&parsed.fields, &parsed.attachments);

    if let Some(cid) = parsed.client_submission_id {
        let existing: Option<ExistingRow> = sqlx::query_as(
            "SELECT id, fingerprint, deleted_at, created_at FROM submissions
             WHERE form_id = $1 AND client_submission_id = $2",
        )
        .bind(&form.id)
        .bind(cid)
        .fetch_optional(pool)
        .await?;
        if let Some(e) = existing {
            let r = judge_existing(&e, &fingerprint);
            delete_staged(storage, &parsed.attachments);
            return r;
        }
    }

    let submission_id = parsed.submission_id;
    let notification_id = Uuid::new_v4();
    let message_id = format!("<{}@{}>", Uuid::new_v4(), message_id_domain);

    let res = insert_all(pool, parsed, form, &fingerprint, submission_id, notification_id, &message_id, initial_state)
        .await;
    match res {
        Ok(Some(r)) => Ok(r),
        Ok(None) => {
            // concurrent insert with the same client id won the race
            let existing: Option<ExistingRow> = sqlx::query_as(
                "SELECT id, fingerprint, deleted_at, created_at FROM submissions
                 WHERE form_id = $1 AND client_submission_id = $2",
            )
            .bind(&form.id)
            .bind(parsed.client_submission_id)
            .fetch_optional(pool)
            .await?;
            let r = match existing {
                Some(e) => judge_existing(&e, &fingerprint),
                None => Err(AppError::new(
                    "service_unavailable",
                    500,
                    "Concurrent submission conflict could not locate existing submission record.",
                )),
            };
            delete_staged(storage, &parsed.attachments);
            r
        }
        Err(e) => {
            delete_staged(storage, &parsed.attachments);
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_all(
    pool: &PgPool,
    parsed: &ParsedInput,
    form: &FormConfig,
    fingerprint: &str,
    submission_id: Uuid,
    notification_id: Uuid,
    message_id: &str,
    state: &str,
) -> Result<Option<Receipt>> {
    let mut tx = pool.begin().await?;
    let fields = serde_json::to_value(&parsed.fields).unwrap();
    let snapshot = serde_json::to_value(form).unwrap();
    let inserted = sqlx::query(
        "INSERT INTO submissions (id, form_id, client_submission_id, fingerprint, fields, config_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (form_id, client_submission_id) DO NOTHING RETURNING id",
    )
    .bind(submission_id)
    .bind(&form.id)
    .bind(parsed.client_submission_id)
    .bind(fingerprint)
    .bind(fields)
    .bind(snapshot)
    .fetch_optional(&mut *tx)
    .await?;
    if inserted.is_none() {
        tx.rollback().await.ok();
        return Ok(None);
    }
    for a in &parsed.attachments {
        sqlx::query(
            "INSERT INTO attachments (id, submission_id, storage_key, original_name, size_bytes, sha256, scan_state, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())",
        )
        .bind(a.id)
        .bind(submission_id)
        .bind(&a.storage_key)
        .bind(&a.original_name)
        .bind(a.size_bytes as i64)
        .bind(&a.sha256)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO notifications (id, submission_id, message_id, state, attempt_count, prepare_failures,
           next_attempt_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, 0, now(), now(), now())",
    )
    .bind(notification_id)
    .bind(submission_id)
    .bind(message_id)
    .bind(state)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(Receipt::received(Some(submission_id))))
}
