/// Commonly used Rustra types and macros.
// deprecated RendererHost 재노출은 0.x 호환 계약이다.
#[allow(deprecated)]
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
