mod common;

use std::sync::Arc;

use ceo_connector::client::{
    ClaimJobResponse, ConnectorClient, ConnectorTargetProjection, DeviceIdentityResponse,
    JobMutationAck, PendingJobCandidate, TargetsResponse,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::execution_contract::{
    BusinessOutcome, ExecutionReport, ExecutionReportExecutor, ExecutionStatus,
};
use common::mock_server::{MockResponse, MockServer};

fn sample_report() -> ExecutionReport {
    ExecutionReport {
        schema_version: 2,
        execution_status: ExecutionStatus::COMPLETED,
        business_outcome: BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1727220003000,
        duration_ms: 1000,
        executor: ExecutionReportExecutor {
            executor_type: "agent".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    }
}

#[tokio::test]
async fn server_contract_gate_connector_deserialization() {
    let fixture_str = include_str!("fixtures/server_contract_fixtures.json");
    let fixtures: serde_json::Value =
        serde_json::from_str(fixture_str).expect("Valid fixtures JSON");

    let server = MockServer::start().await;
    let fixtures_arc = Arc::new(fixtures.clone());

    let fixtures_clone = fixtures_arc.clone();
    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(200, &fixtures_clone["identity"]);
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &fixtures_clone["targets"]);
        }
        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            return MockResponse::json(200, &fixtures_clone["pending"]);
        }
        if req.path == "/api/connector/jobs/job-00000000-0000-0000-0000-000000000001/claim"
            && req.method == "POST"
        {
            return MockResponse::json(200, &fixtures_clone["claim"]);
        }
        if req.path == "/api/connector/jobs/job-00000000-0000-0000-0000-000000000001/start"
            && req.method == "POST"
        {
            return MockResponse::json(200, &fixtures_clone["start"]);
        }
        if req.path == "/api/connector/jobs/job-00000000-0000-0000-0000-000000000001/report"
            && req.method == "POST"
        {
            return MockResponse::json(200, &fixtures_clone["report"]);
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let client = ConnectorClient::new(&server.origin()).unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_contract_gate".into(),
        "dev_00000000-0000-0000-0000-000000000001".into(),
        "dcr_contract_gate".into(),
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        1727220000000,
    )
    .unwrap();

    // 1. /api/connector/identity
    let ident: DeviceIdentityResponse = client.identity(&cred).await.unwrap();
    assert_eq!(ident.user_id, "usr_contract_gate");
    assert_eq!(ident.device.id, "dev_00000000-0000-0000-0000-000000000001");
    assert_eq!(ident.device.display_name, "Gate Device");
    assert_eq!(ident.device.platform, "linux-x86_64");
    assert_eq!(ident.credential.id, "dcr_contract_gate");
    assert_eq!(ident.credential.expires_at_ms, 1727220000000);

    // 2. /api/connector/targets
    let targets: Vec<ConnectorTargetProjection> = client.list_targets(&cred, None).await.unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(
        targets[0].target_id,
        "tgt_00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(targets[0].workspace_id, "ws_contract_gate");
    assert_eq!(targets[0].alias, "gate-target");
    assert_eq!(targets[0].display_name, "Gate Target");
    assert_eq!(targets[0].kind, "coding");
    assert_eq!(targets[0].active_binding_count, 1);
    assert!(targets[0].this_device_binding.is_some());
    assert_eq!(
        targets[0].repository.as_ref().unwrap().full_name,
        "owner/repo"
    );

    // 3. /api/connector/jobs/pending
    let pending: Vec<PendingJobCandidate> = client.pending_jobs(&cred, Some(20)).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].job_id,
        "job-00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(pending[0].workspace_id, "ws_contract_gate");
    assert_eq!(
        pending[0].target_id,
        "tgt_00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(
        pending[0].resource_id.as_deref(),
        Some("res-00000000-0000-0000-0000-000000000001")
    );
    assert_eq!(pending[0].created_at, "2026-09-24T19:00:00.000Z");
    assert_eq!(
        pending[0].expires_at.as_deref(),
        Some("2026-09-24T20:00:00.000Z")
    );

    // 4. /api/connector/jobs/:job_id/claim
    let claim_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let claim: ClaimJobResponse = client
        .claim_job(
            &cred,
            "job-00000000-0000-0000-0000-000000000001",
            "att-11111111-2222-3333-4444-555555555555",
            claim_token,
        )
        .await
        .unwrap();
    assert!(claim.ok);
    assert!(!claim.replayed);
    assert_eq!(
        claim.attempt.attempt_id,
        "att-11111111-2222-3333-4444-555555555555"
    );
    assert_eq!(claim.attempt.phase, "claimed");
    assert_eq!(claim.job.job_id, "job-00000000-0000-0000-0000-000000000001");
    assert_eq!(claim.job.workspace_id, "ws_contract_gate");
    assert_eq!(
        claim.job.target_id,
        "tgt_00000000-0000-0000-0000-000000000001"
    );
    assert_eq!(claim.job.prompt, "Gate prompt");
    assert_eq!(claim.job.acceptance, "Gate acceptance");
    assert_eq!(claim.job.timeout_seconds, 600);

    // 5. /api/connector/jobs/:job_id/start
    let start: JobMutationAck = client
        .start_job(
            &cred,
            "job-00000000-0000-0000-0000-000000000001",
            "att-11111111-2222-3333-4444-555555555555",
            claim_token,
        )
        .await
        .unwrap();
    assert!(start.ok);
    assert!(!start.replayed);
    assert_eq!(start.server_time, "2026-09-24T19:00:02.000Z");

    // 6. /api/connector/jobs/:job_id/report
    let report_payload = sample_report();
    let report_ack: JobMutationAck = client
        .report_job(
            &cred,
            "job-00000000-0000-0000-0000-000000000001",
            "att-11111111-2222-3333-4444-555555555555",
            claim_token,
            &report_payload,
        )
        .await
        .unwrap();
    assert!(report_ack.ok);
    assert!(!report_ack.replayed);
    assert_eq!(report_ack.server_time, "2026-09-24T19:00:03.000Z");

    // Direct JSON contract verification
    let _direct_targets: TargetsResponse =
        serde_json::from_value(fixtures["targets"].clone()).unwrap();
    let _direct_claim: ClaimJobResponse =
        serde_json::from_value(fixtures["claim"].clone()).unwrap();
    let _direct_start: JobMutationAck = serde_json::from_value(fixtures["start"].clone()).unwrap();
    let _direct_report: JobMutationAck =
        serde_json::from_value(fixtures["report"].clone()).unwrap();
}
