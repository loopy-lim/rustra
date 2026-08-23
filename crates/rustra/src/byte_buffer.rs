//! Serde adapter for contiguous byte fields on Rustra's postcard wire.
//!
//! Plain `Vec<u8>` is serialized as a generic sequence by Serde. That keeps
//! the wire correct, but some serializers/deserializers process every byte as
//! an individual sequence element. `#[serde(with = "rustra::byte_buffer")]`
//! preserves the same postcard bytes while selecting Serde's bulk byte API.

use serde::de::{SeqAccess, Visitor};
use serde::{Deserializer, Serializer};
use std::fmt;

/// Serialize a `Vec<u8>` through Serde's contiguous byte-buffer contract.
pub fn serialize<S>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_bytes(value)
}

/// Deserialize a contiguous byte buffer, retaining a sequence fallback for
/// JSON and other human-readable transports.
pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
where
    D: Deserializer<'de>,
{
    struct ByteBufferVisitor;

    impl<'de> Visitor<'de> for ByteBufferVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a byte buffer or a sequence of integers in 0..255")
        }

        fn visit_borrowed_bytes<E>(self, value: &'de [u8]) -> Result<Self::Value, E> {
            Ok(value.to_vec())
        }

        fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E> {
            Ok(value.to_vec())
        }

        fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E> {
            Ok(value)
        }

        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            let mut value = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
            while let Some(byte) = sequence.next_element::<u8>()? {
                value.push(byte);
            }
            Ok(value)
        }
    }

    deserializer.deserialize_byte_buf(ByteBufferVisitor)
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct FastBytes {
        #[serde(with = "super")]
        data: Vec<u8>,
    }

    #[derive(Deserialize, Serialize)]
    struct PlainBytes {
        data: Vec<u8>,
    }

    #[test]
    fn postcard_wire_matches_plain_vec_u8() {
        let fast = postcard::to_allocvec(&FastBytes {
            data: vec![0, 1, 127, 128, 255],
        })
        .unwrap();
        let plain = postcard::to_allocvec(&PlainBytes {
            data: vec![0, 1, 127, 128, 255],
        })
        .unwrap();
        assert_eq!(fast, plain);
        assert_eq!(
            postcard::from_bytes::<FastBytes>(&fast).unwrap().data,
            vec![0, 1, 127, 128, 255]
        );
    }

    #[test]
    fn json_keeps_the_number_array_contract() {
        let encoded = serde_json::to_string(&FastBytes {
            data: vec![1, 2, 250],
        })
        .unwrap();
        assert_eq!(encoded, r#"{"data":[1,2,250]}"#);
        assert_eq!(
            serde_json::from_str::<FastBytes>(&encoded).unwrap().data,
            vec![1, 2, 250]
        );
    }
}
