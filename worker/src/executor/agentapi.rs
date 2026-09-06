use crate::executor::adapter_trait::{
    ExecutionRequest, ExecutorAdapter, ExecutorError, ExecutorMetadata, ManagedProcess,
};

pub struct AgentapiAdapter;

impl Default for AgentapiAdapter {
    fn default() -> Self {
        Self
    }
}

impl AgentapiAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl ExecutorAdapter for AgentapiAdapter {
    fn executor_type(&self) -> &'static str {
        "antigravity-agentapi"
    }

    fn default_version(&self) -> &'static str {
        "2.11.0"
    }

    fn preflight_check(&self) -> Result<ExecutorMetadata, ExecutorError> {
        Err(ExecutorError::Unsupported(
            "ADAPTER_UNSUPPORTED: Antigravity agentapi lacks workspace binding, status querying, and targeted cancellation. Submission rejected before process creation.".to_string(),
        ))
    }

    fn spawn_execution(
        &self,
        _request: &ExecutionRequest,
    ) -> Result<Box<dyn ManagedProcess>, ExecutorError> {
        Err(ExecutorError::Unsupported(
            "ADAPTER_UNSUPPORTED: Antigravity agentapi cannot be spawned.".to_string(),
        ))
    }
}
