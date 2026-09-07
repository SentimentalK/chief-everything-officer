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

    fn get_launch_config(
        &self,
        request: &ExecutionRequest,
    ) -> crate::executor::adapter_trait::LaunchConfiguration {
        crate::executor::adapter_trait::LaunchConfiguration {
            executable_path: None,
            version: Some(self.default_version().to_string()),
            model: request.model.unwrap_or("agentapi-model").to_string(),
            effort: None,
            persona: None,
            mode: "agentapi-mode".to_string(),
            skip_permissions: false,
            sandbox: false,
            input_output_format: "agentapi".to_string(),
            project_id: "agentapi-project".to_string(),
            tmpdir_root_rule: "<workspace>/.ceo/tmp".to_string(),
            log_dir_rule: "<attempt_dir>/agentapi.log".to_string(),
        }
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
