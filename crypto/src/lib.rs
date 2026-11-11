//! Zuna's encryption core.
//!
//! All cryptography in the clients goes through this crate, so every app shares
//! one implementation. The desktop app calls it as a Rust crate, the web app and
//! the tests load it as WebAssembly (`wasm.rs`), and the iOS app calls it through
//! UniFFI (`native.rs`, with the `uniffi` feature). The bindings expose the same
//! functions with the same results.

pub mod hybrid;
pub mod mls;
pub mod primitives;

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(all(not(target_arch = "wasm32"), feature = "uniffi"))]
mod native;

#[cfg(all(not(target_arch = "wasm32"), feature = "uniffi"))]
uniffi::setup_scaffolding!();
