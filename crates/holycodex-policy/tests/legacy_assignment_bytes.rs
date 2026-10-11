use holycodex_policy::Assignment;
#[test]
fn restored_legacy_assignment_retains_native_fingerprint_input() {
    // The native assignment_instruction_sha1 hashes exactly these serialized bytes
    // after clearing specialist_id, with the unchanged instruction prefix.
    let previous = r#"{"id":"assignment-1","intent_id":"intent-1","role":"explorer_lookup","objective":"lookup","bounded_scope":["src"],"constraints":[],"acceptance_criteria":["found"],"required_evidence":["source"],"mutability":"read_only","metadata":{"ownership_paths":[],"symbols":[],"domains":[],"dependencies":[],"related_assignments":[],"independent_review_of":[]},"status":"running","specialist_id":null,"result":null}"#;
    let restored: Assignment = serde_json::from_str(previous).unwrap();
    assert_eq!(restored.intent_revision, 0);
    assert_eq!(serde_json::to_string(&restored).unwrap(), previous);
}
