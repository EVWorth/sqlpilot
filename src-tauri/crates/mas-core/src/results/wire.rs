//! How a stored cell crosses IPC.
//!
//! `SqlValue` serialises binary as an array of numbers, which costs three to
//! four bytes of JSON per byte and a boxed number each in the webview. A
//! window's cells and a single fetched cell carry it as base64 in a tagged
//! object instead: `{"bytes": "<base64>"}`. Every other value serialises
//! exactly as `SqlValue` does. `SqlValue`'s own serialisation is unchanged:
//! `execute_query` results and the code that reads them depend on it.

use crate::models::query::SqlValue;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A value read from the result store, in the shape it has on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum WireValue {
    Null(()),
    Bool(bool),
    // As on `SqlValue`: 64-bit columns travel as text, so what is left
    // fits a JSON number. The three numeric variants are one `number` in
    // TypeScript, so only one of them is exported.
    #[specta(skip)]
    Int(i64),
    #[specta(skip)]
    UInt(u64),
    #[specta(type = specta_typescript::Number)]
    Float(f64),
    String(String),
    /// Binary, base64-encoded (standard alphabet, padded).
    Bytes {
        bytes: String,
    },
}

impl From<SqlValue> for WireValue {
    fn from(value: SqlValue) -> Self {
        match value {
            SqlValue::Null => WireValue::Null(()),
            SqlValue::Bool(value) => WireValue::Bool(value),
            SqlValue::Int(value) => WireValue::Int(value),
            SqlValue::UInt(value) => WireValue::UInt(value),
            SqlValue::Float(value) => WireValue::Float(value),
            SqlValue::String(value) => WireValue::String(value),
            SqlValue::Bytes(value) => WireValue::Bytes {
                bytes: STANDARD.encode(value),
            },
        }
    }
}

impl TryFrom<WireValue> for SqlValue {
    type Error = base64::DecodeError;

    fn try_from(value: WireValue) -> Result<Self, Self::Error> {
        Ok(match value {
            WireValue::Null(()) => SqlValue::Null,
            WireValue::Bool(value) => SqlValue::Bool(value),
            WireValue::Int(value) => SqlValue::Int(value),
            WireValue::UInt(value) => SqlValue::UInt(value),
            WireValue::Float(value) => SqlValue::Float(value),
            WireValue::String(value) => SqlValue::String(value),
            WireValue::Bytes { bytes } => SqlValue::Bytes(STANDARD.decode(bytes)?),
        })
    }
}

#[derive(Serialize)]
struct EncodedBytes {
    bytes: String,
}

/// Serialise a `SqlValue` field as a [`WireValue`], for `#[serde(with)]`.
/// The bytes are encoded straight from the borrowed value; nothing else is
/// copied.
pub(super) fn serialize<S: Serializer>(value: &SqlValue, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        SqlValue::Bytes(bytes) => EncodedBytes {
            bytes: STANDARD.encode(bytes),
        }
        .serialize(serializer),
        other => other.serialize(serializer),
    }
}

pub(super) fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<SqlValue, D::Error> {
    WireValue::deserialize(deserializer)?
        .try_into()
        .map_err(serde::de::Error::custom)
}
