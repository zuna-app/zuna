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
