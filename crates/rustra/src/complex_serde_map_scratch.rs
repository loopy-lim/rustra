// Small maps keep their owned, sortable bytes on the stack. Larger keys,
// values and maps spill independently; Serialize is never replayed to spill.
enum MapBytes<const N: usize> {
    Inline { bytes: [u8; N], len: usize },
    Heap(Vec<u8>),
}

impl<const N: usize> Default for MapBytes<N> {
    fn default() -> Self {
        Self::Inline {
            bytes: [0; N],
            len: 0,
        }
    }
}

impl<const N: usize> MapBytes<N> {
    fn serialize(
        limits: ComplexCodecLimits,
        action: impl FnOnce(&mut Writer<'_>) -> Result<()>,
    ) -> Result<Self> {
        let mut bytes = [0; N];
        let mut writer = Writer::with_scratch(&mut bytes, limits);
        action(&mut writer)?;
        let len = writer.written;
        Ok(match writer.finish_scratch() {
            Some(heap) => Self::Heap(heap),
            None => Self::Inline { bytes, len },
        })
    }

    fn as_slice(&self) -> &[u8] {
        match self {
            Self::Inline { bytes, len } => &bytes[..*len],
            Self::Heap(bytes) => bytes,
        }
    }
}

type MapEntry = (MapBytes<24>, MapBytes<48>);

#[derive(Default)]
struct MapEntries {
    inline: [MapEntry; 2],
    heap: Vec<MapEntry>,
    len: usize,
}

impl MapEntries {
    fn push(&mut self, entry: MapEntry) {
        if self.len < self.inline.len() {
            self.inline[self.len] = entry;
        } else {
            if self.len == self.inline.len() {
                self.heap.reserve(4);
                for entry in &mut self.inline {
                    self.heap.push(std::mem::take(entry));
                }
            }
            self.heap.push(entry);
        }
        self.len += 1;
    }

    fn as_mut_slice(&mut self) -> &mut [MapEntry] {
        if self.len <= self.inline.len() {
            &mut self.inline[..self.len]
        } else {
            &mut self.heap
        }
    }
}
