pub mod cache;
pub mod fingerprint;
pub mod fixture;
pub mod local_check;
pub mod session_doctor;

pub use cache::{
    doctor_cache_file, invalidate_cache, load_cache, save_cache, DoctorCacheRecord,
    DoctorMetricsRecord, ModelUsageInfo, DOCTOR_CACHE_TTL_SECS,
};
pub use fingerprint::{EnvironmentFingerprint, FingerprintBuilder};
pub use fixture::DoctorFixture;
pub use local_check::{run_fast_local_precheck, LocalCheckError};
pub use session_doctor::{
    run_preflight_static_checks, DoctorCheckItem, DoctorProbeContext, PreflightInfo,
    SessionDoctorReport,
};
