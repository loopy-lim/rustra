use crate::rkyv_codec::RawFieldKind;

fn decode_raw_output(encoded: &[u8], out_kind: RawFieldKind) -> crate::Result<u64> {
    let mut r: &[u8] = encoded;
    let read_varint = |bytes: &mut &[u8]| -> u64 {
        let mut v = 0u64;
        let mut shift = 0;
        loop {
            let b = bytes[0];
            *bytes = &bytes[1..];
            v |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        v
    };
    let slot = match out_kind {
        RawFieldKind::Zigzag => {
            let zig = read_varint(&mut r);
            let v = ((zig >> 1) as i64) ^ -((zig & 1) as i64);
            v as u64
        }
        RawFieldKind::Uvar => read_varint(&mut r),
        RawFieldKind::F64 => {
            let mut bits = [0u8; 8];
            bits.copy_from_slice(&r[..8]);
            u64::from_le_bytes(bits)
        }
        RawFieldKind::F32 => {
            let mut b4 = [0u8; 4];
            b4.copy_from_slice(&r[..4]);
            let f = f32::from_le_bytes(b4);
            crate::rkyv_codec::u64_from_f64(f as f64)
        }
        RawFieldKind::Bool => u64::from(r[0] != 0),
    };
    Ok(slot)
}
