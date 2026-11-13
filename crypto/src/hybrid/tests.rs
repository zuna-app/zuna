use super::*;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn each_kind() -> [(u8, usize, usize); 2] {
    [(DEVICE, 1 + 32 + 1312, 1 + 64 + 2420), (LASTING, 1 + 32 + 1952, 1 + 64 + 3309)]
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn each_kind_signs_and_verifies_at_its_sizes() {
    for (kind, public_len, signature_len) in each_kind() {
        let secret = generate(kind).unwrap();
        assert_eq!(secret.len(), SECRET_LEN);
        let key = public(&secret).unwrap();
        assert_eq!(key.len(), public_len);
        assert_eq!(super::public_len(kind), Some(public_len));
        let signature = sign(&secret, b"msg").unwrap();
        assert_eq!(signature.len(), signature_len);
        assert_eq!(super::signature_len(kind), Some(signature_len));
        assert!(verify(&key, b"msg", &signature));
        assert!(!verify(&key, b"other", &signature));
        // Hedged: two signatures of one message differ, and both hold.
        let again = sign(&secret, b"msg").unwrap();
        assert_ne!(again, signature);
        assert!(verify(&key, b"msg", &again));
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_seed_makes_the_same_keys_and_each_kind_its_own() {
    let seed = [7u8; 32];
    let device = secret_from_seed(DEVICE, &seed).unwrap();
    let lasting = secret_from_seed(LASTING, &seed).unwrap();
    assert_eq!(public(&device).unwrap(), public(&device).unwrap());
    // Neither half is shared between kinds, so a key of one is never a key of the other.
    assert_ne!(public(&device).unwrap()[1..33], public(&lasting).unwrap()[1..33]);
    assert!(secret_from_seed(DEVICE, &[0u8; 31]).is_err());
    assert!(secret_from_seed(3, &seed).is_err());
    assert!(public(&seed).is_err());
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn neither_half_holds_on_its_own() {
    for (kind, _, _) in each_kind() {
        let secret = generate(kind).unwrap();
        let key = public(&secret).unwrap();
        let signature = sign(&secret, b"msg").unwrap();
        let other = sign(&secret, b"other").unwrap();

        // A broken Ed25519 half, or ML-DSA half, fails the whole.
        let mut ed = signature.clone();
        ed[5] ^= 1;
        assert!(!verify(&key, b"msg", &ed));
        let mut ml = signature.clone();
        *ml.last_mut().unwrap() ^= 1;
        assert!(!verify(&key, b"msg", &ml));

        // Halves from signatures of other messages don't pair up.
        let mixed = [&signature[..65], &other[65..]].concat();
        assert!(!verify(&key, b"msg", &mixed));
        assert!(!verify(&key, b"other", &mixed));

        // Nor does one key's half with another key's.
        let stranger = generate(kind).unwrap();
        let stranger_signature = sign(&stranger, b"msg").unwrap();
        let spliced = [&signature[..65], &stranger_signature[65..]].concat();
        assert!(!verify(&key, b"msg", &spliced));
        let spliced_key = [&key[..33], &public(&stranger).unwrap()[33..]].concat();
        assert!(!verify(&spliced_key, b"msg", &signature));

        // The Ed25519 half isn't a signature of the message itself, which an Ed25519 check would take.
        let ed_key = ed25519_dalek::VerifyingKey::from_bytes(&key[1..33].try_into().unwrap()).unwrap();
        let ed_signature = ed25519_dalek::Signature::from_bytes(&signature[1..65].try_into().unwrap());
        assert!(ed_key.verify_strict(b"msg", &ed_signature).is_err());

        // Shapes that aren't this kind's are refused.
        assert!(!verify(&key[..key.len() - 1], b"msg", &signature));
        assert!(!verify(&key, b"msg", &signature[..signature.len() - 1]));
        let mut relabelled = signature.clone();
        relabelled[0] = if kind == DEVICE { LASTING } else { DEVICE };
        assert!(!verify(&key, b"msg", &relabelled));
        assert!(!verify(&key[1..33], b"msg", &signature[1..65]));
        assert!(!verify(&[], b"msg", &[]));
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn a_key_of_one_kind_doesnt_verify_as_the_other() {
    let device = generate(DEVICE).unwrap();
    let signature = sign(&device, b"msg").unwrap();
    let mut key = public(&device).unwrap();
    key[0] = LASTING;
    assert!(!verify(&key, b"msg", &signature));
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn ml_dsa65_alone_signs_and_verifies() {
    let seed = [9u8; 32];
    let key = ml_dsa65_public(&seed).unwrap();
    assert_eq!(key.len(), 1952);
    let signature = ml_dsa65_sign(&seed, b"manifest").unwrap();
    assert_eq!(signature.len(), 3309);
    assert!(ml_dsa65_verify(&key, b"manifest", &signature));
    assert!(!ml_dsa65_verify(&key, b"manifest!", &signature));
    // A key or signature of another length is no ML-DSA-65's.
    assert!(!ml_dsa65_verify(&key[..key.len() - 1], b"manifest", &signature));
    assert!(!ml_dsa65_verify(&key, b"manifest", &signature[..signature.len() - 1]));
    assert!(!ml_dsa65_verify(&key, b"manifest", &[signature.as_slice(), &[0]].concat()));
    assert!(ml_dsa65_public(&seed[..31]).is_err());
    assert!(ml_dsa65_sign(&seed[..31], b"manifest").is_err());
}

// FIPS 204's own known answers, the first of each parameter set in NIST's ACVP
// ML-DSA-keyGen-FIPS204 vectors (as circl carries them): the key a seed makes, which
// the server's ML-DSA, from the same seed, has to make too. The key's SHA-256 stands
// for it here.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn ml_dsa_keys_from_a_seed_are_fips_204s() {
    let seed44: [u8; 32] = hex("93EF2E6EF1FB08999D142ABE0295482370D3F43BDB254A78E2B0D5168ECA065F").try_into().unwrap();
    let key44 = ExpandedSigningKey::<MlDsa44>::from_seed(&Seed::from(seed44)).verifying_key().encode();
    assert_eq!(to_hex(&Sha256::digest(key44)), "6995b20ecd5cde41719035028a712ccf35b1adf53b913030423d9d6fa188d673");
    let key65 = ml_dsa65_public(&hex("70CEFB9AED5B68E018B079DA8284B9D5CAD5499ED9C265FF73588005D85C225C")).unwrap();
    assert_eq!(to_hex(&Sha256::digest(key65)), "646b26b8d09dbc9e865b6a006c693a3127b065e62fab5fbe8b159c416462feb6");
}

/// The hex strings under one name in a fixture's JSON, in order.
fn fixture(json: &str, name: &str) -> Vec<Vec<u8>> {
    let needle = format!("\"{name}\": \"");
    json.match_indices(&needle)
        .map(|(at, _)| {
            let start = at + needle.len();
            hex(&json[start..start + json[start..].find('"').unwrap()])
        })
        .collect()
}

fn kinds(json: &str) -> Vec<u8> {
    json.match_indices("\"kind\": ").map(|(at, _)| json[at + 8..at + 9].parse().unwrap()).collect()
}

/// Keys this crate made from fixed seeds, and what it signed with them, which the server's
/// Go code (server/internal/hybrid) derives and verifies the same way.
const RUST_VECTORS: &str = include_str!("../testdata/hybrid-rust.json");

/// What the server's Go code signed, which this has to take.
const GO_VECTORS: &str = include_str!("../testdata/hybrid-go.json");

fn check_vectors(json: &str) {
    let kinds = kinds(json);
    let seeds = fixture(json, "seed");
    let publics = fixture(json, "public");
    let messages = fixture(json, "message");
    let signatures = fixture(json, "signature");
    assert!(kinds.len() >= 2);
    assert_eq!([seeds.len(), publics.len(), messages.len(), signatures.len()], [kinds.len(); 4]);
    for i in 0..kinds.len() {
        let secret = secret_from_seed(kinds[i], &seeds[i]).unwrap();
        assert_eq!(public(&secret).unwrap(), publics[i], "vector {i}'s key");
        assert!(verify(&publics[i], &messages[i], &signatures[i]), "vector {i}'s signature");
        assert!(!verify(&publics[i], b"another message", &signatures[i]));
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn the_vectors_this_made_still_hold() {
    check_vectors(RUST_VECTORS);
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn what_the_go_server_signed_holds() {
    check_vectors(GO_VECTORS);
}

/// Writes RUST_VECTORS again: `UPDATE_HYBRID_VECTORS=1 cargo test hybrid` natively.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn write_vectors_when_asked() {
    if std::env::var("UPDATE_HYBRID_VECTORS").is_err() {
        return;
    }
    let mut entries = Vec::new();
    for (index, (kind, _, _)) in each_kind().into_iter().enumerate() {
        for message in [&b""[..], b"zuna/log/head/v2|example"] {
            let seed: Vec<u8> = (0..32u8).map(|byte| byte.wrapping_mul(31).wrapping_add(index as u8 * 7 + message.len() as u8)).collect();
            let secret = secret_from_seed(kind, &seed).unwrap();
            entries.push(format!(
                "    {{\n      \"kind\": {kind},\n      \"seed\": \"{}\",\n      \"public\": \"{}\",\n      \"message\": \"{}\",\n      \"signature\": \"{}\"\n    }}",
                to_hex(&seed),
                to_hex(&public(&secret).unwrap()),
                to_hex(message),
                to_hex(&sign(&secret, message).unwrap()),
            ));
        }
    }
    let json = format!("{{\n  \"vectors\": [\n{}\n  ]\n}}\n", entries.join(",\n"));
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/hybrid-rust.json"), json).unwrap();
}

/// What Node signs an update manifest with (scripts/release.mjs): its ML-DSA-65 key from a seed is
/// FIPS 204's, as this makes it, and its signature holds here, as the app checks it.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
#[cfg_attr(not(target_arch = "wasm32"), test)]
fn what_node_signs_an_update_with_holds() {
    let json = include_str!("../testdata/ml-dsa-node.json");
    let field = |name: &str| fixture(json, name).remove(0);
    let (seed, public, message, signature) = (field("seed"), field("public"), field("message"), field("signature"));
    assert_eq!(ml_dsa65_public(&seed).unwrap(), public);
    assert!(ml_dsa65_verify(&public, &message, &signature));
    assert!(!ml_dsa65_verify(&public, b"another manifest", &signature));
}
