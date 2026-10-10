pub struct StructVariantSerializer {
    map: Map<String, Value>,
    name: String,
}

impl SerializeStructVariant for StructVariantSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Self::Error> {
        let mut ser = ValueSerializer;
        let v = value.serialize(&mut ser)?;
        self.map.insert(key.to_string(), v);
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        let mut m = Map::new();
        m.insert(self.name, Value::Object(self.map));
        Ok(Value::Object(m))
    }
}

use serde::ser::*;
use serde_json::{Map, Number, Value};

use crate::options::Options;

pub fn to_value<T: Serialize + ?Sized>(
    value: &T,
    _options: &Options,
) -> Result<Value, serde_json::Error> {
    let mut ser = ValueSerializer;
    value.serialize(&mut ser)
}

struct ValueSerializer;

impl Serializer for &mut ValueSerializer {
    type Ok = Value;
    type Error = serde_json::Error;
    type SerializeSeq = SeqSerializer;
    type SerializeTuple = SeqSerializer;
    type SerializeTupleStruct = SeqSerializer;
    type SerializeTupleVariant = VariantSeqSerializer;
    type SerializeMap = MapSerializer;
    type SerializeStruct = MapSerializer;
    type SerializeStructVariant = StructVariantSerializer;

    fn serialize_bool(self, v: bool) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as i64).into()))
    }
    fn serialize_i16(self, v: i16) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as i64).into()))
    }
    fn serialize_i32(self, v: i32) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as i64).into()))
    }
    fn serialize_i64(self, v: i64) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number(v.into()))
    }
    fn serialize_u8(self, v: u8) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as u64).into()))
    }
    fn serialize_u16(self, v: u16) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as u64).into()))
    }
    fn serialize_u32(self, v: u32) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number((v as u64).into()))
    }
    fn serialize_u64(self, v: u64) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Number(v.into()))
    }
    fn serialize_f32(self, v: f32) -> Result<Self::Ok, Self::Error> {
        let f = v as f64;
        if let Some(num) = Number::from_f64(f) {
            Ok(Value::Number(num))
        } else {
            Ok(Value::Null)
        }
    }
    fn serialize_f64(self, f: f64) -> Result<Self::Ok, Self::Error> {
        if let Some(num) = Number::from_f64(f) {
            Ok(Value::Number(num))
        } else {
            Ok(Value::Null)
        }
    }
    fn serialize_char(self, v: char) -> Result<Self::Ok, Self::Error> {
        Ok(Value::String(v.to_string()))
    }
    fn serialize_str(self, v: &str) -> Result<Self::Ok, Self::Error> {
        Ok(Value::String(v.to_string()))
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Array(
            v.iter()
                .map(|b| Value::Number((*b as u64).into()))
                .collect(),
        ))
    }
    fn serialize_none(self) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Null)
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<Self::Ok, Self::Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Null)
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Null)
    }
    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
    ) -> Result<Self::Ok, Self::Error> {
        Ok(Value::String(variant.to_string()))
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Self::Ok, Self::Error> {
        let mut m = Map::new();
        m.insert(variant.to_string(), value.serialize(&mut *self)?);
        Ok(Value::Object(m))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
        Ok(SeqSerializer {
            elems: Vec::with_capacity(len.unwrap_or(0)),
        })
    }
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Self::Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant, Self::Error> {
        Ok(VariantSeqSerializer {
            variant: variant.to_string(),
            elems: Vec::new(),
        })
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
        Ok(MapSerializer {
            map: Map::new(),
            next_key: None,
        })
    }
    fn serialize_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStruct, Self::Error> {
        Ok(MapSerializer {
            map: Map::new(),
            next_key: None,
        })
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _variant_index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant, Self::Error> {
        Ok(StructVariantSerializer {
            map: Map::new(),
            name: variant.to_string(),
        })
    }
}

pub struct SeqSerializer {
    elems: Vec<Value>,
}

impl SerializeSeq for SeqSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        let mut ser = ValueSerializer;
        self.elems.push(value.serialize(&mut ser)?);
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Array(self.elems))
    }
}

impl SerializeTuple for SeqSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        SerializeSeq::end(self)
    }
}

impl SerializeTupleStruct for SeqSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        SerializeSeq::end(self)
    }
}

impl SerializeTupleVariant for SeqSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Self::Ok, Self::Error> {
        Ok(Value::Array(self.elems))
    }
}

struct VariantSeqSerializer {
    variant: String,
    elems: Vec<Value>,
}

impl SerializeTupleVariant for VariantSeqSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        let mut ser = ValueSerializer;
        self.elems.push(value.serialize(&mut ser)?);
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        let mut object = Map::new();
        object.insert(self.variant, Value::Array(self.elems));
        Ok(Value::Object(object))
    }
}

pub struct MapSerializer {
    map: Map<String, Value>,
    next_key: Option<String>,
}

impl SerializeMap for MapSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Self::Error> {
        let mut ser = ValueSerializer;
        let v = key.serialize(&mut ser)?;
        let s = match v {
            Value::String(s) => s,
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => {
                if b {
                    "true".into()
                } else {
                    "false".into()
                }
            }
            Value::Null => "null".into(),
            Value::Array(_) | Value::Object(_) => {
                return Err(serde_json::Error::custom("map key must be a scalar"));
            }
        };
        self.next_key = Some(s);
        Ok(())
    }

    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Self::Error> {
        let Some(k) = self.next_key.take() else {
            return Err(serde_json::Error::custom(
                "serialize_value called before serialize_key",
            ));
        };
        let mut ser = ValueSerializer;
        let v = value.serialize(&mut ser)?;
        self.map.insert(k, v);
        Ok(())
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        if let Some(k) = self.next_key {
            // dangling key, set null
            let mut map = self.map;
            map.insert(k, Value::Null);
            Ok(Value::Object(map))
        } else {
            Ok(Value::Object(self.map))
        }
    }
}

impl SerializeStruct for MapSerializer {
    type Ok = Value;
    type Error = serde_json::Error;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Self::Error> {
        SerializeMap::serialize_key(self, &key)?;
        SerializeMap::serialize_value(self, value)
    }

    fn end(self) -> Result<Self::Ok, Self::Error> {
        SerializeMap::end(self)
    }
}
