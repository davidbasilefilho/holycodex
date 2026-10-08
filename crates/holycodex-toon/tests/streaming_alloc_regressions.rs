#![cfg(feature = "serde")]

use holycodex_toon::{KeyFolding, Options, ser::to_string_streaming};
use serde::{Serialize, Serializer};

#[derive(Serialize)]
struct Scalar<T>(T);

#[derive(Serialize)]
struct WrappedScalars {
    optional: Option<&'static str>,
    newtype: Scalar<u32>,
}

#[test]
fn wrapped_scalars_are_emitted_inline() {
    let encoded = to_string_streaming(
        &WrappedScalars {
            optional: Some("ready"),
            newtype: Scalar(7),
        },
        &Options::default(),
    )
    .unwrap();

    assert_eq!(encoded, "optional: ready\nnewtype: 7");
}

#[derive(Serialize)]
struct Network {
    port: u16,
}

#[derive(Serialize)]
struct Config {
    network: Network,
}

#[derive(Serialize)]
struct Foldable {
    config: Config,
}

#[derive(Serialize)]
struct FoldCollision {
    config: Config,
    #[serde(rename = "config.network.port")]
    flattened_port: u16,
}

fn safe_folding_options() -> Options {
    Options {
        key_folding: KeyFolding::Safe,
        ..Options::default()
    }
}

#[test]
fn safe_key_folding_works_without_json_support() {
    let encoded = to_string_streaming(
        &Foldable {
            config: Config {
                network: Network { port: 443 },
            },
        },
        &safe_folding_options(),
    )
    .unwrap();

    assert_eq!(encoded, "config.network.port: 443");
}

#[test]
fn safe_key_folding_preserves_sibling_collision() {
    let encoded = to_string_streaming(
        &FoldCollision {
            config: Config {
                network: Network { port: 443 },
            },
            flattened_port: 80,
        },
        &safe_folding_options(),
    )
    .unwrap();

    assert_eq!(
        encoded,
        "config:\n  network:\n    port: 443\nconfig.network.port: 80"
    );
}

#[test]
fn safe_key_folding_obeys_flatten_depth() {
    let encoded = to_string_streaming(
        &Foldable {
            config: Config {
                network: Network { port: 443 },
            },
        },
        &Options {
            flatten_depth: Some(2),
            ..safe_folding_options()
        },
    )
    .unwrap();

    assert_eq!(encoded, "config.network:\n  port: 443");
}

struct ValueBeforeKey;

impl Serialize for ValueBeforeKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        serde::ser::SerializeMap::serialize_value(&mut map, &vec![1u8])?;
        serde::ser::SerializeMap::end(map)
    }
}

#[test]
fn map_value_without_a_key_returns_an_error() {
    assert!(to_string_streaming(&ValueBeforeKey, &Options::default()).is_err());
}
