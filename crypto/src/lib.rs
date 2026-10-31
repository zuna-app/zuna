//! Zuna's encryption core.
//!
//! All cryptography in the clients goes through this crate, so the desktop app
//! and the iOS app share one implementation. The desktop loads it as
//! WebAssembly (`wasm.rs`), and the iOS app calls it natively through UniFFI
//! (`native.rs`). Both expose the same functions with the same results.

pub mod mls;
pub mod primitives;

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(not(target_arch = "wasm32"))]
mod native;

#[cfg(not(target_arch = "wasm32"))]
uniffi::setup_scaffolding!();
