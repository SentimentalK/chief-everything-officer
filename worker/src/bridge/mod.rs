pub mod acquisition;
pub mod client;
pub mod config;
pub mod controller;
pub mod delivery;
pub mod outbox;
pub mod protocol;
pub mod report;
pub mod result_delivery;
pub mod result_outbox;
pub mod state;

pub use acquisition::{acquire_one, AcquireError, AcquireOutcome};
pub use client::{BridgeClient, ClientError, ErrorKind};
pub use config::{
    load_api_key, resolve_config_path, resolve_config_path_from_env, ApiKey, BridgeConfig,
    ConfigError, ExpectedIdentity, ETC_BRIDGE_CONFIG,
};
pub use state::{
    AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase, ProcessIdentity,
    SafeStopError, StateError, STATE_SCHEMA_VERSION,
};
