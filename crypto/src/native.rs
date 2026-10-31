//! Native bindings for the iOS app, generated with UniFFI.
//!
//! They mirror the WebAssembly bindings in `wasm.rs` one to one, so the client
//! core gets the same functions with the same results on every platform.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::{mls, primitives};

/// Any failure inside the encryption core. The message says what went wrong.
#[derive(Debug, uniffi::Error)]
pub enum CryptoError {
    Failed { message: String },
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::Failed { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for CryptoError {}

type NativeResult<T> = Result<T, CryptoError>;

fn native<T>(result: primitives::Result<T>) -> NativeResult<T> {
    result.map_err(|message| CryptoError::Failed { message })
}

#[derive(uniffi::Record)]
pub struct KeyPair {
    pub public_key: Vec<u8>,
    pub secret_key: Vec<u8>,
}

impl From<(Vec<u8>, Vec<u8>)> for KeyPair {
    fn from((public_key, secret_key): (Vec<u8>, Vec<u8>)) -> Self {
        KeyPair {
            public_key,
            secret_key,
        }
    }
}

#[uniffi::export]
pub fn random_bytes(len: u32) -> NativeResult<Vec<u8>> {
    native(primitives::random_bytes(len as usize))
}

#[uniffi::export]
pub fn argon2id(
    password: Vec<u8>,
    salt: Vec<u8>,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    out_len: u32,
) -> NativeResult<Vec<u8>> {
    native(primitives::argon2id(
        &password,
        &salt,
        memory_kib,
        iterations,
        parallelism,
        out_len as usize,
    ))
}

#[uniffi::export]
pub fn hkdf_sha256(ikm: Vec<u8>, salt: Vec<u8>, info: Vec<u8>, len: u32) -> NativeResult<Vec<u8>> {
    native(primitives::hkdf_sha256(&ikm, &salt, &info, len as usize))
}

#[uniffi::export]
pub fn sha256(data: Vec<u8>) -> Vec<u8> {
    primitives::sha256(&data)
}

#[uniffi::export]
pub fn aead_seal(key: Vec<u8>, plaintext: Vec<u8>, aad: Vec<u8>) -> NativeResult<Vec<u8>> {
    native(primitives::aead_seal(&key, &plaintext, &aad))
}

#[uniffi::export]
pub fn aead_open(key: Vec<u8>, data: Vec<u8>, aad: Vec<u8>) -> NativeResult<Vec<u8>> {
    native(primitives::aead_open(&key, &data, &aad))
}

#[uniffi::export]
pub fn stream_seal(
    key: Vec<u8>,
    prefix: Vec<u8>,
    index: u32,
    last: bool,
    plaintext: Vec<u8>,
) -> NativeResult<Vec<u8>> {
    native(primitives::stream_seal(
        &key,
        &prefix,
        u64::from(index),
        last,
        &plaintext,
    ))
}

#[uniffi::export]
pub fn stream_open(
    key: Vec<u8>,
    prefix: Vec<u8>,
    index: u32,
    last: bool,
    ciphertext: Vec<u8>,
) -> NativeResult<Vec<u8>> {
    native(primitives::stream_open(
        &key,
        &prefix,
        u64::from(index),
        last,
        &ciphertext,
    ))
}

#[uniffi::export]
pub fn signing_keygen() -> NativeResult<KeyPair> {
    native(primitives::signing_keygen()).map(KeyPair::from)
}

#[uniffi::export]
pub fn sign(secret: Vec<u8>, message: Vec<u8>) -> NativeResult<Vec<u8>> {
    native(primitives::sign(&secret, &message))
}

#[uniffi::export]
pub fn verify(public_key: Vec<u8>, message: Vec<u8>, signature: Vec<u8>) -> bool {
    primitives::verify(&public_key, &message, &signature)
}

#[uniffi::export]
pub fn hpke_keygen() -> NativeResult<KeyPair> {
    native(primitives::hpke_keygen()).map(KeyPair::from)
}

#[uniffi::export]
pub fn hpke_seal(
    recipient: Vec<u8>,
    info: Vec<u8>,
    aad: Vec<u8>,
    plaintext: Vec<u8>,
) -> NativeResult<Vec<u8>> {
    native(primitives::hpke_seal(&recipient, &info, &aad, &plaintext))
}

#[uniffi::export]
pub fn hpke_open(
    secret: Vec<u8>,
    info: Vec<u8>,
    aad: Vec<u8>,
    sealed: Vec<u8>,
) -> NativeResult<Vec<u8>> {
    native(primitives::hpke_open(&secret, &info, &aad, &sealed))
}

#[uniffi::export]
pub fn safety_digest(key_a: Vec<u8>, key_b: Vec<u8>) -> Vec<u8> {
    primitives::safety_digest(&key_a, &key_b)
}

/// One key and value of the persisted MLS state.
#[derive(uniffi::Record)]
pub struct StateEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct StateChanges {
    pub set: Vec<StateEntry>,
    pub deleted: Vec<Vec<u8>>,
}

#[derive(uniffi::Record)]
pub struct PendingCommit {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub group_info: Option<Vec<u8>>,
}

#[derive(uniffi::Record)]
pub struct ProcessedCommit {
    pub epoch: u64,
    pub sender_credential: Vec<u8>,
    pub is_external: bool,
    pub added_credentials: Vec<Vec<u8>>,
    pub removed_credentials: Vec<Vec<u8>>,
    pub self_removed: bool,
}

#[derive(uniffi::Record)]
pub struct JoinedGroup {
    pub group_id: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct ExternalJoin {
    pub commit: Vec<u8>,
    pub epoch: u64,
}

#[derive(uniffi::Record)]
pub struct Member {
    pub leaf_index: u32,
    pub credential: Vec<u8>,
    pub signature_key: Vec<u8>,
}

/// One device's MLS state. Call `take_changes` after every mutating call and
/// write the result to disk before relying on the new state.
#[derive(uniffi::Object)]
pub struct MlsClient {
    inner: Mutex<mls::MlsClient>,
}

impl MlsClient {
    fn client(&self) -> MutexGuard<'_, mls::MlsClient> {
        // A panic aborts the process, so a poisoned lock can't hold half-done state.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl MlsClient {
    #[uniffi::constructor]
    pub fn new(
        device_public: Vec<u8>,
        device_secret: Vec<u8>,
        credential: Vec<u8>,
        state: Vec<StateEntry>,
    ) -> Arc<Self> {
        let state = state
            .into_iter()
            .map(|entry| (entry.key, entry.value))
            .collect();
        Arc::new(MlsClient {
            inner: Mutex::new(mls::MlsClient::new(
                device_public,
                device_secret,
                credential,
                state,
            )),
        })
    }

    pub fn take_changes(&self) -> StateChanges {
        let changes = self.client().take_changes();
        StateChanges {
            set: changes
                .set
                .into_iter()
                .map(|(key, value)| StateEntry { key, value })
                .collect(),
            deleted: changes.deleted,
        }
    }

    /// Undoes everything since the last `take_changes`.
    pub fn rollback(&self) {
        self.client().rollback();
    }

    pub fn has_group(&self, group_id: Vec<u8>) -> NativeResult<bool> {
        native(self.client().has_group(&group_id))
    }

    pub fn generate_key_package(&self, last_resort: bool) -> NativeResult<Vec<u8>> {
        native(self.client().generate_key_package(last_resort))
    }

    pub fn key_package_credential(&self, key_package: Vec<u8>) -> NativeResult<Vec<u8>> {
        native(self.client().key_package_credential(&key_package))
    }

    pub fn key_package_signature_key(&self, key_package: Vec<u8>) -> NativeResult<Vec<u8>> {
        native(self.client().key_package_signature_key(&key_package))
    }

    pub fn create_group(&self, group_id: Vec<u8>) -> NativeResult<u64> {
        native(self.client().create_group(&group_id))
    }

    pub fn commit_changes(
        &self,
        group_id: Vec<u8>,
        key_packages: Vec<Vec<u8>>,
        remove_leaves: Vec<u32>,
    ) -> NativeResult<PendingCommit> {
        let pending = native(
            self.client()
                .commit_changes(&group_id, &key_packages, &remove_leaves),
        )?;
        Ok(PendingCommit {
            commit: pending.commit,
            welcome: pending.welcome,
            group_info: pending.group_info,
        })
    }

    pub fn merge_pending(&self, group_id: Vec<u8>) -> NativeResult<u64> {
        native(self.client().merge_pending(&group_id))
    }

    pub fn clear_pending(&self, group_id: Vec<u8>) -> NativeResult<()> {
        native(self.client().clear_pending(&group_id))
    }

    pub fn has_pending(&self, group_id: Vec<u8>) -> NativeResult<bool> {
        native(self.client().has_pending(&group_id))
    }

    pub fn process_commit(
        &self,
        group_id: Vec<u8>,
        commit: Vec<u8>,
    ) -> NativeResult<ProcessedCommit> {
        let processed = native(self.client().process_commit(&group_id, &commit))?;
        Ok(ProcessedCommit {
            epoch: processed.epoch,
            sender_credential: processed.sender_credential,
            is_external: processed.is_external,
            added_credentials: processed.added_credentials,
            removed_credentials: processed.removed_credentials,
            self_removed: processed.self_removed,
        })
    }

    pub fn join_from_welcome(&self, welcome: Vec<u8>) -> NativeResult<JoinedGroup> {
        let (group_id, epoch) = native(self.client().join_from_welcome(&welcome))?;
        Ok(JoinedGroup { group_id, epoch })
    }

    /// The new state is already applied locally.
    pub fn join_external(
        &self,
        group_id: Vec<u8>,
        group_info: Vec<u8>,
    ) -> NativeResult<ExternalJoin> {
        let (commit, epoch) = native(self.client().join_external(&group_id, &group_info))?;
        Ok(ExternalJoin { commit, epoch })
    }

    pub fn export_group_info(&self, group_id: Vec<u8>) -> NativeResult<Vec<u8>> {
        native(self.client().export_group_info(&group_id))
    }

    pub fn epoch(&self, group_id: Vec<u8>) -> NativeResult<u64> {
        native(self.client().epoch(&group_id))
    }

    pub fn own_leaf_index(&self, group_id: Vec<u8>) -> NativeResult<u32> {
        native(self.client().own_leaf_index(&group_id))
    }

    pub fn members(&self, group_id: Vec<u8>) -> NativeResult<Vec<Member>> {
        let members = native(self.client().members(&group_id))?;
        Ok(members
            .into_iter()
            .map(|member| Member {
                leaf_index: member.leaf_index,
                credential: member.credential,
                signature_key: member.signature_key,
            })
            .collect())
    }

    pub fn export_secret(
        &self,
        group_id: Vec<u8>,
        label: String,
        context: Vec<u8>,
        len: u32,
    ) -> NativeResult<Vec<u8>> {
        native(
            self.client()
                .export_secret(&group_id, &label, &context, len as usize),
        )
    }

    pub fn export_pending_secret(
        &self,
        group_id: Vec<u8>,
        label: String,
        context: Vec<u8>,
        len: u32,
    ) -> NativeResult<Vec<u8>> {
        native(
            self.client()
                .export_pending_secret(&group_id, &label, &context, len as usize),
        )
    }

    pub fn delete_group(&self, group_id: Vec<u8>) -> NativeResult<()> {
        native(self.client().delete_group(&group_id))
    }
}
