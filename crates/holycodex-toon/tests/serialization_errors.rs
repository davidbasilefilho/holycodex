#![cfg(all(feature = "std", feature = "serde"))]

use std::collections::BTreeMap;

use holycodex_toon::{KeyFolding, Options, ser};
use serde::{Serialize, Serializer};

const SERIALIZATION_ERROR: &str = "intentional serialization failure";

struct FailingValue;

impl Serialize for FailingValue {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(SERIALIZATION_ERROR))
    }
}

#[derive(Serialize)]
struct Nested<T> {
    prefix: u8,
    value: T,
}

// The same API matrix has one entry when the JSON helpers are disabled.
#[cfg_attr(not(feature = "json"), allow(clippy::single_element_loop))]
fn assert_serialization_error<T: Serialize>(value: &T, expected_message: Option<&str>) {
    for key_folding in [KeyFolding::Off, KeyFolding::Safe] {
        let options = Options {
            key_folding,
            ..Options::default()
        };
        for result in [
            #[cfg(feature = "json")]
            holycodex_toon::encode_to_string(value, &options),
            #[cfg(feature = "json")]
            ser::to_string(value, &options),
            ser::to_string_streaming(value, &options),
        ] {
            let error = result.expect_err("serialization errors must reach the caller");
            if let Some(message) = expected_message {
                assert!(error.to_string().contains(message), "{error}");
            }
        }

        let initial = b"existing output";
        #[cfg(feature = "json")]
        let mut canonical = initial.to_vec();
        #[cfg(feature = "json")]
        let mut buffered = initial.to_vec();
        let mut streaming = initial.to_vec();
        for result in [
            #[cfg(feature = "json")]
            holycodex_toon::encode_to_writer(&mut canonical, value, &options),
            #[cfg(feature = "json")]
            ser::to_writer(&mut buffered, value, &options),
            ser::to_writer_streaming(&mut streaming, value, &options),
        ] {
            let error = result.expect_err("failed serialization must not write a document");
            if let Some(message) = expected_message {
                assert!(error.to_string().contains(message), "{error}");
            }
        }
        for output in [
            #[cfg(feature = "json")]
            canonical,
            #[cfg(feature = "json")]
            buffered,
            streaming,
        ] {
            assert_eq!(output, initial);
        }
    }
}

#[test]
fn public_encoders_propagate_custom_serialization_errors() {
    assert_serialization_error(&FailingValue, Some(SERIALIZATION_ERROR));
}

#[test]
fn nested_serialization_errors_are_not_replaced_with_null() {
    assert_serialization_error(&vec![FailingValue], Some(SERIALIZATION_ERROR));
    assert_serialization_error(
        &Nested {
            prefix: 1,
            value: FailingValue,
        },
        Some(SERIALIZATION_ERROR),
    );
    assert_serialization_error(
        &BTreeMap::from([("nested", vec![FailingValue])]),
        Some(SERIALIZATION_ERROR),
    );
}

#[test]
fn custom_map_key_errors_are_propagated() {
    #[derive(Eq, Ord, PartialEq, PartialOrd)]
    struct FailingKey;

    impl Serialize for FailingKey {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            FailingValue.serialize(serializer)
        }
    }

    assert_serialization_error(
        &BTreeMap::from([(FailingKey, 1)]),
        Some(SERIALIZATION_ERROR),
    );
}

#[test]
fn non_scalar_map_keys_are_rejected_at_every_depth() {
    #[derive(Eq, Ord, PartialEq, PartialOrd, Serialize)]
    struct ObjectKey {
        id: u8,
    }

    let tuple_keys = BTreeMap::from([((1, 2), "value")]);
    assert_serialization_error(&tuple_keys, None);
    assert_serialization_error(&vec![&tuple_keys], None);
    assert_serialization_error(
        &Nested {
            prefix: 1,
            value: &tuple_keys,
        },
        None,
    );

    let object_keys = BTreeMap::from([(ObjectKey { id: 1 }, "value")]);
    assert_serialization_error(&object_keys, None);
    assert_serialization_error(&vec![&object_keys], None);
    assert_serialization_error(&BTreeMap::from([("nested", &object_keys)]), None);
}

#[test]
fn intentional_nulls_still_serialize() {
    let value = BTreeMap::from([("value", Option::<u8>::None)]);
    for key_folding in [KeyFolding::Off, KeyFolding::Safe] {
        let options = Options {
            key_folding,
            ..Options::default()
        };
        let expected = "value: null";
        #[cfg(feature = "json")]
        assert_eq!(ser::to_string(&value, &options).unwrap(), expected);
        assert_eq!(
            ser::to_string_streaming(&value, &options).unwrap(),
            expected
        );
    }
}

#[cfg(feature = "json")]
#[test]
fn streaming_structs_flush_fields_when_key_folding_is_enabled() {
    let value = Nested {
        prefix: 1,
        value: Nested {
            prefix: 2,
            value: Option::<u8>::None,
        },
    };
    let options = Options {
        key_folding: KeyFolding::Safe,
        ..Options::default()
    };
    let encoded = ser::to_string_streaming(&value, &options).unwrap();
    assert_eq!(encoded, ser::to_string(&value, &options).unwrap());
    assert_eq!(
        holycodex_toon::decode_from_str::<serde_json::Value>(&encoded, &options).unwrap(),
        serde_json::to_value(value).unwrap()
    );
}
