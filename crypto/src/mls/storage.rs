//! Journaling in-memory OpenMLS storage with the exact key/value layout of
//! `openmls_memory_storage::MemoryStorage`, tracking only modified keys since
//! the last checkpoint so `take_changes()`, `rollback()`, and failed joins
//! run in O(modified keys) instead of cloning and diffing the entire store.

use std::collections::HashMap;
use std::sync::RwLock;

use openmls_traits::storage::{traits, Entity, StorageProvider, CURRENT_VERSION};
use serde::Serialize;

use super::StateChanges;

const KEY_PACKAGE_LABEL: &[u8] = b"KeyPackage";
const PSK_LABEL: &[u8] = b"Psk";
const ENCRYPTION_KEY_PAIR_LABEL: &[u8] = b"EncryptionKeyPair";
const SIGNATURE_KEY_PAIR_LABEL: &[u8] = b"SignatureKeyPair";
const EPOCH_KEY_PAIRS_LABEL: &[u8] = b"EpochKeyPairs";

const TREE_LABEL: &[u8] = b"Tree";
const GROUP_CONTEXT_LABEL: &[u8] = b"GroupContext";
const INTERIM_TRANSCRIPT_HASH_LABEL: &[u8] = b"InterimTranscriptHash";
const CONFIRMATION_TAG_LABEL: &[u8] = b"ConfirmationTag";

const JOIN_CONFIG_LABEL: &[u8] = b"MlsGroupJoinConfig";
const OWN_LEAF_NODES_LABEL: &[u8] = b"OwnLeafNodes";
const GROUP_STATE_LABEL: &[u8] = b"GroupState";
const QUEUED_PROPOSAL_LABEL: &[u8] = b"QueuedProposal";
const PROPOSAL_QUEUE_REFS_LABEL: &[u8] = b"ProposalQueueRefs";
const OWN_LEAF_NODE_INDEX_LABEL: &[u8] = b"OwnLeafNodeIndex";
const EPOCH_SECRETS_LABEL: &[u8] = b"EpochSecrets";
const RESUMPTION_PSK_STORE_LABEL: &[u8] = b"ResumptionPsk";
const MESSAGE_SECRETS_LABEL: &[u8] = b"MessageSecrets";

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub(crate) enum StorageError {
    SerializationError,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("storage serialization error")
    }
}

impl std::error::Error for StorageError {}

impl From<serde_json::Error> for StorageError {
    fn from(_: serde_json::Error) -> Self {
        Self::SerializationError
    }
}

struct Inner {
    values: HashMap<Vec<u8>, Vec<u8>>,
    /// First pre-mutation value of each key touched since the last `take_changes`.
    undo: HashMap<Vec<u8>, Option<Vec<u8>>>,
    /// Optional nested savepoint for scoped rollback (e.g. `join_external`).
    savepoint: Option<HashMap<Vec<u8>, Option<Vec<u8>>>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            values: HashMap::new(),
            undo: HashMap::new(),
            savepoint: None,
        }
    }
}

impl Inner {
    fn record_before(&mut self, key: &Vec<u8>) {
        if !self.undo.contains_key(key) {
            self.undo.insert(key.clone(), self.values.get(key).cloned());
        }
        if let Some(sp) = &mut self.savepoint {
            if !sp.contains_key(key) {
                sp.insert(key.clone(), self.values.get(key).cloned());
            }
        }
    }

    fn set(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.record_before(&key);
        self.values.insert(key, value);
    }

    fn remove(&mut self, key: &Vec<u8>) {
        if self.values.contains_key(key) {
            self.record_before(key);
            self.values.remove(key);
        }
    }
}

#[derive(Default)]
pub(crate) struct JournalingStorage {
    inner: RwLock<Inner>,
}

impl JournalingStorage {
    pub(crate) fn from_entries(entries: Vec<(Vec<u8>, Vec<u8>)>) -> Self {
        Self {
            inner: RwLock::new(Inner {
                values: entries.into_iter().collect(),
                undo: HashMap::new(),
                savepoint: None,
            }),
        }
    }

    /// Returns only the keys whose values changed since the last `take_changes`, in O(modified keys).
    pub(crate) fn take_changes(&self) -> StateChanges {
        let mut inner = self.inner.write().unwrap();
        let undo = std::mem::take(&mut inner.undo);
        let mut changes = StateChanges::default();
        for (key, original) in undo {
            match (inner.values.get(&key), original) {
                (Some(current), Some(ref prev)) if current == prev => {}
                (None, None) => {}
                (Some(current), _) => changes.set.push((key, current.clone())),
                (None, Some(_)) => changes.deleted.push(key),
            }
        }
        changes
    }

    /// Reverts all mutations since the last `take_changes`, in O(modified keys).
    pub(crate) fn rollback(&self) {
        let mut inner = self.inner.write().unwrap();
        let undo = std::mem::take(&mut inner.undo);
        inner.savepoint = None;
        for (key, original) in undo {
            match original {
                Some(value) => {
                    inner.values.insert(key, value);
                }
                None => {
                    inner.values.remove(&key);
                }
            }
        }
    }

    /// Starts a scoped savepoint so a failed operation can undo only its own writes
    /// without disturbing prior uncommitted mutations in `undo`.
    pub(crate) fn begin_savepoint(&self) {
        let mut inner = self.inner.write().unwrap();
        inner.savepoint = Some(HashMap::new());
    }

    /// Discards the scoped savepoint, keeping its writes (still tracked in `undo`).
    pub(crate) fn commit_savepoint(&self) {
        let mut inner = self.inner.write().unwrap();
        inner.savepoint = None;
    }

    /// Restores only the keys touched since `begin_savepoint`, leaving prior writes intact.
    pub(crate) fn rollback_savepoint(&self) {
        let mut inner = self.inner.write().unwrap();
        if let Some(sp) = inner.savepoint.take() {
            for (key, original) in sp {
                match original {
                    Some(value) => {
                        inner.values.insert(key, value);
                    }
                    None => {
                        inner.values.remove(&key);
                    }
                }
            }
        }
    }

    #[inline(always)]
    fn write<const VERSION: u16>(&self, label: &[u8], key: &[u8], value: Vec<u8>) -> Result<(), StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        self.inner.write().unwrap().set(storage_key, value);
        Ok(())
    }

    fn append<const VERSION: u16>(&self, label: &[u8], key: &[u8], value: Vec<u8>) -> Result<(), StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        let mut inner = self.inner.write().unwrap();
        inner.record_before(&storage_key);
        let list_bytes = inner.values.entry(storage_key).or_insert_with(|| b"[]".to_vec());
        let mut list: Vec<Vec<u8>> = serde_json::from_slice(list_bytes)?;
        list.push(value);
        list_bytes.clear();
        serde_json::to_writer(list_bytes, &list)?;
        Ok(())
    }

    fn remove_item<const VERSION: u16>(&self, label: &[u8], key: &[u8], value: Vec<u8>) -> Result<(), StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        let mut inner = self.inner.write().unwrap();
        inner.record_before(&storage_key);
        let list_bytes = inner.values.entry(storage_key).or_insert_with(|| b"[]".to_vec());
        let mut list: Vec<Vec<u8>> = serde_json::from_slice(list_bytes)?;
        if let Some(pos) = list.iter().position(|stored_item| stored_item == &value) {
            list.remove(pos);
        }
        list_bytes.clear();
        serde_json::to_writer(list_bytes, &list)?;
        Ok(())
    }

    #[inline(always)]
    fn read<const VERSION: u16, V: Entity<VERSION>>(&self, label: &[u8], key: &[u8]) -> Result<Option<V>, StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        let inner = self.inner.read().unwrap();
        if let Some(value) = inner.values.get(&storage_key) {
            serde_json::from_slice(value).map_err(|_| StorageError::SerializationError).map(Some)
        } else {
            Ok(None)
        }
    }

    #[inline(always)]
    fn read_list<const VERSION: u16, V: Entity<VERSION>>(&self, label: &[u8], key: &[u8]) -> Result<Vec<V>, StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        let inner = self.inner.read().unwrap();
        let value: Vec<Vec<u8>> = match inner.values.get(&storage_key) {
            Some(list_bytes) => serde_json::from_slice(list_bytes)?,
            None => return Ok(Vec::new()),
        };
        value
            .iter()
            .map(|value_bytes| serde_json::from_slice(value_bytes))
            .collect::<Result<Vec<V>, _>>()
            .map_err(|_| StorageError::SerializationError)
    }

    #[inline(always)]
    fn delete<const VERSION: u16>(&self, label: &[u8], key: &[u8]) -> Result<(), StorageError> {
        let storage_key = build_key_from_slice::<VERSION>(label, key);
        self.inner.write().unwrap().remove(&storage_key);
        Ok(())
    }
}

#[inline]
fn build_key_from_slice<const V: u16>(label: &[u8], key: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(label.len() + key.len() + 2);
    out.extend_from_slice(label);
    out.extend_from_slice(key);
    out.extend_from_slice(&V.to_be_bytes());
    out
}

#[inline]
fn build_key<const V: u16, K: Serialize>(label: &[u8], key: &K) -> Result<Vec<u8>, StorageError> {
    let serialized = serde_json::to_vec(key)?;
    Ok(build_key_from_slice::<V>(label, &serialized))
}

fn epoch_key_pairs_id(
    group_id: &impl traits::GroupId<CURRENT_VERSION>,
    epoch: &impl traits::EpochKey<CURRENT_VERSION>,
    leaf_index: u32,
) -> Result<Vec<u8>, StorageError> {
    let mut key = serde_json::to_vec(group_id)?;
    key.extend_from_slice(&serde_json::to_vec(epoch)?);
    key.extend_from_slice(&serde_json::to_vec(&leaf_index)?);
    Ok(key)
}

impl StorageProvider<CURRENT_VERSION> for JournalingStorage {
    type Error = StorageError;

    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<(), Self::Error> {
        let key = serde_json::to_vec(&(group_id, proposal_ref))?;
        let value = serde_json::to_vec(proposal)?;
        self.write::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &key, value)?;

        let key = serde_json::to_vec(group_id)?;
        let value = serde_json::to_vec(proposal_ref)?;
        self.append::<CURRENT_VERSION>(PROPOSAL_QUEUE_REFS_LABEL, &key, value)?;
        Ok(())
    }

    fn write_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        tree: &TreeSync,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(TREE_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(tree)?)
    }

    fn write_interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        interim_transcript_hash: &InterimTranscriptHash,
    ) -> Result<(), Self::Error> {
        let key = build_key::<CURRENT_VERSION, _>(INTERIM_TRANSCRIPT_HASH_LABEL, &group_id)?;
        let value = serde_json::to_vec(interim_transcript_hash)?;
        self.inner.write().unwrap().set(key, value);
        Ok(())
    }

    fn write_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_context: &GroupContext,
    ) -> Result<(), Self::Error> {
        let key = build_key::<CURRENT_VERSION, _>(GROUP_CONTEXT_LABEL, &group_id)?;
        let value = serde_json::to_vec(group_context)?;
        self.inner.write().unwrap().set(key, value);
        Ok(())
    }

    fn write_confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        confirmation_tag: &ConfirmationTag,
    ) -> Result<(), Self::Error> {
        let key = build_key::<CURRENT_VERSION, _>(CONFIRMATION_TAG_LABEL, &group_id)?;
        let value = serde_json::to_vec(confirmation_tag)?;
        self.inner.write().unwrap().set(key, value);
        Ok(())
    }

    fn write_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
        signature_key_pair: &SignatureKeyPair,
    ) -> Result<(), Self::Error> {
        let key = build_key::<CURRENT_VERSION, _>(SIGNATURE_KEY_PAIR_LABEL, &public_key)?;
        let value = serde_json::to_vec(signature_key_pair)?;
        self.inner.write().unwrap().set(key, value);
        Ok(())
    }

    fn queued_proposal_refs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProposalRef>, Self::Error> {
        self.read_list(PROPOSAL_QUEUE_REFS_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>, Self::Error> {
        let refs: Vec<ProposalRef> = self.read_list(PROPOSAL_QUEUE_REFS_LABEL, &serde_json::to_vec(group_id)?)?;
        refs.into_iter()
            .map(|proposal_ref| -> Result<_, Self::Error> {
                let key = serde_json::to_vec(&(group_id, &proposal_ref))?;
                let proposal = self.read(QUEUED_PROPOSAL_LABEL, &key)?.ok_or(StorageError::SerializationError)?;
                Ok((proposal_ref, proposal))
            })
            .collect()
    }

    fn tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<TreeSync>, Self::Error> {
        self.read(TREE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn group_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupContext>, Self::Error> {
        self.read(GROUP_CONTEXT_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<InterimTranscriptHash>, Self::Error> {
        self.read(INTERIM_TRANSCRIPT_HASH_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ConfirmationTag>, Self::Error> {
        self.read(CONFIRMATION_TAG_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<Option<SignatureKeyPair>, Self::Error> {
        self.read(SIGNATURE_KEY_PAIR_LABEL, &serde_json::to_vec(public_key)?)
    }

    fn write_key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
        key_package: &KeyPackage,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(KEY_PACKAGE_LABEL, &serde_json::to_vec(hash_ref)?, serde_json::to_vec(key_package)?)
    }

    fn write_psk<
        PskId: traits::PskId<CURRENT_VERSION>,
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
        psk: &PskBundle,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(PSK_LABEL, &serde_json::to_vec(psk_id)?, serde_json::to_vec(psk)?)
    }

    fn write_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
        key_pair: &HpkeKeyPair,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(ENCRYPTION_KEY_PAIR_LABEL, &serde_json::to_vec(public_key)?, serde_json::to_vec(key_pair)?)
    }

    fn key_package<
        KeyPackageRef: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<Option<KeyPackage>, Self::Error> {
        self.read(KEY_PACKAGE_LABEL, &serde_json::to_vec(hash_ref)?)
    }

    fn psk<
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
        PskId: traits::PskId<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
    ) -> Result<Option<PskBundle>, Self::Error> {
        self.read(PSK_LABEL, &serde_json::to_vec(psk_id)?)
    }

    fn encryption_key_pair<
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<Option<HpkeKeyPair>, Self::Error> {
        self.read(ENCRYPTION_KEY_PAIR_LABEL, &serde_json::to_vec(public_key)?)
    }

    fn delete_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(SIGNATURE_KEY_PAIR_LABEL, &serde_json::to_vec(public_key)?)
    }

    fn delete_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>>(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(ENCRYPTION_KEY_PAIR_LABEL, &serde_json::to_vec(public_key)?)
    }

    fn delete_key_package<KeyPackageRef: traits::HashReference<CURRENT_VERSION>>(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(KEY_PACKAGE_LABEL, &serde_json::to_vec(hash_ref)?)
    }

    fn delete_psk<PskKey: traits::PskId<CURRENT_VERSION>>(
        &self,
        psk_id: &PskKey,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(PSK_LABEL, &serde_json::to_vec(psk_id)?)
    }

    fn group_state<
        GroupState: traits::GroupState<CURRENT_VERSION>,
        GroupId: traits::GroupId<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupState>, Self::Error> {
        self.read(GROUP_STATE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_group_state<
        GroupState: traits::GroupState<CURRENT_VERSION>,
        GroupId: traits::GroupId<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_state: &GroupState,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(GROUP_STATE_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(group_state)?)
    }

    fn delete_group_state<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(GROUP_STATE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn message_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<MessageSecrets>, Self::Error> {
        self.read(MESSAGE_SECRETS_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_message_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        message_secrets: &MessageSecrets,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(MESSAGE_SECRETS_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(message_secrets)?)
    }

    fn delete_message_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(MESSAGE_SECRETS_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn resumption_psk_store<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ResumptionPskStore>, Self::Error> {
        self.read(RESUMPTION_PSK_STORE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_resumption_psk_store<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        resumption_psk_store: &ResumptionPskStore,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(RESUMPTION_PSK_STORE_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(resumption_psk_store)?)
    }

    fn delete_all_resumption_psk_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(RESUMPTION_PSK_STORE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn own_leaf_index<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<LeafNodeIndex>, Self::Error> {
        self.read(OWN_LEAF_NODE_INDEX_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_own_leaf_index<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        own_leaf_index: &LeafNodeIndex,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(OWN_LEAF_NODE_INDEX_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(own_leaf_index)?)
    }

    fn delete_own_leaf_index<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(OWN_LEAF_NODE_INDEX_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn group_epoch_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupEpochSecrets>, Self::Error> {
        self.read(EPOCH_SECRETS_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_group_epoch_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_epoch_secrets: &GroupEpochSecrets,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(EPOCH_SECRETS_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(group_epoch_secrets)?)
    }

    fn delete_group_epoch_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(EPOCH_SECRETS_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
        key_pairs: &[HpkeKeyPair],
    ) -> Result<(), Self::Error> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        let value = serde_json::to_vec(key_pairs)?;
        self.write::<CURRENT_VERSION>(EPOCH_KEY_PAIRS_LABEL, &key, value)
    }

    fn encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<Vec<HpkeKeyPair>, Self::Error> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        let storage_key = build_key_from_slice::<CURRENT_VERSION>(EPOCH_KEY_PAIRS_LABEL, &key);
        let inner = self.inner.read().unwrap();
        if let Some(value) = inner.values.get(&storage_key) {
            return serde_json::from_slice(value).map_err(|_| StorageError::SerializationError);
        }
        Ok(Vec::new())
    }

    fn delete_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<(), Self::Error> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        self.delete::<CURRENT_VERSION>(EPOCH_KEY_PAIRS_LABEL, &key)
    }

    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        let proposal_refs: Vec<ProposalRef> = self.read_list(PROPOSAL_QUEUE_REFS_LABEL, &serde_json::to_vec(group_id)?)?;
        let mut inner = self.inner.write().unwrap();
        for proposal_ref in proposal_refs {
            let raw = serde_json::to_vec(&(group_id, proposal_ref))?;
            let key = build_key_from_slice::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &raw);
            inner.remove(&key);
        }
        let refs_key = build_key::<CURRENT_VERSION, _>(PROPOSAL_QUEUE_REFS_LABEL, &group_id)?;
        inner.remove(&refs_key);
        Ok(())
    }

    fn mls_group_join_config<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<MlsGroupJoinConfig>, Self::Error> {
        self.read(JOIN_CONFIG_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn write_mls_join_config<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        config: &MlsGroupJoinConfig,
    ) -> Result<(), Self::Error> {
        self.write::<CURRENT_VERSION>(JOIN_CONFIG_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(config)?)
    }

    fn own_leaf_nodes<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<LeafNode>, Self::Error> {
        self.read_list(OWN_LEAF_NODES_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn append_own_leaf_node<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        leaf_node: &LeafNode,
    ) -> Result<(), Self::Error> {
        self.append::<CURRENT_VERSION>(OWN_LEAF_NODES_LABEL, &serde_json::to_vec(group_id)?, serde_json::to_vec(leaf_node)?)
    }

    fn delete_own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(OWN_LEAF_NODES_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn delete_group_config<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(JOIN_CONFIG_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn delete_tree<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(TREE_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn delete_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(CONFIRMATION_TAG_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn delete_context<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(GROUP_CONTEXT_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn delete_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<(), Self::Error> {
        self.delete::<CURRENT_VERSION>(INTERIM_TRANSCRIPT_HASH_LABEL, &serde_json::to_vec(group_id)?)
    }

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<(), Self::Error> {
        let key = serde_json::to_vec(group_id)?;
        let value = serde_json::to_vec(proposal_ref)?;
        self.remove_item::<CURRENT_VERSION>(PROPOSAL_QUEUE_REFS_LABEL, &key, value)?;

        let key = serde_json::to_vec(&(group_id, proposal_ref))?;
        self.delete::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &key)
    }
}
