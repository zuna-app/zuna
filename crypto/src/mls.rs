//! MLS (RFC 9420) group state for one device, built on OpenMLS.
//!
//! The server only ever sees the opaque bytes this module produces. It orders
//! commits for each group, which is all MLS asks of a delivery service.

use std::cell::RefCell;
use std::collections::HashMap;

use openmls::prelude::*;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::signatures::{Signer, SignerError};
use openmls_traits::types::{CryptoError, ExporterSecret, HashType, HpkeCiphertext, HpkeConfig, HpkeKeyPair, KemOutput};
use openmls_traits::OpenMlsProvider;
use tls_codec::{Deserialize as _, Serialize as _, SecretVLBytes};

use crate::hybrid;
use crate::primitives::Result;

/// The one suite every group is made with, and the only one this takes, from
/// draft-ietf-mls-pq-ciphersuites: ML-KEM-768 and X25519 together (X-Wing) to agree
/// on keys, so that what a recorder keeps of welcomes and commits can't be opened by a
/// quantum computer later, ChaCha20-Poly1305 and SHA-384. Its signature scheme is
/// ML-DSA-44 by the draft's code point, and in Zuna it means Ed25519 and ML-DSA-44
/// together, a device's hybrid key (`hybrid.rs`), which [`Crypto`] signs and checks:
/// every leaf, key package, commit and group info takes forging both. Zuna only talks
/// to itself, so a code point is a label in its own data.
const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_MLKEM768X25519_CHACHA20POLY1305_SHA384_MLDSA44;

/// Epochs a member keeps past message secrets for. Commits are applied strictly
/// in order and content is encrypted under exported keys, so none are needed.
const MAX_PAST_EPOCHS: usize = 0;

/// A private-use group context extension (RFC 9420 section 17.3) holding a group's
/// roster: who its admins are and who has been let in. What it says, and who may
/// change it, is the core's to decide. MLS makes every member hold the same one,
/// epoch by epoch, and only a commit can change it, so the server can't.
const ROSTER_EXTENSION: u16 = 0xf5a0;

/// How many groups are kept as loaded at once. Most people are in fewer.
const MAX_LOADED: usize = 32;

/// How many leaves the groups kept as loaded have between them. With hybrid keys a leaf
/// is about 10 KB as it's sent and more in memory, so a group of a thousand takes tens of
/// megabytes: this keeps a few such at once, which a phone has room for, however many
/// small ones there are. One larger than this is still kept, alone.
const MAX_LOADED_LEAVES: usize = 4_000;

/// Groups as they were loaded, each with how many leaves it has.
type Loaded = RefCell<HashMap<Vec<u8>, (MlsGroup, usize)>>;

/// What every leaf says it supports. A group requires the roster's extension, so a
/// leaf that didn't list it couldn't be added.
fn capabilities(last_resort: bool) -> Capabilities {
    let mut extensions = vec![ExtensionType::Unknown(ROSTER_EXTENSION)];
    if last_resort {
        extensions.push(ExtensionType::LastResort);
    }
    Capabilities::builder().ciphersuites(vec![CIPHERSUITE]).extensions(extensions).build()
}

/// The crypto OpenMLS is given: RustCrypto's, but for [`CIPHERSUITE`] alone, and with
/// its ML-DSA-44 meaning a device's hybrid key. OpenMLS checks every signature through
/// `verify_signature`, so none it takes is Ed25519's or ML-DSA's alone.
#[derive(Default)]
pub(crate) struct Crypto(RustCrypto);

impl OpenMlsCrypto for Crypto {
    fn supports(&self, ciphersuite: Ciphersuite) -> std::result::Result<(), CryptoError> {
        if ciphersuite == CIPHERSUITE {
            Ok(())
        } else {
            Err(CryptoError::UnsupportedCiphersuite)
        }
    }

    fn supported_ciphersuites(&self) -> Vec<Ciphersuite> {
        vec![CIPHERSUITE]
    }

    fn hkdf_extract(&self, hash_type: HashType, salt: &[u8], ikm: &[u8]) -> std::result::Result<SecretVLBytes, CryptoError> {
        self.0.hkdf_extract(hash_type, salt, ikm)
    }

    fn hmac(&self, hash_type: HashType, key: &[u8], message: &[u8]) -> std::result::Result<SecretVLBytes, CryptoError> {
        self.0.hmac(hash_type, key, message)
    }

    fn hkdf_expand(&self, hash_type: HashType, prk: &[u8], info: &[u8], okm_len: usize) -> std::result::Result<SecretVLBytes, CryptoError> {
        self.0.hkdf_expand(hash_type, prk, info, okm_len)
    }

    fn hash(&self, hash_type: HashType, data: &[u8]) -> std::result::Result<Vec<u8>, CryptoError> {
        self.0.hash(hash_type, data)
    }

    fn aead_encrypt(&self, alg: AeadType, key: &[u8], data: &[u8], nonce: &[u8], aad: &[u8]) -> std::result::Result<Vec<u8>, CryptoError> {
        self.0.aead_encrypt(alg, key, data, nonce, aad)
    }

    fn aead_decrypt(&self, alg: AeadType, key: &[u8], ct_tag: &[u8], nonce: &[u8], aad: &[u8]) -> std::result::Result<Vec<u8>, CryptoError> {
        self.0.aead_decrypt(alg, key, ct_tag, nonce, aad)
    }

    /// A device's keys are the core's, made with its other keys, never OpenMLS's.
    fn signature_key_gen(&self, _alg: SignatureScheme) -> std::result::Result<(Vec<u8>, Vec<u8>), CryptoError> {
        Err(CryptoError::UnsupportedSignatureScheme)
    }

    fn verify_signature(&self, alg: SignatureScheme, data: &[u8], pk: &[u8], signature: &[u8]) -> std::result::Result<(), CryptoError> {
        if alg == SignatureScheme::MLDSA44 && pk.first() == Some(&hybrid::DEVICE) && hybrid::verify(pk, data, signature) {
            Ok(())
        } else {
            Err(CryptoError::InvalidSignature)
        }
    }

    fn sign(&self, alg: SignatureScheme, data: &[u8], key: &[u8]) -> std::result::Result<Vec<u8>, CryptoError> {
        if alg != SignatureScheme::MLDSA44 || key.first() != Some(&hybrid::DEVICE) {
            return Err(CryptoError::UnsupportedSignatureScheme);
        }
        hybrid::sign(key, data).map_err(|_| CryptoError::CryptoLibraryError)
    }

    fn hpke_seal(&self, config: HpkeConfig, pk_r: &[u8], info: &[u8], aad: &[u8], ptxt: &[u8]) -> std::result::Result<HpkeCiphertext, CryptoError> {
        self.0.hpke_seal(config, pk_r, info, aad, ptxt)
    }

    fn hpke_open(&self, config: HpkeConfig, input: &HpkeCiphertext, sk_r: &[u8], info: &[u8], aad: &[u8]) -> std::result::Result<Vec<u8>, CryptoError> {
        self.0.hpke_open(config, input, sk_r, info, aad)
    }

    fn hpke_setup_sender_and_export(
        &self,
        config: HpkeConfig,
        pk_r: &[u8],
        info: &[u8],
        exporter_context: &[u8],
        exporter_length: usize,
    ) -> std::result::Result<(KemOutput, ExporterSecret), CryptoError> {
        self.0.hpke_setup_sender_and_export(config, pk_r, info, exporter_context, exporter_length)
    }

    fn hpke_setup_receiver_and_export(
        &self,
        config: HpkeConfig,
        enc: &[u8],
        sk_r: &[u8],
        info: &[u8],
        exporter_context: &[u8],
        exporter_length: usize,
    ) -> std::result::Result<ExporterSecret, CryptoError> {
        self.0.hpke_setup_receiver_and_export(config, enc, sk_r, info, exporter_context, exporter_length)
    }

    fn derive_hpke_keypair(&self, config: HpkeConfig, ikm: &[u8]) -> std::result::Result<HpkeKeyPair, CryptoError> {
        self.0.derive_hpke_keypair(config, ikm)
    }
}

/// What OpenMLS works with: [`Crypto`], randomness, and the state in memory, which
/// [`MlsClient`] hands to its caller to keep.
#[derive(Default)]
pub(crate) struct Provider {
    crypto: Crypto,
    rand: RustCrypto,
    storage: MemoryStorage,
}

impl OpenMlsProvider for Provider {
    type CryptoProvider = Crypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &MemoryStorage {
        &self.storage
    }

    fn crypto(&self) -> &Crypto {
        &self.crypto
    }

    fn rand(&self) -> &RustCrypto {
        &self.rand
    }
}

/// Signs as this device, with its hybrid key.
struct DeviceSigner {
    secret: Vec<u8>,
}

impl Signer for DeviceSigner {
    fn sign(&self, payload: &[u8]) -> std::result::Result<Vec<u8>, SignerError> {
        if self.secret.first() != Some(&hybrid::DEVICE) {
            return Err(SignerError::SigningError);
        }
        hybrid::sign(&self.secret, payload).map_err(|_| SignerError::SigningError)
    }

    fn signature_scheme(&self) -> SignatureScheme {
        SignatureScheme::MLDSA44
    }
}

/// A group's context extensions, with its roster if it has one.
fn context_extensions(roster: Option<&[u8]>) -> Result<Extensions<GroupContext>> {
    let mut extensions = vec![Extension::RequiredCapabilities(
        RequiredCapabilitiesExtension::new(&[ExtensionType::Unknown(ROSTER_EXTENSION)], &[], &[]),
    )];
    if let Some(roster) = roster {
        extensions.push(Extension::Unknown(ROSTER_EXTENSION, UnknownExtension(roster.to_vec())));
    }
    Extensions::from_vec(extensions).map_err(err("roster extension"))
}

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
    provider: Provider,
    signer: DeviceSigner,
    credential: CredentialWithKey,
    /// Last persisted copy of the storage, used to work out what changed.
    checkpoint: HashMap<Vec<u8>, Vec<u8>>,
    /// Groups as last loaded from storage, for reading. Loading one parses all of
    /// its state, tree and all, and the core reads a group's epoch, members and
    /// keys around ten times for each message it sends: in a group of 100 that
    /// came to 4 ms a message, and of 1,000 to 40 ms. Whatever changes a group's
    /// state forgets it here once it's done, through [`Changing`].
    loaded: Loaded,
}

/// Forgets what's loaded of one group, or of all of them, as it goes, so that
/// whatever changed storage meanwhile, and however it ended, is read afresh.
struct Changing<'a> {
    loaded: &'a Loaded,
    group: Option<Vec<u8>>,
}

impl Drop for Changing<'_> {
    fn drop(&mut self) {
        let mut loaded = self.loaded.borrow_mut();
        match &self.group {
            Some(group) => {
                loaded.remove(group);
            }
            None => loaded.clear(),
        }
    }
}

impl MlsClient {
    /// Creates a client for a device. `device_secret` and `device_public` are
    /// the device's hybrid keys (`hybrid.rs`), a device's kind; `credential` is the
    /// opaque credential the core makes for the device, placed in the MLS `BasicCredential`.
    pub fn new(
        device_public: Vec<u8>,
        device_secret: Vec<u8>,
        credential: Vec<u8>,
        state: Vec<(Vec<u8>, Vec<u8>)>,
    ) -> Self {
        let provider = Provider::default();
        let checkpoint: HashMap<_, _> = state.into_iter().collect();
        *provider.storage().values.write().unwrap() = checkpoint.clone();
        let signer = DeviceSigner { secret: device_secret };
        let credential = CredentialWithKey {
            credential: BasicCredential::new(credential).into(),
            signature_key: device_public.into(),
        };
        Self {
            provider,
            signer,
            credential,
            checkpoint,
            loaded: RefCell::default(),
        }
    }

    /// Marks a group's state as about to change, until what this returns goes.
    fn changing(&self, group_id: &[u8]) -> Changing<'_> {
        Changing { loaded: &self.loaded, group: Some(group_id.to_vec()) }
    }

    /// Marks every group's state as about to change, as a join may replace any.
    fn changing_all(&self) -> Changing<'_> {
        Changing { loaded: &self.loaded, group: None }
    }

    /// Reads a group as it's stored, or None if there isn't one, loading it only
    /// the first time until something changes it.
    fn read<T>(&self, group_id: &[u8], read: impl FnOnce(&MlsGroup) -> T) -> Result<Option<T>> {
        if let Some((group, _)) = self.loaded.borrow().get(group_id) {
            return Ok(Some(read(group)));
        }
        let Some(group) = MlsGroup::load(self.provider.storage(), &GroupId::from_slice(group_id))
            .map_err(err("load group"))?
        else {
            return Ok(None);
        };
        let value = read(&group);
        let leaves = group.members().count();
        let mut loaded = self.loaded.borrow_mut();
        while !loaded.is_empty() && (loaded.len() >= MAX_LOADED || loaded.values().map(|(_, held)| held).sum::<usize>() + leaves > MAX_LOADED_LEAVES) {
            let Some(other) = loaded.keys().next().cloned() else { break };
            loaded.remove(&other);
        }
        loaded.insert(group_id.to_vec(), (group, leaves));
        Ok(Some(value))
    }

    /// Reads a group that has to be there.
    fn read_held<T>(&self, group_id: &[u8], read: impl FnOnce(&MlsGroup) -> T) -> Result<T> {
        self.read(group_id, read)?.ok_or_else(|| "unknown group".to_string())
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

    /// Replaces the device certificate this client uses from now on: in new key
    /// packages, in joining, and in this device's leaf at its next commit in each group.
    pub fn set_credential(&mut self, credential: Vec<u8>) {
        self.credential.credential = BasicCredential::new(credential).into();
    }

    /// Goes back to the state of the last `take_changes`, undoing whatever
    /// happened since, such as a join the server then refused.
    pub fn rollback(&self) {
        let _changing = self.changing_all();
        *self.provider.storage().values.write().unwrap() = self.checkpoint.clone();
    }

    fn create_config(roster: Option<&[u8]>) -> Result<MlsGroupCreateConfig> {
        Ok(MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            // Member commits are encrypted; external commits are always public.
            .wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .max_past_epochs(MAX_PAST_EPOCHS)
            .capabilities(capabilities(false))
            .with_group_context_extensions(context_extensions(roster)?)
            .build())
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
        Ok(self.read(group_id, |group| group.is_active())?.unwrap_or(false))
    }

    pub fn generate_key_package(&self, last_resort: bool) -> Result<Vec<u8>> {
        // A leaf has to say it supports what its package carries, and what groups require, or nobody can add it.
        let mut builder = KeyPackage::builder().leaf_node_capabilities(capabilities(last_resort));
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

    /// Starts a group, with a roster if it's to have one.
    pub fn create_group(&self, group_id: &[u8], roster: Option<&[u8]>) -> Result<u64> {
        let _changing = self.changing(group_id);
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &Self::create_config(roster)?,
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
                // A key package starts with its version and its suite (RFC 9420, section 10):
                // one of another suite is refused before any of it is read, or checked under
                // that suite's scheme.
                if bytes.get(2..4).is_some_and(|suite| suite != u16::from(CIPHERSUITE).to_be_bytes()) {
                    return Err("key package of another suite".to_string());
                }
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

    /// The signing key a key package's leaf really uses. The credential only
    /// claims one, so the two have to be compared before trusting the device.
    pub fn key_package_signature_key(&self, key_package: &[u8]) -> Result<Vec<u8>> {
        let parsed = self.parse_key_packages(&[key_package.to_vec()])?;
        Ok(parsed[0].leaf_node().signature_key().as_slice().to_vec())
    }

    /// Builds one commit that adds and removes members, and replaces the roster if
    /// one is given, then keeps it pending.
    pub fn commit_changes(
        &self,
        group_id: &[u8],
        key_packages: &[Vec<u8>],
        remove_leaves: &[u32],
        roster: Option<&[u8]>,
    ) -> Result<PendingCommit> {
        let _changing = self.changing(group_id);
        let mut group = self.load(group_id)?;
        let adds = self.parse_key_packages(key_packages)?;
        let removes = remove_leaves.iter().map(|i| LeafNodeIndex::new(*i));
        let leaf_is_behind = group
            .own_leaf_node()
            .is_some_and(|leaf| leaf.credential() != &self.credential.credential);
        let leaf_parameters = if leaf_is_behind {
            LeafNodeParameters::builder()
                .with_credential_with_key(self.credential.clone())
                .build()
        } else {
            LeafNodeParameters::default()
        };
        let mut builder = group.commit_builder().propose_adds(adds).propose_removals(removes);
        if roster.is_some() {
            builder = builder
                .propose_group_context_extensions(context_extensions(roster)?)
                .map_err(err("commit roster"))?;
        }
        let bundle = builder
            .force_self_update(true)
            .leaf_node_parameters(leaf_parameters)
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
        let _changing = self.changing(group_id);
        let mut group = self.load(group_id)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(err("merge commit"))?;
        Ok(group.epoch().as_u64())
    }

    pub fn clear_pending(&self, group_id: &[u8]) -> Result<()> {
        let _changing = self.changing(group_id);
        let mut group = self.load(group_id)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(err("clear commit"))
    }

    pub fn has_pending(&self, group_id: &[u8]) -> Result<bool> {
        self.read_held(group_id, |group| group.pending_commit().is_some())
    }

    /// Applies a commit from another device.
    pub fn process_commit(&self, group_id: &[u8], bytes: &[u8]) -> Result<ProcessedCommit> {
        let _changing = self.changing(group_id);
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
        // OpenMLS takes no removal of a leaf that isn't a member's, so each names one.
        let removed_credentials = staged
            .remove_proposals()
            .filter_map(|remove| group.member(remove.remove_proposal().removed()))
            .map(credential_or_empty)
            .collect::<Vec<_>>();
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
    pub fn join_from_welcome(&self, bytes: &[u8], group_id: &[u8]) -> Result<(Vec<u8>, u64)> {
        let _changing = self.changing_all();
        let message = MlsMessageIn::tls_deserialize_exact(bytes).map_err(err("welcome decode"))?;
        let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
            return Err("expected a welcome".into());
        };
        let builder = StagedWelcome::build_from_welcome(&self.provider, &Self::join_config(), welcome)
            .map_err(err("welcome process"))?;
        // Joining replaces what's held for the group a Welcome names, so one
        // delivered as being for some other group mustn't get as far as that.
        let names = builder.processed_welcome().unverified_group_info().group_id();
        if names.as_slice() != group_id {
            return Err("the welcome is for a different group".into());
        }
        let group = builder
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
    /// device whose group state was lost. The old state is replaced if present,
    /// and kept if the group info turns out to be unusable.
    pub fn join_external(&self, group_id: &[u8], group_info: &[u8]) -> Result<(Vec<u8>, u64)> {
        let _changing = self.changing_all();
        let before = self.provider.storage().values.read().unwrap().clone();
        let joined = self.replace_by_external_join(group_id, group_info);
        if joined.is_err() {
            *self.provider.storage().values.write().unwrap() = before;
        }
        joined
    }

    fn replace_by_external_join(&self, group_id: &[u8], group_info: &[u8]) -> Result<(Vec<u8>, u64)> {
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
        // The leaf an external commit makes only has the capabilities it's given.
        let leaf = LeafNodeParameters::builder()
            .with_credential_with_key(self.credential.clone())
            .with_capabilities(capabilities(false))
            .build();
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(Self::join_config())
            .skip_lifetime_validation()
            .build_group(&self.provider, info, self.credential.clone())
            .map_err(err("external build"))?
            .leaf_node_parameters(leaf)
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
        let info = self
            .read_held(group_id, |group| group.export_group_info(self.provider.crypto(), &self.signer, true))?
            .map_err(err("export group info"))?;
        encode(&info)
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64> {
        self.read_held(group_id, |group| group.epoch().as_u64())
    }

    /// The roster in a group's context now, if it has one.
    pub fn roster(&self, group_id: &[u8]) -> Result<Option<Vec<u8>>> {
        self.read_held(group_id, |group| group.extensions().unknown(ROSTER_EXTENSION).map(|roster| roster.0.clone()))
    }

    pub fn own_leaf_index(&self, group_id: &[u8]) -> Result<u32> {
        self.read_held(group_id, |group| group.own_leaf_index().u32())
    }

    pub fn members(&self, group_id: &[u8]) -> Result<Vec<MemberInfo>> {
        self.read_held(group_id, |group| {
            group
                .members()
                .map(|m| MemberInfo {
                    leaf_index: m.index.u32(),
                    credential: credential_or_empty(&m.credential),
                    signature_key: m.signature_key,
                })
                .collect()
        })
    }

    /// RFC 9420 section 8.5 exporter: the source of each epoch's content key.
    pub fn export_secret(
        &self,
        group_id: &[u8],
        label: &str,
        context: &[u8],
        len: usize,
    ) -> Result<Vec<u8>> {
        self.read_held(group_id, |group| group.export_secret(self.provider.crypto(), label, context, len))?
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
        self.read_held(group_id, |group| {
            group
                .pending_commit()
                .ok_or_else(|| "no pending commit".to_string())?
                .export_secret(self.provider.crypto(), label, context, len)
                .map_err(err("export pending secret"))
        })?
    }

    /// Forgets a group completely, for example after being removed from it.
    pub fn delete_group(&self, group_id: &[u8]) -> Result<()> {
        let _changing = self.changing(group_id);
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
mod tests;
