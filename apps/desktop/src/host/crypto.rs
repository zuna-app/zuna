//! `__zunaCrypto`: the encryption core, called directly. It mirrors the iOS host's
//! CryptoBridge.swift, so the core bundle's crypto shim (apps/ios/core-bundle/src/crypto.ts)
//! gets the same functions with the same results as the WebAssembly build's.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use rquickjs::function::Rest;
use rquickjs::{Array, Ctx, Function, Object, Result, Value};
use zuna_crypto::{mls, primitives};

use super::js::*;

#[derive(Default)]
struct Clients {
    clients: HashMap<u32, mls::MlsClient>,
    next: u32,
}

fn key_pair<'js>(ctx: &Ctx<'js>, pair: (Vec<u8>, Vec<u8>)) -> Result<Value<'js>> {
    object(ctx, vec![("publicKey", new_bytes(ctx, &pair.0)?), ("secretKey", new_bytes(ctx, &pair.1)?)])
}

macro_rules! define {
    ($object:expr, $ctx:expr, $name:literal, |$c:ident, $a:ident| $body:expr) => {
        $object.set(
            $name,
            Function::new($ctx.clone(), move |$c: Ctx<'js>, Rest($a): Rest<Value<'js>>| -> Result<Value<'js>> { $body })?
                .with_name($name)?,
        )?;
    };
}

pub fn install<'js>(ctx: &Ctx<'js>) -> Result<()> {
    let crypto = Object::new(ctx.clone())?;
    let clients = Rc::new(RefCell::new(Clients { next: 1, ..Default::default() }));

    define!(crypto, ctx, "randomBytes", |c, a| {
        let bytes = check(&c, primitives::random_bytes(number_arg(&a, 0) as usize))?;
        new_bytes(&c, bytes)
    });
    define!(crypto, ctx, "argon2id", |c, a| {
        let out = check(
            &c,
            primitives::argon2id(
                &bytes_arg(&a, 0),
                &bytes_arg(&a, 1),
                number_arg(&a, 2) as u32,
                number_arg(&a, 3) as u32,
                number_arg(&a, 4) as u32,
                number_arg(&a, 5) as usize,
            ),
        )?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "hkdfSha256", |c, a| {
        let out = check(&c, primitives::hkdf_sha256(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2), number_arg(&a, 3) as usize))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "sha256", |c, a| new_bytes(&c, primitives::sha256(&bytes_arg(&a, 0))));
    define!(crypto, ctx, "aeadSeal", |c, a| {
        let out = check(&c, primitives::aead_seal(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "aeadOpen", |c, a| {
        let out = check(&c, primitives::aead_open(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "streamSeal", |c, a| {
        let out = check(
            &c,
            primitives::stream_seal(&bytes_arg(&a, 0), &bytes_arg(&a, 1), number_arg(&a, 2) as u64, bool_arg(&a, 3), &bytes_arg(&a, 4)),
        )?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "streamOpen", |c, a| {
        let out = check(
            &c,
            primitives::stream_open(&bytes_arg(&a, 0), &bytes_arg(&a, 1), number_arg(&a, 2) as u64, bool_arg(&a, 3), &bytes_arg(&a, 4)),
        )?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "signingKeygen", |c, _a| {
        let pair = check(&c, primitives::signing_keygen())?;
        key_pair(&c, pair)
    });
    define!(crypto, ctx, "sign", |c, a| {
        let out = check(&c, primitives::sign(&bytes_arg(&a, 0), &bytes_arg(&a, 1)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "verify", |c, a| Ok(boolean(&c, primitives::verify(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2)))));
    define!(crypto, ctx, "signingPublic", |c, a| {
        let out = check(&c, primitives::signing_public(&bytes_arg(&a, 0)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "tokenBlind", |c, a| {
        let out = check(&c, primitives::token_blind(number_arg(&a, 0) as usize))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "tokenFinalize", |c, a| {
        let out = check(&c, primitives::token_finalize(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2), &bytes_arg(&a, 3)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "hpkeKeygen", |c, _a| {
        let pair = check(&c, primitives::hpke_keygen())?;
        key_pair(&c, pair)
    });
    define!(crypto, ctx, "hpkeSeal", |c, a| {
        let out = check(&c, primitives::hpke_seal(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2), &bytes_arg(&a, 3)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "hpkeOpen", |c, a| {
        let out = check(&c, primitives::hpke_open(&bytes_arg(&a, 0), &bytes_arg(&a, 1), &bytes_arg(&a, 2), &bytes_arg(&a, 3)))?;
        new_bytes(&c, out)
    });
    define!(crypto, ctx, "safetyDigest", |c, a| new_bytes(&c, primitives::safety_digest(&bytes_arg(&a, 0), &bytes_arg(&a, 1))));

    {
        let clients = clients.clone();
        define!(crypto, ctx, "mlsNew", |c, a| {
            let mut state = Vec::new();
            if let Some(entries) = a.get(3).and_then(|value| value.as_array()) {
                for entry in entries.iter::<Array>() {
                    let entry = entry?;
                    let key = entry.get::<Value>(0)?;
                    let value = entry.get::<Value>(1)?;
                    state.push((read_bytes(&key).unwrap_or_default(), read_bytes(&value).unwrap_or_default()));
                }
            }
            let client = mls::MlsClient::new(bytes_arg(&a, 0), bytes_arg(&a, 1), bytes_arg(&a, 2), state);
            let mut clients = clients.borrow_mut();
            let handle = clients.next;
            clients.next += 1;
            clients.clients.insert(handle, client);
            Ok(number(&c, handle as f64))
        });
    }
    {
        let clients = clients.clone();
        define!(crypto, ctx, "mlsFree", |c, a| {
            clients.borrow_mut().clients.remove(&(number_arg(&a, 0) as u32));
            Ok(Value::new_undefined(c))
        });
    }
    {
        let clients = clients.clone();
        define!(crypto, ctx, "mls", |c, a| {
            let handle = number_arg(&a, 0) as u32;
            let method = string_arg(&a, 1);
            let mut clients = clients.borrow_mut();
            let Some(client) = clients.clients.get_mut(&handle) else {
                return Err(fail(&c, format!("MLS client {handle} doesn't exist")));
            };
            call_mls(&c, client, &method, &a[2.min(a.len())..])
        });
    }

    ctx.globals().set("__zunaCrypto", crypto)?;
    Ok(())
}

fn call_mls<'js>(c: &Ctx<'js>, client: &mut mls::MlsClient, method: &str, a: &[Value<'js>]) -> Result<Value<'js>> {
    let undefined = || Value::new_undefined(c.clone());
    let group_id = || bytes_arg(a, 0);
    match method {
        "setCredential" => {
            client.set_credential(bytes_arg(a, 0));
            Ok(undefined())
        }
        "takeChanges" => {
            let changes = client.take_changes();
            let set = Array::new(c.clone())?;
            for (index, (key, value)) in changes.set.iter().enumerate() {
                let pair = Array::new(c.clone())?;
                pair.set(0, new_bytes(c, key)?)?;
                pair.set(1, new_bytes(c, value)?)?;
                set.set(index, pair)?;
            }
            object(c, vec![("set", set.into_value()), ("deleted", bytes_array(c, &changes.deleted)?)])
        }
        "rollback" => {
            client.rollback();
            Ok(undefined())
        }
        "hasGroup" => Ok(boolean(c, check(c, client.has_group(&group_id()))?)),
        "generateKeyPackage" => new_bytes(c, check(c, client.generate_key_package(bool_arg(a, 0)))?),
        "keyPackageCredential" => new_bytes(c, check(c, client.key_package_credential(&group_id()))?),
        "keyPackageSignatureKey" => new_bytes(c, check(c, client.key_package_signature_key(&group_id()))?),
        "createGroup" => {
            let roster = optional_bytes_arg(a, 1);
            Ok(number(c, check(c, client.create_group(&group_id(), roster.as_deref()))? as f64))
        }
        "commitChanges" => {
            let packages: Vec<Vec<u8>> = a
                .get(1)
                .and_then(|value| value.as_array())
                .map(|array| array.iter::<Value>().filter_map(|item| item.ok()).map(|item| read_bytes(&item).unwrap_or_default()).collect())
                .unwrap_or_default();
            let removes = a.get(2).map(read_u32s).unwrap_or_default();
            let roster = optional_bytes_arg(a, 3);
            let pending = check(c, client.commit_changes(&group_id(), &packages, &removes, roster.as_deref()))?;
            object(
                c,
                vec![
                    ("commit", new_bytes(c, &pending.commit)?),
                    ("welcome", optional_bytes(c, pending.welcome.as_ref())?),
                    ("groupInfo", optional_bytes(c, pending.group_info.as_ref())?),
                ],
            )
        }
        "mergePending" => Ok(number(c, check(c, client.merge_pending(&group_id()))? as f64)),
        "clearPending" => {
            check(c, client.clear_pending(&group_id()))?;
            Ok(undefined())
        }
        "hasPending" => Ok(boolean(c, check(c, client.has_pending(&group_id()))?)),
        "processCommit" => {
            let processed = check(c, client.process_commit(&group_id(), &bytes_arg(a, 1)))?;
            object(
                c,
                vec![
                    ("epoch", number(c, processed.epoch as f64)),
                    ("senderCredential", new_bytes(c, &processed.sender_credential)?),
                    ("isExternal", boolean(c, processed.is_external)),
                    ("addedCredentials", bytes_array(c, &processed.added_credentials)?),
                    ("removedCredentials", bytes_array(c, &processed.removed_credentials)?),
                    ("selfRemoved", boolean(c, processed.self_removed)),
                ],
            )
        }
        "joinFromWelcome" => {
            let (joined, epoch) = check(c, client.join_from_welcome(&bytes_arg(a, 0), &bytes_arg(a, 1)))?;
            object(c, vec![("groupId", new_bytes(c, &joined)?), ("epoch", number(c, epoch as f64))])
        }
        "joinExternal" => {
            let (commit, epoch) = check(c, client.join_external(&group_id(), &bytes_arg(a, 1)))?;
            object(c, vec![("commit", new_bytes(c, &commit)?), ("epoch", number(c, epoch as f64))])
        }
        "exportGroupInfo" => new_bytes(c, check(c, client.export_group_info(&group_id()))?),
        "epoch" => Ok(number(c, check(c, client.epoch(&group_id()))? as f64)),
        "roster" => optional_bytes(c, check(c, client.roster(&group_id()))?),
        "ownLeafIndex" => Ok(number(c, check(c, client.own_leaf_index(&group_id()))? as f64)),
        "members" => {
            let members = check(c, client.members(&group_id()))?;
            let array = Array::new(c.clone())?;
            for (index, member) in members.iter().enumerate() {
                array.set(
                    index,
                    object(
                        c,
                        vec![
                            ("leafIndex", number(c, member.leaf_index as f64)),
                            ("credential", new_bytes(c, &member.credential)?),
                            ("signatureKey", new_bytes(c, &member.signature_key)?),
                        ],
                    )?,
                )?;
            }
            Ok(array.into_value())
        }
        "exportSecret" | "exportPendingSecret" => {
            let label = string_arg(a, 1);
            let context = bytes_arg(a, 2);
            let length = number_arg(a, 3) as usize;
            let secret = if method == "exportSecret" {
                client.export_secret(&group_id(), &label, &context, length)
            } else {
                client.export_pending_secret(&group_id(), &label, &context, length)
            };
            new_bytes(c, check(c, secret)?)
        }
        "deleteGroup" => {
            check(c, client.delete_group(&group_id()))?;
            Ok(undefined())
        }
        _ => Err(fail(c, format!("Unknown MLS method {method}"))),
    }
}
