use super::client::OrcaCliClient;

#[derive(Clone, Debug)]
pub struct OrcaExecutionAdapter {
    pub client: OrcaCliClient,
}

impl OrcaExecutionAdapter {
    pub fn new(client: OrcaCliClient) -> Self {
        Self { client }
    }
}
