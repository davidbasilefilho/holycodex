#![cfg(feature = "serde")]

use holycodex_toon::{Options, decode_from_str, ser::to_string_streaming};
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Identifier(String);

#[derive(Debug, PartialEq, Serialize, Deserialize)]
enum Event {
    Ready,
    Named(String),
    Point(i32, i32),
    Position {
        x: i32,
        y: i32,
    },
    #[serde(rename = "odd: [position] key")]
    OddPosition {
        x: i32,
        y: i32,
    },
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Record {
    note: Option<String>,
    event: Event,
}

#[test]
fn deserializer_uses_serde_option_newtype_and_enum_entry_points() {
    assert_eq!(
        decode_from_str::<Option<String>>("hello", &Options::default()).unwrap(),
        Some("hello".to_owned())
    );
    assert_eq!(
        decode_from_str::<Option<String>>("null", &Options::default()).unwrap(),
        None
    );
    assert_eq!(
        decode_from_str::<Identifier>("id-7", &Options::default()).unwrap(),
        Identifier("id-7".to_owned())
    );

    for (toon, expected) in [
        ("Ready", Event::Ready),
        ("Named: Ada", Event::Named("Ada".to_owned())),
        ("Point[2]: 3,5", Event::Point(3, 5)),
        ("Position:\n  x: 3\n  y: 5", Event::Position { x: 3, y: 5 }),
    ] {
        assert_eq!(
            decode_from_str::<Event>(toon, &Options::default()).unwrap(),
            expected,
            "{toon}"
        );
    }

    let record =
        decode_from_str::<Record>("note: hello\nevent:\n  Point[2]: 3,5", &Options::default())
            .unwrap();
    assert_eq!(
        record,
        Record {
            note: Some("hello".to_owned()),
            event: Event::Point(3, 5)
        }
    );
    assert!(decode_from_str::<Event>("Point[3]: 3,5,7", &Options::default()).is_err());
}

#[test]
fn tuple_variant_streaming_preserves_discriminator_and_round_trips() {
    let value = Event::Point(3, 5);
    let encoded = to_string_streaming(&value, &Options::default()).unwrap();
    assert!(encoded.starts_with("Point[2]: "), "{encoded:?}");
    assert_eq!(
        decode_from_str::<Event>(&encoded, &Options::default()).unwrap(),
        value
    );
}

#[test]
fn streaming_newtype_variant_keeps_its_scalar_payload_on_the_discriminator() {
    let value = Event::Named("Ada".to_owned());
    let encoded = to_string_streaming(&value, &Options::default()).unwrap();
    assert_eq!(encoded, "Named: Ada");
    assert_eq!(
        decode_from_str::<Event>(&encoded, &Options::default()).unwrap(),
        value
    );
}

#[test]
fn streaming_struct_variant_fields_use_configured_indentation() {
    for indent in [1, 2, 4] {
        let options = Options {
            indent,
            ..Options::default()
        };
        let value = Event::Position { x: 3, y: 5 };
        let encoded = to_string_streaming(&value, &options).unwrap();
        assert!(
            encoded
                .lines()
                .nth(1)
                .unwrap()
                .starts_with(&" ".repeat(indent)),
            "{encoded:?}"
        );
        assert_eq!(
            decode_from_str::<Event>(&encoded, &options).unwrap(),
            value,
            "{encoded:?}"
        );
    }
}

#[test]
fn streaming_struct_variant_quotes_renamed_discriminator_keys() {
    let value = Event::OddPosition { x: 3, y: 5 };
    let encoded = to_string_streaming(&value, &Options::default()).unwrap();
    assert_eq!(
        decode_from_str::<Event>(&encoded, &Options::default()).unwrap(),
        value,
        "{encoded:?}"
    );
}

#[test]
fn no_json_tuple_paths_still_emit_the_buffered_sequence() {
    let encoded = to_string_streaming(&(3, 5), &Options::default()).unwrap();
    assert_eq!(encoded, "[2]: 3,5");
}

#[cfg(feature = "json")]
#[test]
fn buffered_and_nonstreaming_tuple_variants_keep_their_discriminator() {
    use holycodex_toon::ser::to_string;

    let value = Event::Point(3, 5);
    let encoded = to_string(&value, &Options::default()).unwrap();
    assert_eq!(
        decode_from_str::<Event>(&encoded, &Options::default()).unwrap(),
        value
    );
}
