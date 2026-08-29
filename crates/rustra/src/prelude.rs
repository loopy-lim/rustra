/// Commonly used Rustra types and macros.
#[allow(deprecated)]
// RendererHost 재수출 — 0.x 호환 계약이라 deprecated 지정돼 있지만 prelude 는
// 여전히 노출한다(문서 참조: 새 renderer 표면이 이 trait 을 구현하는 지점).
pub use crate::{
    BufferCommandInput, BufferCommandOutput, GeneratedPackage, Package, PackageBuilder, Result,
    RustraError, State, bridge_type, build, command,
    events::EventSink,
    ffi::FfiFormat,
    register,
    renderer_host::{
        HostMessage, MessageKind, RendererCapabilities, RendererHost, Size, SurfaceOptions,
        host_supports_eval,
    },
    rkyv_codec::encode_rkyv_v2_error,
};
pub use schemars::JsonSchema;
pub use serde::{Deserialize, Serialize};
