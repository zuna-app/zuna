//! MLS (RFC 9420) group state for one device, built on OpenMLS.
//!
//! The server only ever sees the opaque bytes this module produces. It orders
//! commits for each group, which is all MLS asks of a delivery service.

use std::collections::HashMap;

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use tls_codec::{Deserialize as _, Serialize as _};

use crate::primitives::Result;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// Epochs a member keeps past message secrets for. Commits are applied strictly
/// in order and content is encrypted under exported keys, so none are needed.
const MAX_PAST_EPOCHS: usize = 0;

fn err<E: std::fmt::Debug>(context: &'static str) -> impl FnOnce(E) -> String {
    move |e| format!("{context}: {e:?}")
}

/// A commit ready to send. Nothing takes effect locally until the server has
/// accepted it and [`MlsClient::merge_pending`] is called.
pub struct PendingCommit {
    pub commit: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub group_info: Option<Vec<u8>>,
}

pub struct MemberInfo {
    pub leaf_index: u32,
    pub credential: Vec<u8>,
    pub signature_key: Vec<u8>,
}

/// Authenticated description of a commit that was just applied.
pub struct ProcessedCommit {
    pub epoch: u64,
    /// The sender's credential, authenticated by MLS.
    pub sender_credential: Vec<u8>,
    pub is_external: bool,
    pub added_credentials: Vec<Vec<u8>>,
    pub removed_credentials: Vec<Vec<u8>>,
    /// True if this commit removed this device from the group.
    pub self_removed: bool,
}

/// A change to the persisted key/value state since the last checkpoint.
#[derive(Default)]
pub struct StateChanges {
    pub set: Vec<(Vec<u8>, Vec<u8>)>,
    pub deleted: Vec<Vec<u8>>,
}

pub struct MlsClient {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
    /// Last persisted copy of the storage, used to work out what changed.
    checkpoint: HashMap<Vec<u8>, Vec<u8>>,
}

impl MlsClient {
    /// Creates a client for a device. `device_secret` and `device_public` are
    /// the device's Ed25519 keys; `credential` is the opaque, identity-signed
    /// device certificate placed in the MLS `BasicCredential`.
    pub fn new(
        device_public: Vec<u8>,
        device_secret: Vec<u8>,
        credential: Vec<u8>,
        state: Vec<(Vec<u8>, Vec<u8>)>,
    ) -> Self {
        let provider = OpenMlsRustCrypto::default();
        let checkpoint: HashMap<_, _> = state.into_iter().collect();
        *provider.storage().values.write().unwrap() = checkpoint.clone();
        let signer = SignatureKeyPair::from_raw(
            CIPHERSUITE.signature_algorithm(),
            device_secret,
            device_public.clone(),
        );
        let credential = CredentialWithKey {
            credential: BasicCredential::new(credential).into(),
            signature_key: device_public.into(),
        };
        Self {
            provider,
            signer,
            credential,
            checkpoint,
        }
    }

    /// Returns what changed in storage since the last call, so the caller can
    /// write it atomically to its database.
    pub fn take_changes(&mut self) -> StateChanges {
        let values = self.provider.storage().values.read().unwrap();
        let mut changes = StateChanges::default();
        for (key, value) in values.iter() {
            if self.checkpoint.get(key) != Some(value) {
                changes.set.push((key.clone(), value.clone()));
            }
        }
        for key in self.checkpoint.keys() {
            if !values.contains_key(key) {
                changes.deleted.push(key.clone());
            }
        }
        self.checkpoint = values.clone();
        changes
    }

    fn create_config() -> MlsGroupCreateConfig {
        MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            // Member commits are encrypted; external commits are always public.
            .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build()
    }

    fn join_config() -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .build()
    }

    fn load(&self, group_id: &[u8]) -> Result<MlsGroup> {
        MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(err("load group"))?
            .ok_or_else(|| "unknown group".to_string())
    }

    pub fn has_group(&self, group_id: &[u8]) -> Result<bool> {
        Ok(
            MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
                .map_err(err("load group"))?
                .is_some_and(|group| group.is_active()),
        )
    }

    pub fn generate_key_package(&self, last_resort: bool) -> Result<Vec<u8>> {
        let mut builder = KeyPackage::builder();
        if last_resort {
            builder = builder.mark_as_last_resort();
        }
        let bundle = builder
            .build(
                CIPHERSUITE,
                &self.provider,
                &self.signer,
                self.credential.clone(),
            )
            .map_err(err("key package"))?;
        bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(err("key package encode"))
    }

    pub fn create_group(&self, group_id: &[u8]) -> Result<u64> {
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &Self::create_config(),
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .map_err(err("create group"))?;
        Ok(group.epoch().as_u64())
    }

    fn parse_key_packages(&self, key_packages: &[Vec<u8>]) -> Result<Vec<KeyPackage>> {
        key_packages
            .iter()
            .map(|bytes| {
                KeyPackageIn::tls_deserialize_exact(bytes)
                    .map_err(err("key package decode"))?
                    .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                    .map_err(err("key package invalid"))
            })
            .collect()
    }

    /// Credential carried by a key package, so a caller can verify the device
    /// certificate before adding that device to a group.
    pub fn key_package_credential(&self, key_package: &[u8]) -> Result<Vec<u8>> {
        let parsed = self.parse_key_packages(&[key_package.to_vec()])?;
        credential_bytes(parsed[0].leaf_node().credential())
    }

    /// Builds one commit that adds and removes members, then keeps it pending.
    pub fn commit_changes(
        &self,
        group_id: &[u8],
        key_packages: &[Vec<u8>],
        remove_leaves: &[u32],
    ) -> Result<PendingCommit> {
        let mut group = self.load(group_id)?;
        let adds = self.parse_key_packages(key_packages)?;
        let removes = remove_leaves.iter().map(|i| LeafNodeIndex::new(*i));
        let bundle = group
            .commit_builder()
            .propose_adds(adds)
            .propose_removals(removes)
            .force_self_update(true)
            .load_psks(self.provider.storage())
            .map_err(err("commit psks"))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(err("commit build"))?
            .stage_commit(&self.provider)
            .map_err(err("commit stage"))?;
        let (commit, welcome, group_info) = bundle.into_messages();
        Ok(PendingCommit {
            commit: encode(&commit)?,
            welcome: welcome.as_ref().map(encode).transpose()?,
            group_info: group_info.as_ref().map(encode).transpose()?,
        })
    }

    pub fn merge_pending(&self, group_id: &[u8]) -> Result<u64> {
        let mut group = self.load(group_id)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(err("merge commit"))?;
        Ok(group.epoch().as_u64())
    }

    pub fn clear_pending(&self, group_id: &[u8]) -> Result<()> {
        let mut group = self.load(group_id)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(err("clear commit"))
    }

    pub fn has_pending(&self, group_id: &[u8]) -> Result<bool> {
        Ok(self.load(group_id)?.pending_commit().is_some())
    }

    /// Applies a commit from another device.
    pub fn process_commit(&self, group_id: &[u8], bytes: &[u8]) -> Result<ProcessedCommit> {
        let mut group = self.load(group_id)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(err("commit decode"))?;
        let protocol = message
            .try_into_protocol_message()
            .map_err(err("commit type"))?;
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(err("commit process"))?;
        let sender_credential = credential_or_empty(processed.credential());
        let is_external = matches!(processed.sender(), Sender::NewMemberCommit);
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err("expected a commit".into());
        };

        let added_credentials = staged
            .add_proposals()
            .map(|p| credential_or_empty(p.add_proposal().key_package().leaf_node().credential()))
            .collect::<Vec<_>>();
        let mut removed_credentials = Vec::new();
        for remove in staged.remove_proposals() {
            if let Some(credential) = group.member(remove.remove_proposal().removed()) {
                removed_credentials.push(credential_or_empty(credential));
            }
        }
        let self_removed = staged.self_removed();

        group
            .merge_staged_commit(&self.provider, *staged)
            .map_err(err("commit merge"))?;
        Ok(ProcessedCommit {
            epoch: group.epoch().as_u64(),
            sender_credential,
            is_external,
            added_credentials,
            removed_credentials,
            self_removed,
        })
    }

    /// Joins from a Welcome. Returns the group ID and epoch.
    pub fn join_from_welcome(&self, bytes: &[u8]) -> Result<(Vec<u8>, u64)> {
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(err("welcome decode"))?;
        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
            return Err("expected a welcome".into());
        };
        let group = StagedWelcome::build_from_welcome(&self.provider, &Self::join_config(), welcome)
            .map_err(err("welcome process"))?
            // A leaf that hasn't updated for months is still a valid member;
            // its lifetime shouldn't stop new people from joining the group.
            .skip_lifetime_validation()
            .replace_old_group()
            .build()
            .map_err(err("welcome stage"))?
            .into_group(&self.provider)
            .map_err(err("welcome join"))?;
        Ok((group.group_id().to_vec(), group.epoch().as_u64()))
    }

    /// Joins via an external commit, used for new devices and for repairing a
    /// device whose group state was lost. The old state is replaced if present.
    pub fn join_external(&self, group_id: &[u8], group_info: &[u8]) -> Result<(Vec<u8>, u64)> {
        let message = MlsMessageIn::tls_deserialize_exact(group_info)
            .map_err(err("group info decode"))?;
        let MlsMessageBodyIn::GroupInfo(info) = message.extract() else {
            return Err("expected group info".into());
        };
        if info.group_id().as_slice() != group_id {
            return Err("group info is for a different group".into());
        }
        if let Some(mut existing) =
            MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
                .map_err(err("load group"))?
        {
            existing
                .delete(self.provider.storage())
                .map_err(err("delete group"))?;
        }
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(Self::join_config())
            .skip_lifetime_validation()
            .build_group(&self.provider, info, self.credential.clone())
            .map_err(err("external build"))?
            .load_psks(self.provider.storage())
            .map_err(err("external psks"))?
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .map_err(err("external commit"))?
            .finalize(&self.provider)
            .map_err(err("external finalize"))?;
        let (commit, _, _) = bundle.into_messages();
        Ok((encode(&commit)?, group.epoch().as_u64()))
    }

    /// Exports a group info usable for external joins at the current epoch.
    pub fn export_group_info(&self, group_id: &[u8]) -> Result<Vec<u8>> {
        let group = self.load(group_id)?;
        let info = group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .map_err(err("export group info"))?;
        encode(&info)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64> {
        Ok(self.load(group_id)?.epoch().as_u64())
    }

    pub fn own_leaf_index(&self, group_id: &[u8]) -> Result<u32> {
        Ok(self.load(group_id)?.own_leaf_index().u32())
    }

    pub fn members(&self, group_id: &[u8]) -> Result<Vec<MemberInfo>> {
        let group = self.load(group_id)?;
        group
            .members()
            .map(|m| {
                Ok(MemberInfo {
                    leaf_index: m.index.u32(),
                    credential: credential_or_empty(&m.credential),
                    signature_key: m.signature_key,
                })
            })
            .collect()
    }

    /// RFC 9420 section 8.5 exporter: the source of each epoch's content key.
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: usize,
    ) -> Result<Vec<u8>> {
        self.load(group_id)?
            .export_secret(self.provider.crypto(), label, context, len)
            .map_err(err("export secret"))
    }

    /// Exporter for the epoch a pending commit will create. It lets a committer
    /// encrypt data for the new epoch in the same request as the commit itself.
    pub fn export_pending_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: usize,
    ) -> Result<Vec<u8>> {
        let group = self.load(group_id)?;
        let pending = group
            .pending_commit()
            .ok_or_else(|| "no pending commit".to_string())?;
        pending
            .export_secret(self.provider.crypto(), label, context, len)
            .map_err(err("export pending secret"))
    }

    /// Forgets a group completely, for example after being removed from it.
    pub fn delete_group(&self, group_id: &[u8]) -> Result<()> {
        if let Some(mut group) =
            MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
                .map_err(err("load group"))?
        {
            group
                .delete(self.provider.storage())
                .map_err(err("delete group"))?;
        }
        Ok(())
    }
}

fn encode(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message
        .tls_serialize_detached()
        .map_err(err("message encode"))
}

/// A credential of another type carries no certificate. It reads as empty, which
/// fails every check on it, so one odd leaf can't make a whole group unreadable.
fn credential_or_empty(credential: &Credential) -> Vec<u8> {
    credential_bytes(credential).unwrap_or_default()
}

fn credential_bytes(credential: &Credential) -> Result<Vec<u8>> {
    let basic = BasicCredential::try_from(credential.clone()).map_err(err("credential type"))?;
    Ok(basic.identity().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitives::signing_keygen;

    const GROUP: &[u8] = b"0123456789abcdef";

    fn client(name: &str) -> MlsClient {
        let (public, secret) = signing_keygen().unwrap();
        MlsClient::new(public, secret, name.as_bytes().to_vec(), vec![])
    }

    fn exported(client: &MlsClient) -> Vec<u8> {
        client
            .export_secret(GROUP, "zuna/test", b"", 32)
            .unwrap()
    }

    /// Alice creates a group and adds Bob; both then share the exported key.
    fn pair() -> (MlsClient, MlsClient) {
        let alice = client("alice");
        let bob = client("bob");
        alice.create_group(GROUP).unwrap();
        let kp = bob.generate_key_package(false).unwrap();
        let pending = alice.commit_changes(GROUP, &[kp], &[]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        let (id, _) = bob.join_from_welcome(&pending.welcome.unwrap()).unwrap();
        assert_eq!(id, GROUP);
        (alice, bob)
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn welcome_gives_both_members_the_same_exporter_key() {
        let (alice, bob) = pair();
        assert_eq!(exported(&alice), exported(&bob));
        assert_eq!(alice.epoch(GROUP).unwrap(), bob.epoch(GROUP).unwrap());
        assert_eq!(alice.members(GROUP).unwrap().len(), 2);
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn commits_rotate_the_key_and_describe_the_change() {
        let (alice, bob) = pair();
        let before = exported(&alice);
        let carol = client("carol");
        let kp = carol.generate_key_package(false).unwrap();

        let pending = alice.commit_changes(GROUP, &[kp], &[]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        let processed = bob.process_commit(GROUP, &pending.commit).unwrap();
        carol.join_from_welcome(&pending.welcome.unwrap()).unwrap();

        assert_eq!(processed.sender_credential, b"alice");
        assert_eq!(processed.added_credentials, vec![b"carol".to_vec()]);
        assert!(!processed.is_external);
        assert_ne!(exported(&alice), before);
        assert_eq!(exported(&alice), exported(&bob));
        assert_eq!(exported(&alice), exported(&carol));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn rejected_commit_can_be_cleared_and_the_group_keeps_working() {
        let (alice, bob) = pair();
        let lost = alice.commit_changes(GROUP, &[], &[]).unwrap();
        assert!(alice.has_pending(GROUP).unwrap());
        let winner = bob.commit_changes(GROUP, &[], &[]).unwrap();
        bob.merge_pending(GROUP).unwrap();

        // The server accepted Bob's commit, so Alice drops hers and applies his.
        drop(lost);
        alice.clear_pending(GROUP).unwrap();
        alice.process_commit(GROUP, &winner.commit).unwrap();
        assert_eq!(exported(&alice), exported(&bob));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn pending_exporter_matches_the_epoch_after_merging() {
        let (alice, bob) = pair();
        let pending = alice.commit_changes(GROUP, &[], &[]).unwrap();
        let early = alice
            .export_pending_secret(GROUP, "zuna/test", b"", 32)
            .unwrap();
        alice.merge_pending(GROUP).unwrap();
        bob.process_commit(GROUP, &pending.commit).unwrap();
        assert_eq!(early, exported(&alice));
        assert_eq!(early, exported(&bob));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn removed_member_learns_it_and_loses_access() {
        let (alice, bob) = pair();
        let bob_leaf = alice
            .members(GROUP)
            .unwrap()
            .into_iter()
            .find(|m| m.credential == b"bob")
            .unwrap()
            .leaf_index;
        let pending = alice.commit_changes(GROUP, &[], &[bob_leaf]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        let processed = bob.process_commit(GROUP, &pending.commit).unwrap();
        assert!(processed.self_removed);
        assert_eq!(processed.removed_credentials, vec![b"bob".to_vec()]);
        assert!(!bob.has_group(GROUP).unwrap());
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn new_device_joins_with_an_external_commit() {
        let (alice, bob) = pair();
        let bob_laptop = client("bob-laptop");
        let info = alice.export_group_info(GROUP).unwrap();
        let (commit, epoch) = bob_laptop.join_external(GROUP, &info).unwrap();

        let processed = alice.process_commit(GROUP, &commit).unwrap();
        bob.process_commit(GROUP, &commit).unwrap();
        assert!(processed.is_external);
        assert_eq!(processed.sender_credential, b"bob-laptop");
        assert_eq!(processed.epoch, epoch);
        assert_eq!(exported(&alice), exported(&bob_laptop));
        assert_eq!(exported(&bob), exported(&bob_laptop));
        assert_eq!(alice.members(GROUP).unwrap().len(), 3);
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn group_info_from_a_commit_supports_external_joins() {
        let (alice, _bob) = pair();
        let pending = alice.commit_changes(GROUP, &[], &[]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        let info = pending.group_info.expect("ratchet tree extension is on");
        let late = client("late");
        late.join_external(GROUP, &info).unwrap();
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn device_that_lost_its_state_can_rejoin_replacing_its_old_leaf() {
        let (alice, bob) = pair();
        let info = alice.export_group_info(GROUP).unwrap();
        let (commit, _) = bob.join_external(GROUP, &info).unwrap();
        alice.process_commit(GROUP, &commit).unwrap();
        assert_eq!(alice.members(GROUP).unwrap().len(), 2, "old leaf replaced");
        assert_eq!(exported(&alice), exported(&bob));
    }

    #[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
    #[cfg_attr(not(target_arch = "wasm32"), test)]
    fn state_survives_a_restart_through_the_change_log() {
        let (public, secret) = signing_keygen().unwrap();
        let mut bob = MlsClient::new(public.clone(), secret.clone(), b"bob".to_vec(), vec![]);
        let alice = client("alice");
        alice.create_group(GROUP).unwrap();
        let kp = bob.generate_key_package(false).unwrap();

        let mut persisted: HashMap<Vec<u8>, Vec<u8>> = HashMap::new();
        let mut apply = |changes: StateChanges| {
            for (key, value) in changes.set {
                persisted.insert(key, value);
            }
            for key in changes.deleted {
                persisted.remove(&key);
            }
        };
        apply(bob.take_changes());

        let pending = alice.commit_changes(GROUP, &[kp], &[]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        bob.join_from_welcome(&pending.welcome.unwrap()).unwrap();
        apply(bob.take_changes());
        let next = alice.commit_changes(GROUP, &[], &[]).unwrap();
        alice.merge_pending(GROUP).unwrap();
        bob.process_commit(GROUP, &next.commit).unwrap();
        apply(bob.take_changes());
        assert!(bob.take_changes().set.is_empty(), "nothing left to persist");

        let restored = MlsClient::new(
            public,
            secret,
            b"bob".to_vec(),
            persisted.into_iter().collect(),
        );
        assert_eq!(exported(&restored), exported(&alice));
    }
}
