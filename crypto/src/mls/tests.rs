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
    alice.create_group(GROUP, None).unwrap();
    let kp = bob.generate_key_package(false).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    let (id, _) = bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
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
fn a_welcome_delivered_as_another_groups_leaves_whats_held_alone() {
    let alice = client("alice");
    let bob = client("bob");
    alice.create_group(GROUP, None).unwrap();
    // A last-resort key package outlives the join, so the Welcome could be used again.
    let kp = bob.generate_key_package(true).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    let welcome = pending.welcome.unwrap();
    bob.join_from_welcome(&welcome, GROUP).unwrap();

    let next = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.process_commit(GROUP, &next.commit).unwrap();
    let epoch = bob.epoch(GROUP).unwrap();

    assert!(bob.join_from_welcome(&welcome, b"another group").is_err());
    assert_eq!(bob.epoch(GROUP).unwrap(), epoch);
    assert_eq!(exported(&alice), exported(&bob));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn commits_rotate_the_key_and_describe_the_change() {
    let (alice, bob) = pair();
    let before = exported(&alice);
    let carol = client("carol");
    let kp = carol.generate_key_package(false).unwrap();

    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    let processed = bob.process_commit(GROUP, &pending.commit).unwrap();
    carol.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();

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
    let lost = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    assert!(alice.has_pending(GROUP).unwrap());
    let winner = bob.commit_changes(GROUP, &[], &[], None).unwrap();
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
    let pending = alice.commit_changes(GROUP, &[], &[], None).unwrap();
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
    let pending = alice.commit_changes(GROUP, &[], &[bob_leaf], None).unwrap();
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
    let pending = alice.commit_changes(GROUP, &[], &[], None).unwrap();
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
fn a_key_package_reveals_the_signing_key_its_leaf_really_uses() {
    let (public, secret) = signing_keygen().unwrap();
    let device = MlsClient::new(public.clone(), secret, b"device".to_vec(), vec![]);
    let package = device.generate_key_package(false).unwrap();
    assert_eq!(device.key_package_signature_key(&package).unwrap(), public);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_commit_gives_a_leaf_its_new_certificate() {
    let (public, secret) = signing_keygen().unwrap();
    let mut alice = MlsClient::new(public, secret, b"alice-old".to_vec(), vec![]);
    let bob = client("bob");
    alice.create_group(GROUP, None).unwrap();
    let kp = bob.generate_key_package(false).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
    let leaf = |client: &MlsClient, name: &[u8]| {
        client
            .members(GROUP)
            .unwrap()
            .into_iter()
            .any(|member| member.credential == name)
    };
    assert!(leaf(&bob, b"alice-old"));

    alice.set_credential(b"alice-new".to_vec());
    // A new package has it right away.
    let package = alice.generate_key_package(false).unwrap();
    assert_eq!(alice.key_package_credential(&package).unwrap(), b"alice-new");
    // The leaf has it after the next commit, for everyone including someone
    // who joins afterwards, and the group's keys stay in step.
    let update = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.process_commit(GROUP, &update.commit).unwrap();
    assert!(leaf(&alice, b"alice-new"));
    assert!(leaf(&bob, b"alice-new"));
    assert!(!leaf(&bob, b"alice-old"));
    assert_eq!(exported(&alice), exported(&bob));

    let carol = client("carol");
    let kp = carol.generate_key_package(false).unwrap();
    let added = bob.commit_changes(GROUP, &[kp], &[], None).unwrap();
    bob.merge_pending(GROUP).unwrap();
    alice.process_commit(GROUP, &added.commit).unwrap();
    carol.join_from_welcome(&added.welcome.unwrap(), GROUP).unwrap();
    assert!(leaf(&carol, b"alice-new"));
    assert_eq!(exported(&alice), exported(&carol));

    let dave = client("dave");
    let info = alice.export_group_info(GROUP).unwrap();
    let (commit, _) = dave.join_external(GROUP, &info).unwrap();
    alice.process_commit(GROUP, &commit).unwrap();
    assert!(leaf(&dave, b"alice-new"));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn group_info_that_cant_be_used_leaves_the_old_state_alone() {
    let (alice, bob) = pair();
    let before = exported(&bob);
    assert!(bob.join_external(GROUP, b"garbage").is_err());

    // Well-formed, but its signature no longer matches what it says.
    let mut forged = alice.export_group_info(GROUP).unwrap();
    let last = forged.len() - 1;
    forged[last] ^= 0xff;
    assert!(bob.join_external(GROUP, &forged).is_err());

    assert!(bob.has_group(GROUP).unwrap());
    assert_eq!(exported(&bob), before);
    let next = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.process_commit(GROUP, &next.commit).unwrap();
    assert_eq!(exported(&alice), exported(&bob));
}

/// A group is kept as loaded for reading, and what's read of it follows each
/// change to it, whether it goes through or not.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn what_is_read_of_a_group_follows_each_change() {
    let (alice, bob) = pair();
    let carol = client("carol");
    let read = |c: &MlsClient| {
        (c.epoch(GROUP).unwrap(), c.members(GROUP).unwrap().len(), c.has_pending(GROUP).unwrap(), exported(c))
    };
    let before = read(&alice);
    assert_eq!(read(&bob), before);

    alice.commit_changes(GROUP, &[carol.generate_key_package(false).unwrap()], &[], None).unwrap();
    assert!(alice.has_pending(GROUP).unwrap());
    assert_ne!(alice.export_pending_secret(GROUP, "zuna/test", b"", 32).unwrap(), before.3);
    alice.clear_pending(GROUP).unwrap();
    assert_eq!(read(&alice), before);

    let pending = alice.commit_changes(GROUP, &[carol.generate_key_package(false).unwrap()], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    let after = read(&alice);
    assert_eq!((after.0, after.1, after.2), (before.0 + 1, 3, false));
    assert_ne!(after.3, before.3);
    assert!(bob.process_commit(GROUP, b"not a commit").is_err());
    assert_eq!(read(&bob), before);
    bob.process_commit(GROUP, &pending.commit).unwrap();
    assert_eq!(read(&bob), after);

    bob.delete_group(GROUP).unwrap();
    assert!(!bob.has_group(GROUP).unwrap());
    assert!(bob.epoch(GROUP).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn rollback_undoes_a_join_the_server_refused() {
    let (public, secret) = signing_keygen().unwrap();
    let mut bob = MlsClient::new(public, secret, b"bob".to_vec(), vec![]);
    let alice = client("alice");
    alice.create_group(GROUP, None).unwrap();
    let kp = bob.generate_key_package(false).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
    bob.take_changes();
    let before = exported(&bob);
    let epoch = bob.epoch(GROUP).unwrap();

    let info = alice.export_group_info(GROUP).unwrap();
    bob.join_external(GROUP, &info).unwrap();
    assert_ne!(bob.epoch(GROUP).unwrap(), epoch);

    bob.rollback();
    assert_eq!(bob.epoch(GROUP).unwrap(), epoch);
    assert_eq!(exported(&bob), before);
    assert!(bob.take_changes().set.is_empty(), "nothing to persist after going back");
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn state_survives_a_restart_through_the_change_log() {
    let (public, secret) = signing_keygen().unwrap();
    let mut bob = MlsClient::new(public.clone(), secret.clone(), b"bob".to_vec(), vec![]);
    let alice = client("alice");
    alice.create_group(GROUP, None).unwrap();
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

    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
    apply(bob.take_changes());
    let next = alice.commit_changes(GROUP, &[], &[], None).unwrap();
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

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_roster_reaches_everyone_and_only_a_commit_changes_it() {
    let alice = client("alice");
    let bob = client("bob");
    alice.create_group(GROUP, Some(b"first")).unwrap();
    assert_eq!(alice.roster(GROUP).unwrap().as_deref(), Some(&b"first"[..]));

    // Someone added by Welcome gets it, as does whoever joins by an external commit.
    let kp = bob.generate_key_package(true).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
    assert_eq!(bob.roster(GROUP).unwrap().as_deref(), Some(&b"first"[..]));

    let changed = bob.commit_changes(GROUP, &[], &[], Some(b"second")).unwrap();
    bob.merge_pending(GROUP).unwrap();
    alice.process_commit(GROUP, &changed.commit).unwrap();
    assert_eq!(alice.roster(GROUP).unwrap().as_deref(), Some(&b"second"[..]));
    assert_eq!(exported(&alice), exported(&bob));

    let carol = client("carol");
    let info = alice.export_group_info(GROUP).unwrap();
    let (commit, _) = carol.join_external(GROUP, &info).unwrap();
    alice.process_commit(GROUP, &commit).unwrap();
    bob.process_commit(GROUP, &commit).unwrap();
    assert_eq!(carol.roster(GROUP).unwrap().as_deref(), Some(&b"second"[..]));
    assert_eq!(exported(&alice), exported(&carol));

    // A group started without one has none, and can still take everyone in.
    let plain = b"another-group-id";
    let dave = client("dave");
    alice.create_group(plain, None).unwrap();
    assert_eq!(alice.roster(plain).unwrap(), None);
    let kp = dave.generate_key_package(false).unwrap();
    let pending = alice.commit_changes(plain, &[kp], &[], None).unwrap();
    alice.merge_pending(plain).unwrap();
    dave.join_from_welcome(&pending.welcome.unwrap(), plain).unwrap();
    assert_eq!(dave.roster(plain).unwrap(), None);
}

/// A key package as plain OpenMLS would make it for this group's suite, signed by
/// `signer` and naming `signature_key`, which the client mustn't take unless it's a
/// device's hybrid key and signature.
fn foreign_key_package(ciphersuite: Ciphersuite, signer: &impl Signer, signature_key: Vec<u8>) -> Vec<u8> {
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    let credential = CredentialWithKey { credential: BasicCredential::new(b"mallory".to_vec()).into(), signature_key: signature_key.into() };
    let capabilities = Capabilities::builder().extensions(vec![ExtensionType::Unknown(ROSTER_EXTENSION)]).build();
    KeyPackage::builder()
        .leaf_node_capabilities(capabilities)
        .build(ciphersuite, &provider, signer, credential)
        .unwrap()
        .key_package()
        .tls_serialize_detached()
        .unwrap()
}

/// Signs with Ed25519 alone, calling it the suite's scheme.
struct Ed25519Only(ed25519_dalek::SigningKey);

impl Signer for Ed25519Only {
    fn sign(&self, payload: &[u8]) -> std::result::Result<Vec<u8>, SignerError> {
        use ed25519_dalek::Signer as _;
        Ok(self.0.sign(payload).to_bytes().to_vec())
    }

    fn signature_scheme(&self) -> SignatureScheme {
        SignatureScheme::MLDSA44
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn groups_and_key_packages_are_under_the_post_quantum_suite() {
    let alice = client("alice");
    alice.create_group(GROUP, None).unwrap();
    // A group info is an MLS message: version and wire format, then its context's version and
    // the suite, here MLKEM768X25519/ChaCha20/SHA-384/ML-DSA-44. A key package goes bare: its
    // version, then the suite.
    let info = alice.export_group_info(GROUP).unwrap();
    assert_eq!(info[6..8], [0x00, 0x52]);
    let package = alice.generate_key_package(false).unwrap();
    assert_eq!(package[2..4], [0x00, 0x52]);
    // Every leaf's key is the device's hybrid one.
    let member = &alice.members(GROUP).unwrap()[0];
    assert_eq!(member.signature_key[0], crate::hybrid::DEVICE);
    assert_eq!(member.signature_key.len(), crate::hybrid::public_len(crate::hybrid::DEVICE).unwrap());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_key_package_signed_with_one_algorithm_alone_isnt_taken() {
    let alice = client("alice");
    alice.create_group(GROUP, None).unwrap();

    // Ed25519 alone, under the suite's code point.
    let ed = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
    let ed_public = ed.verifying_key().to_bytes().to_vec();
    let ed_only = foreign_key_package(CIPHERSUITE, &Ed25519Only(ed), ed_public);
    assert!(alice.key_package_credential(&ed_only).is_err());
    assert!(alice.commit_changes(GROUP, &[ed_only], &[], None).is_err());

    // ML-DSA-44 alone, as the draft's suite means it everywhere else.
    let ml = openmls_basic_credential::SignatureKeyPair::new(SignatureScheme::MLDSA44).unwrap();
    let ml_only = foreign_key_package(CIPHERSUITE, &ml, ml.public().to_vec());
    assert!(alice.key_package_credential(&ml_only).is_err());
    assert!(alice.commit_changes(GROUP, &[ml_only], &[], None).is_err());

    // A device key under the old suite, with X25519 alone.
    let old = openmls_basic_credential::SignatureKeyPair::new(SignatureScheme::ED25519).unwrap();
    let old_suite = foreign_key_package(Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519, &old, old.public().to_vec());
    // Refused by its suite, before its signature is read under the old suite's scheme.
    assert_eq!(alice.key_package_credential(&old_suite).err().as_deref(), Some("key package of another suite"));
    assert!(alice.commit_changes(GROUP, &[old_suite], &[], None).is_err());
    // What's too short to name a suite is no key package either.
    assert!(alice.key_package_credential(&[0, 1, 0]).unwrap_err().starts_with("key package decode"));

    // And the group goes on as it was.
    let bob = client("bob");
    let kp = bob.generate_key_package(false).unwrap();
    let pending = alice.commit_changes(GROUP, &[kp], &[], None).unwrap();
    alice.merge_pending(GROUP).unwrap();
    bob.join_from_welcome(&pending.welcome.unwrap(), GROUP).unwrap();
    assert_eq!(exported(&alice), exported(&bob));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_commit_whose_signature_is_broken_in_either_half_isnt_applied() {
    let (alice, bob) = pair();
    let pending = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    // A member's commit is a PrivateMessage, encrypted, so a flipped byte anywhere fails
    // MLS before the signature's even read: what this shows is that nothing broken is
    // applied, and the group still takes the real one.
    for at in [pending.commit.len() / 2, pending.commit.len() - 20] {
        let mut broken = pending.commit.clone();
        broken[at] ^= 1;
        assert!(bob.process_commit(GROUP, &broken).is_err());
    }
    alice.merge_pending(GROUP).unwrap();
    bob.process_commit(GROUP, &pending.commit).unwrap();
    assert_eq!(exported(&alice), exported(&bob));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_group_info_signed_with_ed25519_alone_isnt_joined() {
    let alice = client("alice");
    alice.create_group(GROUP, None).unwrap();
    let info = alice.export_group_info(GROUP).unwrap();
    // The group info ends with its signature, a hybrid one as a TLS vector: cutting it to
    // its Ed25519 half leaves a group info nobody may join from.
    let signature_len = crate::hybrid::signature_len(crate::hybrid::DEVICE).unwrap();
    let body = &info[..info.len() - signature_len - 2];
    let mut ed_only = body.to_vec();
    ed_only.extend_from_slice(&[0x40, 0x41]);
    ed_only.extend_from_slice(&info[info.len() - signature_len..info.len() - signature_len + 65]);
    let joiner = client("joiner");
    assert!(joiner.join_external(GROUP, &ed_only).is_err());
    assert!(joiner.join_external(GROUP, &info).is_ok());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_provider_does_nothing_but_the_one_suite_with_a_devices_keys() {
    use crate::hybrid::{generate, public, DEVICE, LASTING};
    let crypto = Crypto::default();
    assert!(crypto.supports(CIPHERSUITE).is_ok());
    assert!(crypto.supports(Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519).is_err());
    assert!(crypto.supports(Ciphersuite::MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87).is_err());
    assert_eq!(crypto.supported_ciphersuites(), vec![CIPHERSUITE]);
    // Keys are the core's, never OpenMLS's own.
    assert!(crypto.signature_key_gen(SignatureScheme::MLDSA44).is_err());

    let device = generate(DEVICE).unwrap();
    let device_public = public(&device).unwrap();
    let signature = crypto.sign(SignatureScheme::MLDSA44, b"leaf", &device).unwrap();
    assert!(crypto.verify_signature(SignatureScheme::MLDSA44, b"leaf", &device_public, &signature).is_ok());
    // Under any other scheme's name, the same key signs and verifies nothing.
    assert!(crypto.sign(SignatureScheme::ED25519, b"leaf", &device).is_err());
    assert!(crypto.verify_signature(SignatureScheme::ED25519, b"leaf", &device_public, &signature).is_err());

    // A lasting key, an identity's, is no leaf's.
    let lasting = generate(LASTING).unwrap();
    assert!(crypto.sign(SignatureScheme::MLDSA44, b"leaf", &lasting).is_err());
    let lasting_signature = crate::hybrid::sign(&lasting, b"leaf").unwrap();
    assert!(crypto.verify_signature(SignatureScheme::MLDSA44, b"leaf", &public(&lasting).unwrap(), &lasting_signature).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_client_given_a_lasting_key_makes_nothing_with_it() {
    let lasting = crate::hybrid::generate(crate::hybrid::LASTING).unwrap();
    let public = crate::hybrid::public(&lasting).unwrap();
    let client = MlsClient::new(public, lasting, b"identity".to_vec(), vec![]);
    assert!(client.generate_key_package(false).is_err());
    assert!(client.create_group(GROUP, None).is_err());
    assert!(!client.has_group(GROUP).unwrap());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_group_that_isnt_held_is_an_error_to_read_or_change() {
    let mut alice = client("alice");
    assert!(!alice.has_group(GROUP).unwrap());
    assert!(alice.epoch(GROUP).is_err());
    assert!(alice.own_leaf_index(GROUP).is_err());
    assert!(alice.members(GROUP).is_err());
    assert!(alice.export_secret(GROUP, "zuna/test", b"", 32).is_err());
    assert!(alice.commit_changes(GROUP, &[], &[], None).is_err());
    assert!(alice.merge_pending(GROUP).is_err());
    assert!(alice.clear_pending(GROUP).is_err());
    // Forgetting it is done already.
    alice.delete_group(GROUP).unwrap();
    assert!(alice.take_changes().set.is_empty());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn each_member_knows_its_own_leaf() {
    let (alice, bob) = pair();
    assert_eq!(alice.own_leaf_index(GROUP).unwrap(), 0);
    assert_eq!(bob.own_leaf_index(GROUP).unwrap(), 1);
    let members = alice.members(GROUP).unwrap();
    assert_eq!(members[1].leaf_index, 1);
    assert_eq!(members[1].credential, b"bob");
    // Only a pending commit has a next epoch to export from.
    assert!(alice.export_pending_secret(GROUP, "zuna/test", b"", 32).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_message_of_the_wrong_kind_changes_nothing() {
    let (alice, bob) = pair();
    let epoch = bob.epoch(GROUP).unwrap();

    // An application message, which the core never sends, isn't taken for a commit.
    let message = {
        let _changing = alice.changing(GROUP);
        let mut group = alice.load(GROUP).unwrap();
        group.create_message(&alice.provider, &alice.signer, b"hello").unwrap().tls_serialize_detached().unwrap()
    };
    assert!(bob.process_commit(GROUP, &message).is_err());
    assert_eq!(bob.epoch(GROUP).unwrap(), epoch);

    // A commit is neither a welcome nor a group info, and a group info joins only its group.
    let pending = alice.commit_changes(GROUP, &[], &[], None).unwrap();
    let carol = client("carol");
    assert!(carol.join_from_welcome(&pending.commit, GROUP).is_err());
    assert!(carol.join_external(GROUP, &pending.commit).is_err());
    let info = pending.group_info.unwrap();
    assert!(carol.join_external(b"another group id", &info).is_err());
    assert!(!carol.has_group(b"another group id").unwrap());
    assert!(!carol.has_group(GROUP).unwrap());

    // And the real commit still goes through.
    alice.merge_pending(GROUP).unwrap();
    bob.process_commit(GROUP, &pending.commit).unwrap();
    assert_eq!(exported(&alice), exported(&bob));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn more_groups_than_are_kept_loaded_are_each_read_right() {
    let alice = client("alice");
    let groups: Vec<Vec<u8>> = (0..MAX_LOADED + 3).map(|at| format!("group {at:02}").into_bytes()).collect();
    for (at, group) in groups.iter().enumerate() {
        alice.create_group(group, Some(format!("roster {at}").as_bytes())).unwrap();
    }
    for _ in 0..2 {
        for (at, group) in groups.iter().enumerate() {
            assert_eq!(alice.roster(group).unwrap(), Some(format!("roster {at}").into_bytes()));
            assert!(alice.loaded.borrow().len() <= MAX_LOADED);
        }
    }
    // What's been forgotten is loaded again once it changes.
    let first = &groups[0];
    alice.commit_changes(first, &[], &[], Some(b"changed")).unwrap();
    alice.merge_pending(first).unwrap();
    assert_eq!(alice.roster(first).unwrap(), Some(b"changed".to_vec()));
    assert_eq!(alice.epoch(first).unwrap(), 1);
}

/// What docs/POST_QUANTUM.md's table of sizes says, made again:
/// `cargo test --release --lib measure_groups -- --ignored --nocapture` natively. For each
/// size of group, under this suite, with credentials of the sizes the core makes: the key
/// package, a commit, the welcome to one more device, the group info a commit carries, the
/// state a device keeps, and the time to commit and to join. Groups are filled by one
/// commit of everyone, then devices spread across the tree each commit, 64 of them or 24
/// past a hundred, so that most of its inner nodes are filled, as in a group that's been
/// going a while.
#[cfg(not(target_arch = "wasm32"))]
#[test]
#[ignore]
fn measure_groups() {
    use std::time::Instant;
    let credential_len: usize = std::env::var("ZUNA_CREDENTIAL_BYTES").ok().and_then(|value| value.parse().ok()).unwrap_or(4800);
    let credential = |i: usize| {
        let mut bytes = format!("device {i} ").into_bytes();
        bytes.resize(credential_len, b'.');
        bytes
    };
    println!("credential: {credential_len} bytes");
    for size in [10usize, 100, 1000] {
        let make = |i: usize| {
            let (public, secret) = crate::primitives::signing_keygen().unwrap();
            MlsClient::new(public, secret, credential(i), vec![])
        };
        let creator = make(0);
        creator.create_group(GROUP, None).unwrap();
        let mut members = Vec::new();
        let mut packages = Vec::new();
        for i in 1..size {
            let member = make(i);
            packages.push(member.generate_key_package(false).unwrap());
            members.push(member);
        }
        let key_package = packages[0].len();
        let filled = creator.commit_changes(GROUP, &packages, &[], None).unwrap();
        creator.merge_pending(GROUP).unwrap();
        let welcome = filled.welcome.unwrap();
        // Fill the tree's inner nodes, as members updating over time would. Only the devices that
        // commit join, spread across the tree, so that a thousand of them aren't held in memory.
        let committers: Vec<usize> = {
            let count = members.len().min(if size > 100 { 24 } else { 64 });
            (0..count).map(|index| index * members.len() / count).collect()
        };
        for &at in &committers {
            members[at].join_from_welcome(&welcome, GROUP).unwrap();
        }
        for &at in &committers {
            let commit = members[at].commit_changes(GROUP, &[], &[], None).unwrap();
            members[at].merge_pending(GROUP).unwrap();
            creator.process_commit(GROUP, &commit.commit).unwrap();
            for &other in &committers {
                if other != at {
                    members[other].process_commit(GROUP, &commit.commit).unwrap();
                }
            }
        }
        let newcomer = make(size);
        let started = Instant::now();
        let commit = creator.commit_changes(GROUP, &[newcomer.generate_key_package(false).unwrap()], &[], None).unwrap();
        let commit_time = started.elapsed();
        creator.merge_pending(GROUP).unwrap();
        let started = Instant::now();
        newcomer.join_from_welcome(commit.welcome.as_ref().unwrap(), GROUP).unwrap();
        let join_time = started.elapsed();
        let state: usize = {
            let mut creator = creator;
            creator.take_changes().set.iter().map(|(key, value)| key.len() + value.len()).sum()
        };
        let update = members[0].commit_changes(GROUP, &[], &[], None).unwrap();
        println!(
            "{size:>5} devices: key package {:>6} B, commit (an update) {:>8} B, welcome {:>9} B, group info {:>9} B, state {:>9} B, commit {:>6.1} ms, join {:>6.1} ms",
            key_package,
            update.commit.len(),
            commit.welcome.as_ref().unwrap().len(),
            commit.group_info.as_ref().unwrap().len(),
            state,
            commit_time.as_secs_f64() * 1000.0,
            join_time.as_secs_f64() * 1000.0,
        );
    }
}

/// The same, for the suite of before, X25519 and Ed25519 under plain OpenMLS, with a certificate of
/// the size it was (JSON, about 300 bytes): `cargo test --release --lib measure_groups_before --
/// --ignored --nocapture`. What docs/POST_QUANTUM.md compares the suite with.
#[cfg(not(target_arch = "wasm32"))]
#[test]
#[ignore]
fn measure_groups_before() {
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_rust_crypto::OpenMlsRustCrypto;
    use std::time::Instant;
    const BEFORE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;
    struct Before {
        provider: OpenMlsRustCrypto,
        signer: SignatureKeyPair,
        credential: CredentialWithKey,
    }
    let make = |i: usize| {
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519).unwrap();
        let mut bytes = format!("device {i} ").into_bytes();
        bytes.resize(300, b'.');
        let credential = CredentialWithKey { credential: BasicCredential::new(bytes).into(), signature_key: signer.public().into() };
        Before { provider: OpenMlsRustCrypto::default(), signer, credential }
    };
    let create = MlsGroupCreateConfig::builder().ciphersuite(BEFORE).use_ratchet_tree_extension(true).wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY).build();
    let join = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).wire_format_policy(MIXED_CIPHERTEXT_WIRE_FORMAT_POLICY).build();
    let package = |device: &Before| KeyPackage::builder().build(BEFORE, &device.provider, &device.signer, device.credential.clone()).unwrap().key_package().clone();
    let encoded = |message: &MlsMessageOut| message.tls_serialize_detached().unwrap();
    let welcomed = |device: &Before, welcome: &[u8]| {
        let MlsMessageBodyIn::Welcome(welcome) = MlsMessageIn::tls_deserialize_exact(welcome).unwrap().extract() else { panic!() };
        StagedWelcome::build_from_welcome(&device.provider, &join, welcome).unwrap().build().unwrap().into_group(&device.provider).unwrap()
    };
    let apply = |device: &Before, group: &mut MlsGroup, commit: &[u8]| {
        let message = MlsMessageIn::tls_deserialize_exact(commit).unwrap().try_into_protocol_message().unwrap();
        let ProcessedMessageContent::StagedCommitMessage(staged) = group.process_message(&device.provider, message).unwrap().into_content() else { panic!() };
        group.merge_staged_commit(&device.provider, *staged).unwrap();
    };
    for size in [10usize, 100, 1000] {
        let creator = make(0);
        let mut group = MlsGroup::new_with_group_id(&creator.provider, &creator.signer, &create, GroupId::from_slice(GROUP), creator.credential.clone()).unwrap();
        let members: Vec<Before> = (1..size).map(make).collect();
        let packages: Vec<KeyPackage> = members.iter().map(package).collect();
        let key_package = packages[0].tls_serialize_detached().unwrap().len();
        let (_, welcome, _) = group.add_members(&creator.provider, &creator.signer, &packages).unwrap();
        group.merge_pending_commit(&creator.provider).unwrap();
        let welcome = encoded(&welcome);
        let count = members.len().min(if size > 100 { 24 } else { 64 });
        let committers: Vec<usize> = (0..count).map(|index| index * members.len() / count).collect();
        let mut joined: Vec<(usize, MlsGroup)> = committers.iter().map(|&at| (at, welcomed(&members[at], &welcome))).collect();
        for turn in 0..joined.len() {
            let at = joined[turn].0;
            let (commit, _, _) = joined[turn].1.self_update(&members[at].provider, &members[at].signer, LeafNodeParameters::default()).unwrap().into_messages();
            joined[turn].1.merge_pending_commit(&members[at].provider).unwrap();
            let commit = encoded(&commit);
            apply(&creator, &mut group, &commit);
            for (other, (index, member_group)) in joined.iter_mut().enumerate() {
                if other != turn {
                    apply(&members[*index], member_group, &commit);
                }
            }
        }
        let newcomer = make(size);
        let started = Instant::now();
        let (_, welcome, info) = group.add_members(&creator.provider, &creator.signer, &[package(&newcomer)]).unwrap();
        let commit_time = started.elapsed();
        group.merge_pending_commit(&creator.provider).unwrap();
        let welcome = encoded(&welcome);
        let started = Instant::now();
        welcomed(&newcomer, &welcome);
        let join_time = started.elapsed();
        let state: usize = creator.provider.storage().values.read().unwrap().iter().map(|(key, value)| key.len() + value.len()).sum();
        let (at, member_group) = &mut joined[0];
        let (update, _, _) = member_group.self_update(&members[*at].provider, &members[*at].signer, LeafNodeParameters::default()).unwrap().into_messages();
        println!(
            "{size:>5} devices: key package {:>6} B, commit (an update) {:>8} B, welcome {:>9} B, group info {:>9} B, state {:>9} B, commit {:>6.1} ms, join {:>6.1} ms",
            key_package,
            encoded(&update).len(),
            welcome.len(),
            encoded(&MlsMessageOut::from(info.unwrap())).len(),
            state,
            commit_time.as_secs_f64() * 1000.0,
            join_time.as_secs_f64() * 1000.0,
        );
    }
}
