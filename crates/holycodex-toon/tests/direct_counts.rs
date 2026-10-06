#![cfg(all(feature = "serde", feature = "de_direct"))]

use std::fmt::Debug;

use holycodex_toon::{Options, de::direct, decode_from_str};
use serde::{Deserialize, de::DeserializeOwned};

#[derive(Debug, Deserialize, PartialEq)]
struct Items {
    items: Vec<String>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct LabeledItems {
    label: String,
    items: Vec<String>,
}

fn assert_decodes<T: DeserializeOwned + Debug + PartialEq + 'static>(
    input: &str,
    strict: bool,
    expected: T,
) {
    let options = Options {
        strict,
        ..Options::default()
    };
    // These concrete types never take the serde_json::Value fallback.
    assert_eq!(
        decode_from_str::<T>(input, &options).unwrap(),
        expected,
        "public decode: {input:?}"
    );
    assert_eq!(
        direct::from_str::<T>(input, &options).unwrap(),
        expected,
        "direct decode: {input:?}"
    );
}

fn assert_rejects<T: DeserializeOwned + Debug + 'static>(input: &str, strict: bool, message: &str) {
    let options = Options {
        strict,
        ..Options::default()
    };
    for result in [
        decode_from_str::<T>(input, &options),
        direct::from_str::<T>(input, &options),
    ] {
        let error = result.expect_err(input).to_string();
        assert!(error.contains(message), "{input:?}: {error}");
    }
}

fn assert_all_forms_decode(
    count: usize,
    delimiter: &str,
    values: &str,
    expected: &[&str],
    strict: bool,
) {
    let items = || Items {
        items: expected.iter().map(|value| (*value).to_owned()).collect(),
    };
    let labeled = || LabeledItems {
        label: "entry".into(),
        items: items().items,
    };
    let header = format!("[{count}{delimiter}]");
    assert_decodes(&format!("items: {header}: {values}"), strict, items());
    assert_decodes(&format!("- {header}: {values}"), strict, vec![items().items]);
    assert_decodes(&format!("- items: {header}: {values}"), strict, vec![items()]);
    assert_decodes(
        &format!("- label: entry\n  items: {header}: {values}"),
        strict,
        vec![labeled()],
    );
    assert_decodes(&format!("items{header}: {values}"), strict, items());
    assert_decodes(&format!("- items{header}: {values}"), strict, vec![items()]);
    assert_decodes(
        &format!("- label: entry\n  items{header}: {values}"),
        strict,
        vec![labeled()],
    );
}

fn assert_all_forms_reject(count: &str, message: &str, strict: bool) {
    assert_rejects::<Items>(&format!("items: [{count}]: a,b"), strict, message);
    assert_rejects::<Vec<Vec<String>>>(&format!("- [{count}]: a,b"), strict, message);
    assert_rejects::<Vec<Items>>(&format!("- items: [{count}]: a,b"), strict, message);
    assert_rejects::<Vec<LabeledItems>>(
        &format!("- label: entry\n  items: [{count}]: a,b"),
        strict,
        message,
    );
    assert_rejects::<Items>(&format!("items[{count}]: a,b"), strict, message);
    assert_rejects::<Vec<Items>>(&format!("- items[{count}]: a,b"), strict, message);
    assert_rejects::<Vec<LabeledItems>>(
        &format!("- label: entry\n  items[{count}]: a,b"),
        strict,
        message,
    );
}

#[test]
fn strict_inline_counts_reject_too_few_and_too_many_elements() {
    for declared in ["0", "1", "3"] {
        assert_all_forms_reject(
            declared,
            &format!("header declares {declared} elements but found 2"),
            true,
        );
    }
}

#[test]
fn matching_inline_counts_work_in_every_supported_position() {
    assert_all_forms_decode(2, "", "a,b", &["a", "b"], true);
    assert_all_forms_decode(1, "", "a", &["a"], true);
}

#[test]
fn quoted_delimiters_and_escaped_quotes_are_single_elements() {
    assert_all_forms_decode(2, "", r#""a,b","c\"d,e""#, &["a,b", "c\"d,e"], true);
    assert_all_forms_decode(2, "|", r#""a|b"|"c\"d|e""#, &["a|b", "c\"d|e"], true);
    assert_all_forms_decode(
        2,
        "\t",
        "\"a\tb\"\t\"c\\\"d\te\"",
        &["a\tb", "c\"d\te"],
        true,
    );
    assert_all_forms_decode(2, "", r#""",a"#, &["", "a"], true);
}

#[test]
fn non_strict_inline_counts_keep_actual_elements() {
    for declared in [0, 1, 3] {
        assert_all_forms_decode(declared, "", "a,b", &["a", "b"], false);
    }
}

#[test]
fn empty_value_headers_validate_zero_counts() {
    let empty = || Items { items: Vec::new() };
    assert_decodes("items: [0]:", true, empty());
    assert_decodes("- [0]:", true, vec![Vec::<String>::new()]);
    assert_decodes("- items: [0]:", true, vec![empty()]);
    assert_decodes(
        "- label: entry\n  items: [0]:",
        true,
        vec![LabeledItems {
            label: "entry".into(),
            items: Vec::new(),
        }],
    );
    assert_rejects::<Items>(
        "items: [1]:",
        true,
        "header declares 1 elements but found 0",
    );
}

#[test]
fn strict_counts_do_not_drop_unquoted_empty_elements() {
    for input in ["items: [2]: a,,b", "items[2]: a,b,", "items[2]: ,a,b"] {
        assert_rejects::<Items>(input, true, "header declares 2 elements but found 3");
    }
    assert_rejects::<Items>("items: [3]: a,,b", true, "empty inline array element");
    assert_decodes(
        "items: [2]: a,,b",
        false,
        Items {
            items: vec!["a".into(), "b".into()],
        },
    );
}

#[test]
fn public_direct_entry_point_validates_header_syntax() {
    for malformed in ["", "-1", "01", "2,"] {
        assert_all_forms_reject(malformed, "malformed array header", true);
    }
}

#[test]
fn unrepresentable_inline_counts_return_errors_without_panicking() {
    assert_all_forms_reject(&usize::MAX.to_string(), "array length mismatch", true);
    let too_large = "9".repeat(100);
    for strict in [true, false] {
        assert_all_forms_reject(&too_large, "array length exceeds supported range", strict);
    }
}

#[test]
fn keyed_inline_counts_respect_quoted_keys() {
    assert_decodes(
        "\"items\"[2]: a,b",
        true,
        Items {
            items: vec!["a".into(), "b".into()],
        },
    );
    assert_rejects::<Items>(
        "\"items\"[3]: a,b",
        true,
        "header declares 3 elements but found 2",
    );
    #[derive(Debug, Deserialize, PartialEq)]
    struct LiteralKey {
        #[serde(rename = "items[3]")]
        value: String,
    }
    assert_decodes(
        "\"items[3]\": literal",
        true,
        LiteralKey {
            value: "literal".into(),
        },
    );
}

#[test]
fn ignored_fields_still_validate_declared_inline_counts() {
    #[derive(Debug, Deserialize)]
    struct IgnoreItems {}
    assert_rejects::<IgnoreItems>("items: [3]: a,b", true, "array length mismatch");
    assert_rejects::<Vec<IgnoreItems>>("- items[3]: a,b", true, "array length mismatch");
}

#[test]
fn bounded_typed_decode_rejects_inline_count_mismatch() {
    let error = holycodex_toon::decode_bounded::<Items>("items: [3]: a,b")
        .expect_err("bounded typed decode must reject incorrect inline counts");
    assert!(error.to_string().contains("array length mismatch"));
}
