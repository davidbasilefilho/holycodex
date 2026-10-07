//! serde::Deserializer implementation backed by internal Value (alloc-friendly)

#[cfg(not(feature = "std"))]
use alloc::{format, string::String, vec::Vec};

use serde::de::{self, DeserializeOwned, MapAccess, SeqAccess};

use crate::value::{Number, Value};
use crate::{Result, options::Options};

#[cfg(feature = "de_direct")]
pub mod direct;

#[derive(Debug)]
pub struct DeError {
    msg: String,
}

impl core::fmt::Display for DeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.msg)
    }
}
impl de::Error for DeError {
    fn custom<T: core::fmt::Display>(t: T) -> Self {
        DeError {
            msg: format!("{}", t),
        }
    }
}
impl core::error::Error for DeError {}

pub struct Deserializer {
    value: Value,
}

impl Deserializer {
    pub fn from_value(value: Value) -> Self {
        Self { value }
    }
}

impl<'de> de::Deserializer<'de> for Deserializer {
    type Error = DeError;

    fn deserialize_any<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.value {
            Value::Null => visitor.visit_unit(),
            Value::Bool(b) => visitor.visit_bool(b),
            Value::Number(n) => match n {
                Number::I64(i) => visitor.visit_i64(i),
                Number::U64(u) => visitor.visit_u64(u),
                Number::F64(f) => visitor.visit_f64(f),
            },
            Value::String(s) => visitor.visit_string(s),
            Value::Array(arr) => {
                struct SA {
                    elems: Vec<Value>,
                    idx: usize,
                }
                impl<'de> SeqAccess<'de> for SA {
                    type Error = DeError;
                    fn next_element_seed<T>(
                        &mut self,
                        seed: T,
                    ) -> core::result::Result<Option<T::Value>, Self::Error>
                    where
                        T: de::DeserializeSeed<'de>,
                    {
                        if self.idx >= self.elems.len() {
                            return Ok(None);
                        }
                        let v = core::mem::replace(&mut self.elems[self.idx], Value::Null);
                        self.idx += 1;
                        let de = Deserializer { value: v };
                        seed.deserialize(de).map(Some)
                    }
                }
                visitor.visit_seq(SA { elems: arr, idx: 0 })
            }
            Value::Object(obj) => {
                struct MA {
                    entries: Vec<(String, Value)>,
                    idx: usize,
                    next_val: Option<Value>,
                }
                impl<'de> MapAccess<'de> for MA {
                    type Error = DeError;
                    fn next_key_seed<K>(
                        &mut self,
                        seed: K,
                    ) -> core::result::Result<Option<K::Value>, Self::Error>
                    where
                        K: de::DeserializeSeed<'de>,
                    {
                        if self.idx >= self.entries.len() {
                            return Ok(None);
                        }
                        let (ref key, ref val) = self.entries[self.idx];
                        let de_key = KeyDeserializer(key.clone());
                        self.next_val = Some(val.clone());
                        seed.deserialize(de_key).map(Some)
                    }
                    fn next_value_seed<VV>(
                        &mut self,
                        seed: VV,
                    ) -> core::result::Result<VV::Value, Self::Error>
                    where
                        VV: de::DeserializeSeed<'de>,
                    {
                        let v = self.next_val.take().unwrap_or(Value::Null);
                        self.idx += 1;
                        let de = Deserializer { value: v };
                        seed.deserialize(de)
                    }
                }
                visitor.visit_map(MA {
                    entries: obj,
                    idx: 0,
                    next_val: None,
                })
            }
        }
    }

    fn deserialize_option<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.value {
            Value::Null => visitor.visit_none(),
            value => visitor.visit_some(Self { value }),
        }
    }

    fn deserialize_unit<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.value {
            Value::Null => visitor.visit_unit(),
            value => Err(de::Error::invalid_type(unexpected(&value), &"unit")),
        }
    }

    fn deserialize_unit_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        self.deserialize_unit(visitor)
    }

    fn deserialize_newtype_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_enum<V>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        let (variant, value) = match self.value {
            Value::String(variant) => (variant, None),
            Value::Object(mut entries) if entries.len() == 1 => {
                let (variant, value) = entries.pop().expect("one entry was checked");
                (variant, Some(value))
            }
            value => {
                return Err(de::Error::invalid_type(
                    unexpected(&value),
                    &"an externally tagged enum",
                ));
            }
        };
        visitor.visit_enum(EnumValue { variant, value })
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 char str string bytes byte_buf
        seq tuple tuple_struct map struct identifier ignored_any
    }
}

/// TOON object keys are stored as strings, but Serde also permits primitive
/// map key types. Parse their textual representation here so typed maps can
/// round-trip through the same object representation as string-keyed maps.
struct KeyDeserializer(String);

macro_rules! parse_key_number {
    ($($method:ident => $ty:ident / $visit:ident),* $(,)?) => {$ (
        fn $method<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
        where
            V: de::Visitor<'de>,
        {
            let value = self.0.parse::<$ty>().map_err(de::Error::custom)?;
            visitor.$visit(value)
        }
    )* };
}

impl<'de> de::Deserializer<'de> for KeyDeserializer {
    type Error = DeError;

    fn deserialize_any<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_string(self.0)
    }

    fn deserialize_bool<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        match self.0.as_str() {
            "true" => visitor.visit_bool(true),
            "false" => visitor.visit_bool(false),
            _ => Err(de::Error::invalid_value(
                de::Unexpected::Str(&self.0),
                &"a boolean key",
            )),
        }
    }

    parse_key_number! {
        deserialize_i8 => i8 / visit_i8,
        deserialize_i16 => i16 / visit_i16,
        deserialize_i32 => i32 / visit_i32,
        deserialize_i64 => i64 / visit_i64,
        deserialize_i128 => i128 / visit_i128,
        deserialize_u8 => u8 / visit_u8,
        deserialize_u16 => u16 / visit_u16,
        deserialize_u32 => u32 / visit_u32,
        deserialize_u64 => u64 / visit_u64,
        deserialize_u128 => u128 / visit_u128,
        deserialize_f32 => f32 / visit_f32,
        deserialize_f64 => f64 / visit_f64,
    }

    fn deserialize_char<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        let mut chars = self.0.chars();
        let Some(value) = chars.next() else {
            return Err(de::Error::invalid_value(
                de::Unexpected::Str(""),
                &"a character key",
            ));
        };
        if chars.next().is_some() {
            return Err(de::Error::invalid_value(
                de::Unexpected::Str(&self.0),
                &"a character key",
            ));
        }
        visitor.visit_char(value)
    }

    fn deserialize_str<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_string(self.0)
    }

    fn deserialize_string<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_string(self.0)
    }

    fn deserialize_enum<V>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_enum(de::value::StringDeserializer::<DeError>::new(self.0))
    }

    fn deserialize_newtype_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_option<V>(self, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_some(self)
    }

    serde::forward_to_deserialize_any! {
        unit unit_struct seq tuple tuple_struct map struct identifier ignored_any bytes byte_buf
    }
}

fn unexpected(value: &Value) -> de::Unexpected<'_> {
    match value {
        Value::Null => de::Unexpected::Unit,
        Value::Bool(value) => de::Unexpected::Bool(*value),
        Value::Number(Number::I64(value)) => de::Unexpected::Signed(*value),
        Value::Number(Number::U64(value)) => de::Unexpected::Unsigned(*value),
        Value::Number(Number::F64(value)) => de::Unexpected::Float(*value),
        Value::String(value) => de::Unexpected::Str(value),
        Value::Array(_) => de::Unexpected::Seq,
        Value::Object(_) => de::Unexpected::Map,
    }
}

struct EnumValue {
    variant: String,
    value: Option<Value>,
}

impl<'de> de::EnumAccess<'de> for EnumValue {
    type Error = DeError;
    type Variant = EnumVariant;

    fn variant_seed<V>(
        self,
        seed: V,
    ) -> core::result::Result<(V::Value, Self::Variant), Self::Error>
    where
        V: de::DeserializeSeed<'de>,
    {
        let variant =
            seed.deserialize(de::value::StringDeserializer::<DeError>::new(self.variant))?;
        Ok((variant, EnumVariant { value: self.value }))
    }
}

struct EnumVariant {
    value: Option<Value>,
}

impl<'de> de::VariantAccess<'de> for EnumVariant {
    type Error = DeError;

    fn unit_variant(self) -> core::result::Result<(), Self::Error> {
        match self.value {
            None | Some(Value::Null) => Ok(()),
            Some(value) => Err(de::Error::invalid_type(unexpected(&value), &"unit variant")),
        }
    }

    fn newtype_variant_seed<T>(self, seed: T) -> core::result::Result<T::Value, Self::Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        let value = self
            .value
            .ok_or_else(|| de::Error::custom("expected newtype variant value"))?;
        seed.deserialize(Deserializer::from_value(value))
    }

    fn tuple_variant<V>(self, len: usize, visitor: V) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        let value = self
            .value
            .ok_or_else(|| de::Error::custom("expected tuple variant value"))?;
        let values = match value {
            Value::Array(values) if values.len() == len => values,
            Value::Array(values) => {
                return Err(de::Error::custom(format!(
                    "tuple variant length mismatch: expected {len}, found {}",
                    values.len()
                )));
            }
            value => {
                return Err(de::Error::invalid_type(
                    unexpected(&value),
                    &"tuple variant",
                ));
            }
        };
        de::Deserializer::deserialize_seq(Deserializer::from_value(Value::Array(values)), visitor)
    }

    fn struct_variant<V>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> core::result::Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        let value = self
            .value
            .ok_or_else(|| de::Error::custom("expected struct variant value"))?;
        de::Deserializer::deserialize_map(Deserializer::from_value(value), visitor)
    }
}

pub fn from_str<T: DeserializeOwned + 'static>(s: &str, options: &Options) -> Result<T> {
    from_str_via_internal_value(s, options)
}

fn from_str_via_internal_value<T: DeserializeOwned>(s: &str, options: &Options) -> Result<T> {
    crate::decode::parser::validate_header_syntax(s, options.strict)?;
    let lines = crate::decode::scanner::scan(s);
    if options.strict {
        // Collect raw lines for tab detection
        let raw_lines: Vec<&str> = s
            .lines()
            .filter(|line| !line.trim_start_matches(' ').starts_with('#'))
            .collect();
        if let Err(e) = crate::decode::validation::validate_indentation_with_size(
            &lines,
            &raw_lines,
            options.indent,
        ) {
            return Err(crate::error::Error::Syntax {
                line: e.line,
                message: e.message,
            });
        }
    }
    let mut v = crate::decode::parser::parse_to_internal_value_from_lines_with_options(
        lines,
        options.strict,
        options.indent,
        options.expand_paths == crate::options::ExpandPaths::Safe,
    )?;

    // Apply path expansion if enabled
    if options.expand_paths == crate::options::ExpandPaths::Safe {
        v = crate::decode::path_expand::expand_paths(v, options.strict)
            .map_err(crate::error::Error::Message)?;
    }

    let deser = Deserializer::from_value(v);
    let t = T::deserialize(deser).map_err(|e: DeError| crate::error::Error::Message(e.msg))?;
    Ok(t)
}
