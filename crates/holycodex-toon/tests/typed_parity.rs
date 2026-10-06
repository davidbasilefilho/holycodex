#![cfg(feature = "serde")]

use holycodex_toon::{ExpandPaths, Options, decode_from_str, encode_to_string};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn decode<T: DeserializeOwned + PartialEq + std::fmt::Debug + 'static>(
    input: &str,
    options: &Options,
    expected: T,
) {
    assert_eq!(
        decode_from_str::<T>(input, options).unwrap_or_else(|error| panic!("{input:?}: {error}")),
        expected,
        "{input:?}"
    );
    #[cfg(feature = "de_direct")]
    assert_eq!(
        holycodex_toon::de::direct::from_str::<T>(input, options).unwrap(),
        expected,
        "{input:?}"
    );
}
fn reject<T: DeserializeOwned + 'static>(input: &str) {
    let options = Options::default();
    assert!(decode_from_str::<T>(input, &options).is_err(), "{input:?}");
    #[cfg(feature = "de_direct")]
    assert!(
        holycodex_toon::de::direct::from_str::<T>(input, &options).is_err(),
        "{input:?}"
    );
}
#[test]
fn typed_decoders_reject_trailing_content() {
    reject::<Vec<String>>("- first\ntrailing: value");
    reject::<BTreeMap<String, String>>("a: first\n- trailing");
}
#[test]
fn typed_decoders_reject_duplicate_keys() {
    reject::<BTreeMap<String, String>>("a: first\na: second");
}
#[test]
fn typed_decoders_validate_quoted_strings() {
    for bad in [r#"a: "bad\q""#, r#"a: "unfinished"#, r#""bad\q": value"#] {
        reject::<BTreeMap<String, String>>(bad);
    }
}
#[test]
fn typed_decoders_align_comments_with_raw_lines() {
    reject::<BTreeMap<String, BTreeMap<String, String>>>("# comment\na:\n\tb: value");
    decode(
        "# comment\na: value",
        &Options::default(),
        BTreeMap::from([("a".to_owned(), "value".to_owned())]),
    );
}
#[test]
fn typed_decoders_expand_paths() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Nested {
        a: BTreeMap<String, String>,
    }
    let expected = || Nested {
        a: BTreeMap::from([("b".into(), "value".into())]),
    };
    decode(
        "a.b: value",
        &Options {
            expand_paths: ExpandPaths::Safe,
            ..Options::default()
        },
        expected(),
    );
}
#[test]
fn typed_decoders_honor_indentation() {
    let expected = BTreeMap::from([(
        "a".to_owned(),
        BTreeMap::from([("b".to_owned(), "value".to_owned())]),
    )]);
    decode(
        "a:\n    b: value",
        &Options {
            indent: 4,
            ..Options::default()
        },
        expected.clone(),
    );
    decode(
        "- a:\n        b: value",
        &Options {
            indent: 4,
            ..Options::default()
        },
        vec![expected],
    );
}
#[test]
fn typed_decoders_preserve_empty_arrays() {
    decode("[]", &Options::default(), Vec::<String>::new());
    decode(
        "items: []",
        &Options::default(),
        BTreeMap::from([("items".to_owned(), Vec::<String>::new())]),
    );
    decode("- []", &Options::default(), vec![Vec::<String>::new()]);
}
#[test]
fn typed_decoders_preserve_numeric_strings() {
    for value in [".5", "1.", "+1"] {
        decode(value, &Options::default(), value.to_owned());
    }
}
#[test]
fn typed_decoders_support_keyed_object_headers() {
    for delimiter in ["", "|", "\t"] {
        let source = format!("[2:{delimiter}]{{value}}:\n  first: one\n  second: two");
        decode(
            &source,
            &Options::default(),
            BTreeMap::from([
                (
                    "first".to_owned(),
                    BTreeMap::from([("value".to_owned(), "one".to_owned())]),
                ),
                (
                    "second".to_owned(),
                    BTreeMap::from([("value".to_owned(), "two".to_owned())]),
                ),
            ]),
        );
    }
}
#[test]
fn list_first_fields_round_trip_at_nondefault_indentation() {
    for value in [
        json!([{"a": [{"name": "one"}, {"name": "two"}], "z": "tail"}]),
        json!([{"a": {"first": {"x": 1}, "second": {"x": 2}}, "z": "tail"}]),
        json!([{"a": [[1], {"x": 2}], "z": "tail"}]),
        json!([{"a": {"nested": {"x": 1}}, "z": "tail"}]),
    ] {
        let options = Options {
            indent: 4,
            ..Options::default()
        };
        let encoded = encode_to_string(&value, &options).unwrap();
        decode::<Vec<BTreeMap<String, Value>>>(
            &encoded,
            &options,
            serde_json::from_value(value).unwrap(),
        );
    }
}

#[test]
fn quoted_dotted_keys_remain_literal_without_marker_leaks() {
    #[derive(Debug, Deserialize, PartialEq)]
    struct Dotted {
        #[serde(rename = "a.b")]
        value: i32,
    }
    for expand_paths in [ExpandPaths::Off, ExpandPaths::Safe] {
        let options = Options {
            expand_paths,
            ..Options::default()
        };
        decode("\"a.b\": 1", &options, Dotted { value: 1 });
        decode(
            "nested:\n  \"a.b\": 1",
            &options,
            BTreeMap::from([("nested".to_owned(), Dotted { value: 1 })]),
        );
        decode("- \"a.b\": 1", &options, vec![Dotted { value: 1 }]);
        decode("\"a.b\": 1", &options, json!({"a.b": 1}));
    }
    decode(
        "\"\u{200B}literal\": 1",
        &Options::default(),
        BTreeMap::from([("\u{200B}literal".to_owned(), 1)]),
    );
    reject::<BTreeMap<String, i32>>("a.b: 1\n\"a.b\": 2");
}
