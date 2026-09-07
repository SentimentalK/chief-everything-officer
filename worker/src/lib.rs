pub mod config;
pub mod doctor;
pub mod executor;
pub mod observability;
pub mod receipt;
pub mod runner;
pub mod verifier;

pub use config::WorkerConfig;
pub use doctor::{
    run_preflight_static_checks, DoctorCheckItem, DoctorFixture, DoctorProbeContext, PreflightInfo,
    SessionDoctorReport,
};
pub use observability::{
    EventLogger, JobStage, LifecycleEvent, LogSource, ProcessLogger, StatusTracker,
    StreamEventDispatcher,
};
pub use receipt::{ReceiptError, TaskReceipt};
pub use runner::{Runner, RunnerError};
pub use verifier::{
    ArtifactClaim, BusinessOutcome, GenericVerifier, TaskVerificationReport, WorkspaceSnapshot,
};
