use super::{ComplexCodecLimits, complex_codec_schema::error};
use crate::Result;

pub(crate) struct Writer<'s> {
    heap: Vec<u8>,
    into: Option<&'s mut [u8]>,
    pub(crate) written: usize,
    limits: ComplexCodecLimits,
}

impl<'s> Writer<'s> {
    pub(crate) fn new(limits: ComplexCodecLimits) -> Self {
        Self {
            heap: Vec::new(),
            into: None,
            written: 0,
            limits,
        }
    }
    pub(crate) fn into_slice(target: &'s mut [u8], limits: ComplexCodecLimits) -> Self {
        Self {
            heap: Vec::new(),
            into: Some(target),
            written: 0,
            limits,
        }
    }
    pub(crate) fn finish(self) -> Vec<u8> {
        debug_assert!(self.into.is_none());
        self.heap
    }
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<()> {
        let next_len = self.written.saturating_add(bytes.len());
        if next_len > self.limits.max_payload_bytes {
            return Err(error(format!(
                "payload exceeds {} bytes",
                self.limits.max_payload_bytes
            )));
        }
        match &mut self.into {
            Some(target) => {
                if next_len > target.len() {
                    return Err(error(format!(
                        "caller buffer overflow: {} bytes needed, {} available",
                        next_len,
                        target.len()
                    )));
                }
                target[self.written..next_len].copy_from_slice(bytes);
            }
            None => self.heap.extend_from_slice(bytes),
        }
        self.written = next_len;
        Ok(())
    }
    pub(crate) fn byte(&mut self, value: u8) -> Result<()> {
        self.push(&[value])
    }
    pub(crate) fn varint(&mut self, mut value: u128) -> Result<()> {
        let mut bytes = [0u8; 19];
        let mut length = 0;
        loop {
            let mut next = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                next |= 0x80;
            }
            bytes[length] = next;
            length += 1;
            if value == 0 {
                return self.push(&bytes[..length]);
            }
        }
    }
    pub(crate) fn zigzag(&mut self, value: i128) -> Result<()> {
        let encoded = if value >= 0 {
            (value as u128).saturating_mul(2)
        } else {
            value.unsigned_abs().saturating_mul(2).saturating_sub(1)
        };
        self.varint(encoded)
    }
    pub(crate) fn string(&mut self, value: &str) -> Result<()> {
        self.varint(value.len() as u128)?;
        self.push(value.as_bytes())
    }
}

pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    limits: ComplexCodecLimits,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8], limits: ComplexCodecLimits) -> Result<Self> {
        if bytes.len() > limits.max_payload_bytes {
            return Err(error(format!(
                "payload exceeds {} bytes",
                limits.max_payload_bytes
            )));
        }
        Ok(Self {
            bytes,
            offset: 0,
            limits,
        })
    }
    pub(crate) fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.offset)
    }
    pub(crate) fn raw(&mut self, length: usize) -> Result<&'a [u8]> {
        if self.remaining() < length {
            return Err(error("truncated complex payload"));
        }
        let start = self.offset;
        self.offset += length;
        Ok(&self.bytes[start..self.offset])
    }
    pub(crate) fn byte(&mut self) -> Result<u8> {
        Ok(*self.raw(1)?.first().unwrap())
    }
    pub(crate) fn varint(&mut self) -> Result<u128> {
        let mut value = 0u128;
        for (i, shift) in (0..=63u32).step_by(7).enumerate() {
            let byte = self.byte()?;
            if i == 9 && byte & 0x7f > 0x01 {
                return Err(error("varint exceeds 64 bits"));
            }
            value |= u128::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(error("varint is too long"))
    }
    pub(crate) fn zigzag(&mut self) -> Result<i128> {
        let value = self.varint()?;
        Ok(if value & 1 == 0 {
            (value >> 1) as i128
        } else {
            -((value >> 1) as i128) - 1
        })
    }
    pub(crate) fn length(&mut self) -> Result<usize> {
        let value = self.varint()?;
        if value > self.limits.max_collection_length as u128 || value > usize::MAX as u128 {
            return Err(error(format!(
                "collection length exceeds {}",
                self.limits.max_collection_length
            )));
        }
        Ok(value as usize)
    }
    pub(crate) fn string(&mut self) -> Result<String> {
        let length = self.length()?;
        let bytes = self.raw(length)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| error("invalid UTF-8 string"))
    }
}
