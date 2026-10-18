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

const INLINE_MAP_VALUE_BYTES: usize = 48;
type MapEntry = (MapBytes<24>, MapBytes<INLINE_MAP_VALUE_BYTES>);

#[derive(Default)]
struct MapEntries {
    inline: [MapEntry; 2],
    heap: Vec<MapEntry>,
    len: usize,
    /// 남은 spill 예상 슬롯 — `with_length_hint` 이 채우고 첫 spill 에 소모한다.
    heap_hint: usize,
}

impl MapEntries {
    /// serde `serialize_map(len)` 이 준 길이 힌트를 첫 spill 에 정확히 한 번
    /// 쓴다 — BTreeMap/HashMap 은 항상 `Some(len)` 을 준다. spill 때 inline 의
    /// 항목도 heap 으로 옮겨지므로 heap 은 결국 `len` 개를 모두 담는다.
    /// `reserve(4)` + 배증은 큰 맵에서 재할당·복사가 반복되므로, 힌트가 있으면
    /// `reserve_exact` 로 spill 이 한 번의 할당으로 끝나게 한다. 길이는 사용자
    /// Serialize 구현이 주는 힌트라 64 항목까지만 신뢰한다. 그보다 큰 맵이나
    /// 거짓 힌트는 실제 항목 수에 따라 배증 성장한다.
    fn with_length_hint(hint: Option<usize>) -> Self {
        Self {
            heap_hint: hint.unwrap_or(0).min(64),
            ..Default::default()
        }
    }

    fn push(&mut self, entry: MapEntry) {
        if self.len < self.inline.len() {
            self.inline[self.len] = entry;
        } else {
            if self.len == self.inline.len() {
                if self.heap_hint > 0 {
                    self.heap.reserve_exact(self.heap_hint);
                    self.heap_hint = 0;
                } else {
                    self.heap.reserve(4);
                }
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
