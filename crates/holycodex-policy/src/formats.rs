//! Holy-controlled model-facing structured data MUST use TOON; non-model
//! native persistence uses TOML. Provider-required Structured Outputs,
//! function-schema payloads, and other external provider/Codex/Cargo/npm
//! protocol JSON remain JSON. Convert to or from TOON only at a
//! Holy-controlled model-data boundary; provider JSON support does not relax
//! the TOON mandate for Holy-controlled model-facing data.

use serde::{Serialize, de::DeserializeOwned};

/// Encode typed model data as TOON 4.1.
pub fn encode_toon<T: Serialize>(value: &T) -> Result<String, holycodex_toon::Error> {
    holycodex_toon::encode_to_string(value, &holycodex_toon::Options::default())
}

/// Strictly decode typed model data from TOON 4.1.
pub fn decode_toon<T: DeserializeOwned + 'static>(input: &str) -> Result<T, holycodex_toon::Error> {
    holycodex_toon::decode_bounded(input)
}

/// Serialize validated native state as TOML.
pub fn encode_toml<T: Serialize>(value: &T) -> Result<String, toml::ser::Error> {
    toml::to_string(value)
}

/// Deserialize native state from TOML. Call the domain validator on the
/// result before accepting it at a receiving edge.
pub fn decode_toml<T: DeserializeOwned>(input: &str) -> Result<T, toml::de::Error> {
    toml::from_str(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct NativeState {
        mode: String,
        retries: u8,
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TypedReply {
        accepted: bool,
        id: String,
    }

    #[test]
    fn toon_typed_round_trip_preserves_explicit_null() {
        let source = serde_json::json!({ "enabled": true, "payload": null });
        let encoded = encode_toon(&source).unwrap();
        let decoded: serde_json::Value = decode_toon(&encoded).unwrap();
        assert_eq!(decoded, source);
    }

    #[test]
    fn toml_typed_round_trip_and_unknown_field_rejection() {
        let source = NativeState {
            mode: "safe".into(),
            retries: 3,
        };
        let encoded = encode_toml(&source).unwrap();
        assert_eq!(decode_toml::<NativeState>(&encoded).unwrap(), source);
        assert!(decode_toml::<NativeState>(&format!("{encoded}unexpected = true\n")).is_err());
    }

    #[test]
    fn toon_receiving_edge_deserializes_typed_replies_and_rejects_unknown_fields() {
        let reply: TypedReply = decode_toon("accepted: true\nid: item-1").unwrap();
        assert!(reply.accepted);
        assert_eq!(reply.id, "item-1");
        assert!(decode_toon::<TypedReply>("accepted: true\nid: item-1\nextra: no").is_err());
        assert!(decode_toon::<TypedReply>("accepted: true").is_err());
    }

    #[test]
    fn toon_receiving_edge_rejects_malformed_and_oversized_input() {
        assert!(decode_toon::<serde_json::Value>("items[03]: a,b,c").is_err());
        let oversized = " ".repeat(holycodex_toon::MAX_DOCUMENT_BYTES + 1);
        assert!(decode_toon::<serde_json::Value>(&oversized).is_err());

        let deep = (0..=holycodex_toon::MAX_NESTING_DEPTH + 1)
            .map(|level| format!("{}k:\n", " ".repeat(level * 2)))
            .collect::<String>();
        assert!(decode_toon::<serde_json::Value>(&deep).is_err());
        assert!(decode_toon::<serde_json::Value>("items[999999999]:\n").is_err());
    }
}
