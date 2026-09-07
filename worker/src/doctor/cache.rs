use crate::doctor::session_doctor::SessionDoctorReport;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const DOCTOR_CACHE_TTL_SECS: u64 = 86_400; // 24 hours

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelUsageInfo {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thinking_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

impl ModelUsageInfo {
    pub fn from_json_value(val: Option<&serde_json::Value>) -> Option<Self> {
        let val = val?;
        let get_u64 = |k: &str| val.get(k).and_then(|v| v.as_u64());

        Some(Self {
            input_tokens: get_u64("input_tokens"),
            output_tokens: get_u64("output_tokens"),
            thinking_tokens: get_u64("thinking_tokens"),
            cache_read_tokens: get_u64("cache_read_tokens"),
            total_tokens: get_u64("total_tokens"),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorMetricsRecord {
    pub duration_ms: u64,
    pub model_usage: Option<ModelUsageInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DoctorCacheRecord {
    pub fingerprint: String,
    pub checked_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub ttl_seconds: u64,
    pub status: String,
    pub doctor_report: SessionDoctorReport,
    pub metrics: DoctorMetricsRecord,
    pub subitem_hashes: BTreeMap<String, String>,
}

impl DoctorCacheRecord {
    pub fn new(
        fingerprint: String,
        checked_at: DateTime<Utc>,
        doctor_report: SessionDoctorReport,
        metrics: DoctorMetricsRecord,
        subitem_hashes: BTreeMap<String, String>,
    ) -> Self {
        let expires_at = checked_at + chrono::Duration::seconds(DOCTOR_CACHE_TTL_SECS as i64);
        Self {
            fingerprint,
            checked_at,
            expires_at,
            ttl_seconds: DOCTOR_CACHE_TTL_SECS,
            status: "PASSED".to_string(),
            doctor_report,
            metrics,
            subitem_hashes,
        }
    }

    pub fn is_valid(&self, current_fingerprint: &str, now: DateTime<Utc>) -> bool {
        if self.fingerprint != current_fingerprint || self.status != "PASSED" {
            return false;
        }
        let elapsed = now.signed_duration_since(self.checked_at);
        if elapsed.num_seconds() < 0 || elapsed.num_seconds() >= DOCTOR_CACHE_TTL_SECS as i64 {
            return false;
        }
        true
    }
}

pub fn doctor_cache_file(workspace: &Path) -> PathBuf {
    workspace.join(".ceo").join("doctor").join("cache.json")
}

pub fn load_cache(workspace: &Path) -> Option<DoctorCacheRecord> {
    let path = doctor_cache_file(workspace);
    if !path.exists() {
        return None;
    }

    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice::<DoctorCacheRecord>(&bytes).ok()
}

pub fn save_cache(workspace: &Path, record: &DoctorCacheRecord) -> std::io::Result<()> {
    let path = doctor_cache_file(workspace);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json_bytes = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;

    let tmp_path = path.with_extension("tmp");
    let mut file = File::create(&tmp_path)?;
    file.write_all(&json_bytes)?;
    file.flush()?;
    fs::rename(tmp_path, path)?;

    Ok(())
}

pub fn invalidate_cache(workspace: &Path) -> std::io::Result<()> {
    let path = doctor_cache_file(workspace);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
