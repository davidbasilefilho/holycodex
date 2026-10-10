#![cfg(feature = "serde")]

use holycodex_toon::{Options, decode_from_str, ser::to_string_streaming};
use serde_json::{Value, json};

#[test]
fn streaming_nested_list_fields_round_trip_with_configured_indentation() {
    for indent in [1, 3, 4, 6] {
        let options = Options {
            indent,
            ..Options::default()
        };
        for value in [
            json!([{"a": [{"name": "one"}, {"name": "two"}], "z": "tail"}]),
            json!([{"a": {"first": {"x": 1}, "second": {"x": 2}}, "z": "tail"}]),
            json!([{"a": [[1], {"x": 2}], "z": "tail"}]),
            json!([{"a": {"nested": {"x": 1}}, "z": "tail"}]),
        ] {
            let encoded = to_string_streaming(&value, &options).unwrap();
            assert_eq!(
                decode_from_str::<Value>(&encoded, &options)
                    .unwrap_or_else(|e| panic!("{encoded:?}: {e}")),
                value
            );
        }
    }
}
