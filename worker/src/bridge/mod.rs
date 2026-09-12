pub mod acquisition;
pub mod client;
pub mod config;
pub mod controller;
pub mod protocol;
pub mod state;

pub use acquisition::{acquire_one, AcquireError, AcquireOutcome};
pub use client::{BridgeClient, ClientError, ErrorKind};
pub use config::{load_api_key, ApiKey, BridgeConfig, ConfigError, ExpectedIdentity};
pub use state::{
    AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase, ProcessIdentity,
    SafeStopError, StateError, STATE_SCHEMA_VERSION,
};
