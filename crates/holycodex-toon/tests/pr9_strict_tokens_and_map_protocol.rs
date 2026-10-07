#![cfg(all(feature = "std", feature = "serde"))]

use holycodex_toon::{Options, decode_from_str};
#[cfg(feature = "json")]
use serde::ser::SerializeMap;
#[cfg(feature = "json")]
use serde::{Serialize, Serializer};

fn strict_options(strict: bool) -> Options {
    Options {
        strict,
        ..Options::default()
    }
}

#[test]
fn strict_quoted_values_reject_unescaped_quotes_and_raw_controls() {
    for input in ["value: \"a\"b\"", "value: \"a\u{0000}b\""] {
        let error = decode_from_str::<serde_json::Value>(input, &strict_options(true))
            .expect_err("strict quoted scalar must reject invalid JSON string characters");
        assert!(error.to_string().contains("quoted string"), "{error}");
    }
}

#[test]
fn strict_quoted_keys_reject_unescaped_quotes_and_raw_controls() {
    for input in ["\"a\"b\": value", "\"a\u{0000}b\": value"] {
        decode_from_str::<serde_json::Value>(input, &strict_options(true))
            .expect_err("strict quoted key must reject invalid JSON string characters");
    }
}

#[test]
fn escaped_quote_and_unicode_surrogate_pair_remain_supported() {
    let decoded = decode_from_str::<serde_json::Value>(
        r#"value: "quote: \" face: \uD83D\uDE00""#,
        &strict_options(true),
    )
    .expect("valid JSON escapes remain accepted");
    assert_eq!(decoded["value"], "quote: \" face: 😀");
}

#[test]
fn strict_quoted_tokens_preserve_raw_tabs() {
    let decoded = decode_from_str::<serde_json::Value>(
        "\"key\ttab\": \"hello\tworld\"\nitems[2]: \"a\tb\",\"c\td\"",
        &strict_options(true),
    )
    .expect("TOON strict mode permits tabs inside quoted tokens");
    assert_eq!(decoded["key\ttab"], "hello\tworld");
    assert_eq!(decoded["items"][0], "a\tb");
    assert_eq!(decoded["items"][1], "c\td");
}

#[test]
fn non_strict_quoted_tokens_keep_permissive_behavior() {
    let decoded = decode_from_str::<serde_json::Value>("value: \"a\"b\"", &strict_options(false))
        .expect("non-strict parsing remains permissive");
    assert_eq!(decoded["value"], "a\"b");
}

#[cfg(feature = "json")]
struct ValueWithoutKey;

#[cfg(feature = "json")]
impl Serialize for ValueWithoutKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_value(&7_u8)?;
        map.end()
    }
}

#[cfg(feature = "json")]
#[test]
fn buffered_map_value_without_key_is_an_error() {
    let error = holycodex_toon::ser::to_string(&ValueWithoutKey, &Options::default())
        .expect_err("serialize_value without serialize_key violates the map protocol");
    assert!(
        error
            .to_string()
            .contains("serialize_value called before serialize_key"),
        "{error}"
    );
}
