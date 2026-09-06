pub mod adapter_trait;
pub mod agentapi;
pub mod agy_headless;
pub mod process;
pub mod test_stub;

pub use adapter_trait::{
    ExecutionRequest, ExecutorAdapter, ExecutorError, ExecutorMetadata, ManagedProcess,
};
pub use agentapi::AgentapiAdapter;
pub use agy_headless::AgyHeadlessAdapter;
pub use process::GroupManagedProcess;
pub use test_stub::TestStubAdapter;

use crate::config::{ExecutorType, WorkerConfig};

pub fn create_executor(config: &WorkerConfig) -> Box<dyn ExecutorAdapter> {
    match config.executor_type {
        ExecutorType::Agentapi => Box::new(AgentapiAdapter::new()),
        ExecutorType::TestStub => Box::new(TestStubAdapter::new(config.agent_executable.clone())),
        ExecutorType::AgyHeadless => {
            let bin_str = config.agent_executable.to_string_lossy();
            if bin_str.ends_with("agentapi") {
                Box::new(AgentapiAdapter::new())
            } else if bin_str.contains("test_stub") {
                Box::new(TestStubAdapter::new(config.agent_executable.clone()))
            } else {
                Box::new(AgyHeadlessAdapter::new(config.agent_executable.clone()))
            }
        }
    }
}
