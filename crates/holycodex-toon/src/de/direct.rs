//! Compatibility entry point for the optional `de_direct` feature.
//!
//! Typed decoding deliberately shares the canonical parser so enabling a feature
//! cannot change strict validation, indentation, key expansion, or TOON grammar.
//! A separate fast path may return only after it has equivalent conformance coverage.

use serde::de::DeserializeOwned;

use crate::{Options, Result};

pub use super::DeError;

pub fn from_str<T: DeserializeOwned>(s: &str, options: &Options) -> Result<T> {
    super::from_str_via_internal_value(s, options)
}
