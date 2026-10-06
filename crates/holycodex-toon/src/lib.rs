//! Safe Rust TOON codec, adapted from toon-rs and maintained against TOON 4.1.
#![forbid(unsafe_code)]
#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(not(feature = "std"))]
extern crate alloc;

#[cfg(not(feature = "std"))]
use alloc::format;

pub mod encode;
pub mod error;
pub(crate) mod number;
pub mod options;
pub mod value;

pub mod decode;

#[cfg(feature = "serde")]
pub mod de;
#[cfg(feature = "serde")]
pub mod ser;

pub use crate::error::{Error, Result};
pub use crate::options::{Delimiter, ExpandPaths, KeyFolding, Options};

/// Bounds applied by the HolyCodex receiving edge.
pub const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_NESTING_DEPTH: usize = 128;

/// Decode strict TOON while bounding input size and structural nesting.
/// Decoder reports one bounded diagnostic and never allocates from header counts.
#[cfg(feature = "serde")]
pub fn decode_bounded<T: serde::de::DeserializeOwned + 'static>(s: &str) -> Result<T> {
    if s.len() > MAX_DOCUMENT_BYTES {
        return Err(Error::Message(format!(
            "TOON document exceeds {MAX_DOCUMENT_BYTES} bytes"
        )));
    }
    let depth = s
        .lines()
        .map(|line| {
            let spaces = line.bytes().take_while(|b| *b == b' ').count();
            spaces / 2
        })
        .max()
        .unwrap_or(0);
    if depth > MAX_NESTING_DEPTH {
        return Err(Error::Message(format!(
            "TOON nesting exceeds {MAX_NESTING_DEPTH}"
        )));
    }
    let options = Options {
        strict: true,
        ..Options::default()
    };
    decode_from_str(s, &options)
}

#[cfg(all(not(feature = "std"), feature = "json"))]
use alloc::string::String;

#[cfg(all(feature = "std", feature = "serde"))]
use std::io::Read;
#[cfg(all(feature = "std", feature = "serde", feature = "json"))]
use std::io::Write;

#[cfg(all(feature = "serde", feature = "json"))]
use serde::Serialize;
#[cfg(feature = "serde")]
use serde::de::DeserializeOwned;

#[cfg(all(feature = "serde", feature = "json"))]
pub fn encode_to_string<T: Serialize>(value: &T, options: &Options) -> Result<String> {
    let value = serde_json::to_value(value)?;
    crate::encode::encode_value_to_string(&value, options)
}

#[cfg(all(feature = "serde", feature = "std", feature = "json"))]
pub fn encode_to_writer<W: Write, T: Serialize>(
    mut writer: W,
    value: &T,
    options: &Options,
) -> Result<()> {
    let s = encode_to_string(value, options)?;
    writer.write_all(s.as_bytes())?;
    Ok(())
}

// Decoding helpers require the json (serde_json) feature
#[cfg(feature = "serde")]
pub fn decode_from_str<T: DeserializeOwned + 'static>(s: &str, options: &Options) -> Result<T> {
    crate::de::from_str(s, options)
}

#[cfg(all(feature = "serde", feature = "std"))]
pub fn decode_from_reader<R: Read, T: DeserializeOwned + 'static>(
    mut reader: R,
    options: &Options,
) -> Result<T> {
    let mut s = String::new();
    reader.read_to_string(&mut s)?;
    decode_from_str(&s, options)
}

#[cfg(all(test, feature = "serde", feature = "json"))]
mod bounded_nesting_tests {
    use super::{MAX_NESTING_DEPTH, decode_bounded};

    fn nested_tabular_header(groups: usize) -> String {
        let mut field = "leaf".to_owned();
        for _ in 0..groups {
            field = format!("nested{{{field}}}");
        }
        format!("items[1]{{{field}}}:\n  value")
    }

    #[test]
    fn tabular_field_group_nesting_is_structurally_bounded() {
        let within_limit = nested_tabular_header(MAX_NESTING_DEPTH);
        let decoded: serde_json::Value = decode_bounded(&within_limit)
            .expect("the configured maximum structural depth remains accepted");
        let mut cursor = &decoded["items"][0];
        for _ in 0..MAX_NESTING_DEPTH {
            cursor = &cursor["nested"];
            assert!(cursor.is_object());
        }
        assert_eq!(cursor["leaf"], "value");

        let over_limit = nested_tabular_header(MAX_NESTING_DEPTH + 1);
        let error = decode_bounded::<serde_json::Value>(&over_limit)
            .expect_err("a single-line field-group overflow must be rejected");
        assert!(error.to_string().contains("structural nesting"));
    }
}
