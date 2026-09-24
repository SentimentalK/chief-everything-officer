mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::client::{ClientError, ConnectorClient};
use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::enrollment::{
    generate_secret_and_digest, login_flow, logout_flow, EnrollmentError, PendingEnrollmentSession,
};
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::paths::ConnectorPaths;
use common::mock_server::{MockResponse, MockServer};

#[tokio::test]
async fn secret_digest_and_redacted_debug() {
    let (secret, digest) = generate_secret_and_digest();
    assert_eq!(secret.len(), 43); // 32 bytes base64url without pad
    assert_eq!(digest.len(), 64); // SHA256 hex string

    let session = PendingEnrollmentSession {
        schema_version: 1,
        server_origin: "https://api.ceo.dev".into(),
        device_code: "devcode123".into(),
        user_code: "USER-9999".into(),
        reserved_device_id: "dev_1".into(),
        reserved_credential_id: "dcr_1".into(),
        secret: secret.clone(),
        expires_at_ms: 2000000000000,
        poll_interval_seconds: 2,
    };

    let debug_out = format!("{:?}", session);
    assert!(!debug_out.contains(&secret));
    assert!(!debug_out.contains("devcode123"));
    assert!(debug_out.contains("USER-9999"));
    assert!(debug_out.contains("[REDACTED]"));
}

#[tokio::test]
async fn successful_enrollment_and_identity_verification() {
    let server = MockServer::start().await;
    let poll_count = Arc::new(AtomicUsize::new(0));

    let poll_count_clone = poll_count.clone();
    server.add_handler(move |req| {
        if req.path == "/api/connector/enrollments" && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            let digest = body.get("credential_secret_sha256").unwrap().as_str().unwrap();
            assert_eq!(digest.len(), 64);

            return MockResponse::json(
                200,
                &serde_json::json!({
                    "device_code": "mock-device-code",
                    "user_code": "TEST-1234",
                    "device_id": "dev_test_123",
                    "credential_id": "dcr_test_456",
                    "verification_uri": "http://127.0.0.1/connector/enroll",
                    "verification_uri_complete": "http://127.0.0.1/connector/enroll?user_code=TEST-1234",
                    "expires_in": 300,
                    "interval": 1
                }),
            );
        }

        if req.path == "/api/connector/enrollments/token" && req.method == "POST" {
            let count = poll_count_clone.fetch_add(1, Ordering::SeqCst);
            if count == 0 {
                return MockResponse::json(
                    400,
                    &serde_json::json!({
                        "error": "authorization_pending"
                    }),
                );
            } else {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "device": {
                            "id": "dev_test_123",
                            "display_name": "Test Device",
                            "platform": "linux-x86_64"
                        },
                        "credential": {
                            "id": "dcr_test_456",
                            "expires_at_ms": 2000000000000i64
                        },
                        "replayed": false
                    }),
                );
            }
        }

        if req.path == "/api/connector/identity" && req.method == "GET" {
            let auth = req.headers.get("authorization").unwrap();
            assert!(auth.starts_with("Bearer ceo_dev1.dcr_test_456."));

            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_owner_789",
                    "device": {
                        "id": "dev_test_123",
                        "display_name": "Test Device",
                        "platform": "linux-x86_64"
                    },
                    "credential": {
                        "id": "dcr_test_456",
                        "expires_at_ms": 2000000000000i64
                    }
                }),
            );
        }

        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));

    login_flow(&paths, &server.origin(), Some("Test Device".into()), true)
        .await
        .unwrap();

    // Verify credential was written with 0600 mode
    let cred = DeviceCredential::load(&paths.credential_file())
        .unwrap()
        .unwrap();
    assert_eq!(cred.device_id, "dev_test_123");
    assert_eq!(cred.credential_id, "dcr_test_456");
    assert_eq!(cred.user_id, "usr_owner_789");

    // Verify enrollment.json was removed
    assert!(!paths.enrollment_file().exists());

    // Verify config.json was written with server_url
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(config.server_url, server.origin());
}

#[tokio::test]
async fn crash_recovery_resumes_pending_enrollment_after_server_finalization() {
    let server = MockServer::start().await;

    // Simulate Server having already marked enrollment consumed
    server.add_handler(|req| {
        if req.path == "/api/connector/enrollments/token" && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "device": {
                        "id": "dev_resumed_123",
                        "display_name": "Resumed Device",
                        "platform": "linux-x86_64"
                    },
                    "credential": {
                        "id": "dcr_resumed_456",
                        "expires_at_ms": 2000000000000i64
                    },
                    "replayed": true
                }),
            );
        }

        if req.path == "/api/connector/identity" && req.method == "GET" {
            let auth = req.headers.get("authorization").unwrap();
            assert!(auth.starts_with("Bearer ceo_dev1.dcr_resumed_456.persisted-secret-key"));

            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_owner_999",
                    "device": {
                        "id": "dev_resumed_123",
                        "display_name": "Resumed Device",
                        "platform": "linux-x86_64"
                    },
                    "credential": {
                        "id": "dcr_resumed_456",
                        "expires_at_ms": 2000000000000i64
                    }
                }),
            );
        }

        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    // Plant existing pending enrollment session on disk (simulating crash before token poll / credential write)
    let session = PendingEnrollmentSession {
        schema_version: 1,
        server_origin: server.origin(),
        device_code: "existing-device-code".into(),
        user_code: "RESUME-1234".into(),
        reserved_device_id: "dev_resumed_123".into(),
        reserved_credential_id: "dcr_resumed_456".into(),
        secret: "persisted-secret-key".into(),
        expires_at_ms: 2000000000000,
        poll_interval_seconds: 1,
    };
    session.save(&paths.enrollment_file()).unwrap();

    login_flow(&paths, &server.origin(), None, true)
        .await
        .unwrap();

    let cred = DeviceCredential::load(&paths.credential_file())
        .unwrap()
        .unwrap();
    assert_eq!(cred.device_id, "dev_resumed_123");
    assert_eq!(cred.secret, "persisted-secret-key");
    assert!(!paths.enrollment_file().exists());

    // Ensure no new enrollment call was dispatched
    let enroll_calls = server
        .requests()
        .into_iter()
        .filter(|r| r.path == "/api/connector/enrollments")
        .count();
    assert_eq!(enroll_calls, 0);
}

#[tokio::test]
async fn server_origin_mismatch_prevents_request() {
    let client = ConnectorClient::new("http://127.0.0.1:4000").unwrap();

    let foreign_cred = DeviceCredential::new(
        "http://127.0.0.1:5000".into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();

    let err = client.identity(&foreign_cred).await.unwrap_err();
    match err {
        ClientError::LocalCredentialServerMismatch { expected, actual } => {
            assert_eq!(expected, "http://127.0.0.1:4000");
            assert_eq!(actual, "http://127.0.0.1:5000");
        }
        other => panic!("expected LocalCredentialServerMismatch, got {:?}", other),
    }
}

#[tokio::test]
async fn logout_safety_guards() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/device/revoke" && req.method == "POST" {
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    // 1. Plant an active attempt -> logout should fail with UnresolvedExecutionState
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_123"
        }),
    )
    .unwrap();

    let err = logout_flow(&paths).await.unwrap_err();
    assert!(matches!(err, EnrollmentError::UnresolvedExecutionState));
    assert!(paths.credential_file().exists()); // Credential retained!

    // Clear active attempt, plant outbox report
    std::fs::remove_file(paths.active_attempt_file()).unwrap();
    atomic_write_json(
        &paths.outbox_file("job_123", "att_456"),
        &serde_json::json!({ "report": "pending" }),
    )
    .unwrap();

    let err = logout_flow(&paths).await.unwrap_err();
    assert!(matches!(err, EnrollmentError::UnresolvedExecutionState));
    assert!(paths.credential_file().exists()); // Credential retained!

    // Clear outbox -> now logout succeeds
    std::fs::remove_file(paths.outbox_file("job_123", "att_456")).unwrap();
    logout_flow(&paths).await.unwrap();
    assert!(!paths.credential_file().exists());
}
