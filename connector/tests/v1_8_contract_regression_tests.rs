use std::path::PathBuf;

use ceo_connector::execution_contract::{build_execution_prompt, ManagedContract};
use ceo_connector::managed_result::ManagedResultEnvelope;

#[test]
fn test_contract_example_round_trips_through_validator() {
    let contract = ManagedContract {
        path: PathBuf::from("/home/user/.local/state/ceo/connector/runtime/att-bbbbbbbb-0000-0000-0000-000000000002/managed-result.json"),
        job_id: "job-aaaaaaaa-0000-0000-0000-000000000001".into(),
        attempt_id: "att-bbbbbbbb-0000-0000-0000-000000000002".into(),
        resource_id: "res-cccccccc-0000-0000-0000-000000000003".into(),
    };

    let prompt = build_execution_prompt(
        Some("Acquire full textual content for Resource"),
        Some("A valid managed result must contain a non-empty upsert_content operation"),
        Some(&contract),
    );

    // 1. Strict absence of bogus/deprecated ops
    assert!(
        !prompt.contains("replace_body"),
        "prompt must not contain replace_body"
    );

    // 2. Presence of correct canonical operations and instructions
    assert!(
        prompt.contains("upsert_content"),
        "prompt must contain upsert_content example"
    );

    // 3. Correlation identifiers are properly formatted and injected
    assert!(prompt.contains(&contract.job_id));
    assert!(prompt.contains(&contract.attempt_id));
    assert!(prompt.contains(&contract.resource_id));
    assert!(prompt.contains(&contract.path.display().to_string()));

    // 4. Extract the JSON block from the generated prompt and parse it
    let json_start = prompt
        .find("{\n  \"schema_version\": 1,")
        .expect("JSON schema example must start with schema_version");
    let json_end = prompt[json_start..]
        .find("\n}\n")
        .expect("JSON schema example must close with closing bracket");
    let example_json_str = &prompt[json_start..json_start + json_end + 2];

    let envelope: ManagedResultEnvelope = serde_json::from_str(example_json_str)
        .expect("Extracted JSON from prompt example must be valid ManagedResultEnvelope");

    // 5. Verify the parsed example envelope correlation matches exactly
    assert_eq!(envelope.schema_version, 1);
    assert_eq!(envelope.job_id, contract.job_id);
    assert_eq!(envelope.attempt_id, contract.attempt_id);
    assert_eq!(envelope.resource_id, contract.resource_id);

    // 6. Run the real correlation validator from managed_result module
    envelope
        .validate_correlation(
            &contract.job_id,
            &contract.attempt_id,
            Some(&contract.resource_id),
        )
        .expect("Contract envelope generated from prompt MUST pass validate_correlation");

    // 7. Verify the operation is upsert_content
    assert_eq!(envelope.operations.len(), 1);
    assert_eq!(
        envelope.operations[0].get("op").and_then(|v| v.as_str()),
        Some("upsert_content")
    );
}
