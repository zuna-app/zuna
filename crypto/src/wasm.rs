//! WebAssembly bindings for the desktop app.

use crate::{mls, primitives};
use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

type JsResult<T> = Result<T, JsError>;

fn to_js<T>(result: primitives::Result<T>) -> JsResult<T> {
    result.map_err(|e| JsError::new(&e))
}

fn bytes(data: &[u8]) -> JsValue {
    Uint8Array::from(data).into()
}

fn set(object: &Object, key: &str, value: JsValue) {
    Reflect::set(object, &JsValue::from_str(key), &value).expect("object is extensible");
}

fn key_pair((public, secret): (Vec<u8>, Vec<u8>)) -> Object {
    let object = Object::new();
    set(&object, "publicKey", bytes(&public));
    set(&object, "secretKey", bytes(&secret));
    object
}

fn byte_array(items: &[Vec<u8>]) -> Array {
    items.iter().map(|item| bytes(item)).collect()
}

fn from_byte_array(array: &Array) -> Vec<Vec<u8>> {
    array
        .iter()
        .map(|item| Uint8Array::new(&item).to_vec())
        .collect()
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(js_name = randomBytes)]
pub fn random_bytes(len: usize) -> JsResult<Vec<u8>> {
    to_js(primitives::random_bytes(len))
}

#[wasm_bindgen]
pub fn argon2id(
    password: &[u8],
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    out_len: usize,
) -> JsResult<Vec<u8>> {
    to_js(primitives::argon2id(
        password,
        salt,
        memory_kib,
        iterations,
        parallelism,
        out_len,
    ))
}

#[wasm_bindgen(js_name = hkdfSha256)]
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> JsResult<Vec<u8>> {
    to_js(primitives::hkdf_sha256(ikm, salt, info, len))
}

#[wasm_bindgen]
pub fn sha256(data: &[u8]) -> Vec<u8> {
    primitives::sha256(data)
}

#[wasm_bindgen(js_name = aeadSeal)]
pub fn aead_seal(key: &[u8], plaintext: &[u8], aad: &[u8]) -> JsResult<Vec<u8>> {
    to_js(primitives::aead_seal(key, plaintext, aad))
}

#[wasm_bindgen(js_name = aeadOpen)]
pub fn aead_open(key: &[u8], data: &[u8], aad: &[u8]) -> JsResult<Vec<u8>> {
    to_js(primitives::aead_open(key, data, aad))
}

#[wasm_bindgen(js_name = streamSeal)]
pub fn stream_seal(
    key: &[u8],
    prefix: &[u8],
    index: u32,
    last: bool,
    plaintext: &[u8],
) -> JsResult<Vec<u8>> {
    to_js(primitives::stream_seal(
        key,
        prefix,
        u64::from(index),
        last,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = streamOpen)]
pub fn stream_open(
    key: &[u8],
    prefix: &[u8],
    index: u32,
    last: bool,
    ciphertext: &[u8],
) -> JsResult<Vec<u8>> {
    to_js(primitives::stream_open(
        key,
        prefix,
        u64::from(index),
        last,
        ciphertext,
    ))
}

#[wasm_bindgen(js_name = signingKeygen)]
pub fn signing_keygen() -> JsResult<Object> {
    to_js(primitives::signing_keygen()).map(key_pair)
}

#[wasm_bindgen]
pub fn sign(secret: &[u8], message: &[u8]) -> JsResult<Vec<u8>> {
    to_js(primitives::sign(secret, message))
}

#[wasm_bindgen]
pub fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> bool {
    primitives::verify(public, message, signature)
}

#[wasm_bindgen(js_name = hpkeKeygen)]
pub fn hpke_keygen() -> JsResult<Object> {
    to_js(primitives::hpke_keygen()).map(key_pair)
}

#[wasm_bindgen(js_name = hpkeSeal)]
pub fn hpke_seal(recipient: &[u8], info: &[u8], aad: &[u8], plaintext: &[u8]) -> JsResult<Vec<u8>> {
    to_js(primitives::hpke_seal(recipient, info, aad, plaintext))
}

#[wasm_bindgen(js_name = hpkeOpen)]
pub fn hpke_open(secret: &[u8], info: &[u8], aad: &[u8], sealed: &[u8]) -> JsResult<Vec<u8>> {
    to_js(primitives::hpke_open(secret, info, aad, sealed))
}

#[wasm_bindgen(js_name = safetyDigest)]
pub fn safety_digest(key_a: &[u8], key_b: &[u8]) -> Vec<u8> {
    primitives::safety_digest(key_a, key_b)
}

fn pending_to_js(pending: mls::PendingCommit) -> Object {
    let object = Object::new();
    set(&object, "commit", bytes(&pending.commit));
    set(
        &object,
        "welcome",
        pending.welcome.as_deref().map_or(JsValue::NULL, bytes),
    );
    set(
        &object,
        "groupInfo",
        pending.group_info.as_deref().map_or(JsValue::NULL, bytes),
    );
    object
}

/// One device's MLS state. Call `takeChanges` after every mutating call and
/// write the result to disk before relying on the new state.
#[wasm_bindgen]
pub struct MlsClient {
    inner: mls::MlsClient,
}

#[wasm_bindgen]
impl MlsClient {
    /// `state` is an array of `[key, value]` pairs previously returned by
    /// `takeChanges`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        device_public: Vec<u8>,
        device_secret: Vec<u8>,
        credential: Vec<u8>,
        state: Array,
    ) -> MlsClient {
        let state = state
            .iter()
            .map(|entry| {
                let pair = Array::from(&entry);
                (
                    Uint8Array::new(&pair.get(0)).to_vec(),
                    Uint8Array::new(&pair.get(1)).to_vec(),
                )
            })
            .collect();
        MlsClient {
            inner: mls::MlsClient::new(device_public, device_secret, credential, state),
        }
    }

    #[wasm_bindgen(js_name = setCredential)]
    pub fn set_credential(&mut self, credential: Vec<u8>) {
        self.inner.set_credential(credential);
    }

    /// Returns `{ set: [[key, value], ...], deleted: [key, ...] }`.
    #[wasm_bindgen(js_name = takeChanges)]
    pub fn take_changes(&mut self) -> Object {
        let changes = self.inner.take_changes();
        let set_array: Array = changes
            .set
            .iter()
            .map(|(key, value)| Array::of2(&bytes(key), &bytes(value)))
            .collect();
        let object = Object::new();
        set(&object, "set", set_array.into());
        set(&object, "deleted", byte_array(&changes.deleted).into());
        object
    }

    /// Undoes everything since the last `takeChanges`.
    pub fn rollback(&self) {
        self.inner.rollback();
    }

    #[wasm_bindgen(js_name = hasGroup)]
    pub fn has_group(&self, group_id: &[u8]) -> JsResult<bool> {
        to_js(self.inner.has_group(group_id))
    }

    #[wasm_bindgen(js_name = generateKeyPackage)]
    pub fn generate_key_package(&self, last_resort: bool) -> JsResult<Vec<u8>> {
        to_js(self.inner.generate_key_package(last_resort))
    }

    #[wasm_bindgen(js_name = keyPackageCredential)]
    pub fn key_package_credential(&self, key_package: &[u8]) -> JsResult<Vec<u8>> {
        to_js(self.inner.key_package_credential(key_package))
    }

    #[wasm_bindgen(js_name = keyPackageSignatureKey)]
    pub fn key_package_signature_key(&self, key_package: &[u8]) -> JsResult<Vec<u8>> {
        to_js(self.inner.key_package_signature_key(key_package))
    }

    /// Starts a group; `roster` is null for one without a roster.
    #[wasm_bindgen(js_name = createGroup)]
    pub fn create_group(&self, group_id: &[u8], roster: Option<Vec<u8>>) -> JsResult<u32> {
        to_js(self.inner.create_group(group_id, roster.as_deref())).map(|epoch| epoch as u32)
    }

    /// Returns `{ commit, welcome, groupInfo }`; `welcome` and `groupInfo` may be null.
    #[wasm_bindgen(js_name = commitChanges)]
    pub fn commit_changes(
        &self,
        group_id: &[u8],
        key_packages: Array,
        remove_leaves: Vec<u32>,
        roster: Option<Vec<u8>>,
    ) -> JsResult<Object> {
        let key_packages = from_byte_array(&key_packages);
        to_js(
            self.inner
                .commit_changes(group_id, &key_packages, &remove_leaves, roster.as_deref()),
        )
        .map(pending_to_js)
    }

    #[wasm_bindgen(js_name = mergePending)]
    pub fn merge_pending(&self, group_id: &[u8]) -> JsResult<u32> {
        to_js(self.inner.merge_pending(group_id)).map(|epoch| epoch as u32)
    }

    #[wasm_bindgen(js_name = clearPending)]
    pub fn clear_pending(&self, group_id: &[u8]) -> JsResult<()> {
        to_js(self.inner.clear_pending(group_id))
    }

    #[wasm_bindgen(js_name = hasPending)]
    pub fn has_pending(&self, group_id: &[u8]) -> JsResult<bool> {
        to_js(self.inner.has_pending(group_id))
    }

    /// Returns `{ epoch, senderCredential, isExternal, addedCredentials,
    /// removedCredentials, selfRemoved }`.
    #[wasm_bindgen(js_name = processCommit)]
    pub fn process_commit(&self, group_id: &[u8], commit: &[u8]) -> JsResult<Object> {
        let processed = to_js(self.inner.process_commit(group_id, commit))?;
        let object = Object::new();
        set(&object, "epoch", JsValue::from(processed.epoch as u32));
        set(
            &object,
            "senderCredential",
            bytes(&processed.sender_credential),
        );
        set(&object, "isExternal", JsValue::from(processed.is_external));
        set(
            &object,
            "addedCredentials",
            byte_array(&processed.added_credentials).into(),
        );
        set(
            &object,
            "removedCredentials",
            byte_array(&processed.removed_credentials).into(),
        );
        set(&object, "selfRemoved", JsValue::from(processed.self_removed));
        Ok(object)
    }

    /// Returns `{ groupId, epoch }`.
    #[wasm_bindgen(js_name = joinFromWelcome)]
    pub fn join_from_welcome(&self, welcome: &[u8], group_id: &[u8]) -> JsResult<Object> {
        let (group_id, epoch) = to_js(self.inner.join_from_welcome(welcome, group_id))?;
        let object = Object::new();
        set(&object, "groupId", bytes(&group_id));
        set(&object, "epoch", JsValue::from(epoch as u32));
        Ok(object)
    }

    /// Returns `{ commit, epoch }`. The new state is already applied locally.
    #[wasm_bindgen(js_name = joinExternal)]
    pub fn join_external(&self, group_id: &[u8], group_info: &[u8]) -> JsResult<Object> {
        let (commit, epoch) = to_js(self.inner.join_external(group_id, group_info))?;
        let object = Object::new();
        set(&object, "commit", bytes(&commit));
        set(&object, "epoch", JsValue::from(epoch as u32));
        Ok(object)
    }

    #[wasm_bindgen(js_name = exportGroupInfo)]
    pub fn export_group_info(&self, group_id: &[u8]) -> JsResult<Vec<u8>> {
        to_js(self.inner.export_group_info(group_id))
    }

    pub fn epoch(&self, group_id: &[u8]) -> JsResult<u32> {
        to_js(self.inner.epoch(group_id)).map(|epoch| epoch as u32)
    }

    /// The roster in a group's context now, or undefined if it has none.
    #[wasm_bindgen]
    pub fn roster(&self, group_id: &[u8]) -> JsResult<Option<Vec<u8>>> {
        to_js(self.inner.roster(group_id))
    }

    #[wasm_bindgen(js_name = ownLeafIndex)]
    pub fn own_leaf_index(&self, group_id: &[u8]) -> JsResult<u32> {
        to_js(self.inner.own_leaf_index(group_id))
    }

    /// Returns `[{ leafIndex, credential, signatureKey }, ...]`.
    pub fn members(&self, group_id: &[u8]) -> JsResult<Array> {
        let members = to_js(self.inner.members(group_id))?;
        Ok(members
            .iter()
            .map(|member| {
                let object = Object::new();
                set(&object, "leafIndex", JsValue::from(member.leaf_index));
                set(&object, "credential", bytes(&member.credential));
                set(&object, "signatureKey", bytes(&member.signature_key));
                JsValue::from(object)
            })
            .collect())
    }

    #[wasm_bindgen(js_name = exportSecret)]
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: usize,
    ) -> JsResult<Vec<u8>> {
        to_js(self.inner.export_secret(group_id, label, context, len))
    }

    #[wasm_bindgen(js_name = exportPendingSecret)]
    pub fn export_pending_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: usize,
    ) -> JsResult<Vec<u8>> {
        to_js(self.inner.export_pending_secret(group_id, label, context, len))
    }

    #[wasm_bindgen(js_name = deleteGroup)]
    pub fn delete_group(&self, group_id: &[u8]) -> JsResult<()> {
        to_js(self.inner.delete_group(group_id))
    }
}
