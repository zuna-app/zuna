//! Sound and video through Windows's own media: Media Foundation reads and writes them,
//! and waveIn and waveOut record and play the sound.

pub mod encode;
pub mod mf;
pub mod player;
pub mod record;
