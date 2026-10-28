use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keeweb_next_lib::keepasshttp::{
    Response,
    encrypt, handle_request, Association, Request, ServerState, Vault, VaultAnswer, VaultEntry,
    VaultReply, VaultRequest,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use serde_json::json;

struct MockVault;

impl Vault for MockVault {
    fn request(&self, request: VaultRequest) -> VaultReply {
        match request {
            VaultRequest::ConfirmAssociation { .. } => Ok(VaultAnswer {
                entries: vec![],
                allowed: true,
                unlocked: true,
            }),
            VaultRequest::GetLogins(_) => Ok(VaultAnswer {
                entries: vec![VaultEntry {
                    uuid: "00112233445566778899aabbccddeeff".to_string(),
                    name: "Example".to_string(),
                    login: "alice".to_string(),
                    password: "s3cret".to_string(),
                }],
                allowed: true,
                unlocked: true,
            }),
            VaultRequest::GetAllLogins => Ok(VaultAnswer {
                entries: vec![VaultEntry {
                    uuid: "00112233445566778899aabbccddeeff".to_string(),
                    name: "Example".to_string(),
                    login: "alice".to_string(),
                    password: "s3cret".to_string(),
                }],
                allowed: true,
                unlocked: true,
            }),
            VaultRequest::GetLoginsByNames { names } => Ok(VaultAnswer {
                entries: if names.iter().any(|name| name == "Example") {
                    vec![VaultEntry {
                        uuid: "00112233445566778899aabbccddeeff".to_string(),
                        name: "Example".to_string(),
                        login: "alice".to_string(),
                        password: "s3cret".to_string(),
                    }]
                } else {
                    vec![]
                },
                allowed: true,
                unlocked: true,
            }),
            VaultRequest::SetLogin { .. } => Ok(VaultAnswer {
                entries: vec![],
                allowed: true,
                unlocked: true,
            }),
        }
    }

    fn database_hash(&self) -> Result<String, &'static str> {
        Ok("abc123".to_string())
    }
}

fn state() -> ServerState {
    ServerState {
        associations: Mutex::new(Default::default()),
        vault: Box::new(MockVault),
    }
}

fn parse(value: serde_json::Value) -> Request {
    serde_json::from_value(value).expect("request parses")
}

fn nonce_and_verifier(key: &[u8], nonce: &[u8; 16]) -> (String, String) {
    let nonce_b64 = STANDARD.encode(nonce);
    (
        nonce_b64.clone(),
        STANDARD.encode(encrypt(nonce_b64.as_bytes(), key, nonce)),
    )
}

/// The single request/response exchange a real client performs, in order.
#[test]
fn associate_and_get_logins_follow_the_wire_protocol() {
    let state = state();

    let key = [7u8; 32];
    let key_b64 = STANDARD.encode(key);
    let nonce = [3u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(&key, &nonce);

    // chromeIPass sends SortSelection/TriggerUnlock as booleans
    let associate = handle_request(
        &state,
        parse(json!({
            "RequestType": "associate",
            "Key": key_b64,
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "SortSelection": false,
            "TriggerUnlock": false
        })),
    );
    assert!(associate.success, "associate failed");
    let id = associate.id.clone().expect("association id");
    assert_eq!(associate.hash, "abc123");

    let response_nonce = associate.nonce.expect("associate nonce");
    let response_verifier = associate.verifier.expect("associate verifier");
    assert!(
        keeweb_next_lib::keepasshttp::verify(&response_verifier, &response_nonce, &key)
            .expect("verifier decodes"),
        "response verifier must decrypt to its nonce"
    );

    let nonce2 = [4u8; 16];
    let (nonce2_b64, verifier2) = nonce_and_verifier(&key, &nonce2);
    let test_associate = handle_request(
        &state,
        parse(json!({
            "RequestType": "test-associate",
            "Id": id,
            "Nonce": nonce2_b64,
            "Verifier": verifier2,
            "SortSelection": false,
            "TriggerUnlock": false
        })),
    );
    assert!(test_associate.success, "test-associate failed");

    let nonce3 = [5u8; 16];
    let (nonce3_b64, verifier3) = nonce_and_verifier(&key, &nonce3);
    let url = STANDARD.encode(encrypt(
        b"https://example.com/login",
        &key,
        &nonce3,
    ));
    let logins = handle_request(
        &state,
        parse(json!({
            "RequestType": "get-logins",
            "Id": id,
            "Nonce": nonce3_b64,
            "Verifier": verifier3,
            "Url": url,
            "SortSelection": false,
            "TriggerUnlock": false
        })),
    );
    assert!(logins.success, "get-logins failed");
    assert_eq!(logins.count, 1);
    let entry = &logins.entries.expect("entries")[0];
    let iv = STANDARD
        .decode(logins.nonce.as_deref().expect("response nonce"))
        .expect("nonce decodes");
    let plain = keeweb_next_lib::keepasshttp::decrypt(
        &STANDARD.decode(&entry.login).expect("login base64"),
        &key,
        &iv,
    )
    .expect("login decrypts");
    assert_eq!(plain, b"alice");
}

#[test]
fn unknown_ids_are_rejected() {
    let state = state();
    let key = [1u8; 32];
    let nonce = [2u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(&key, &nonce);
    let response = handle_request(
        &state,
        parse(json!({
            "RequestType": "get-logins",
            "Id": "0123456789abcdef",
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "Url": STANDARD.encode(encrypt(b"https://x", &key, &nonce)),
            "SortSelection": false
        })),
    );
    assert!(!response.success);
}

#[test]
fn working_association_is_stored() {
    let state = state();
    let key = [9u8; 32];
    let nonce = [8u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(&key, &nonce);
    let response = handle_request(
        &state,
        parse(json!({
            "RequestType": "associate",
            "Key": STANDARD.encode(key),
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "SortSelection": false
        })),
    );
    assert!(response.success);
    let stored: Vec<Association> = state
        .associations
        .lock()
        .expect("lock")
        .values()
        .cloned()
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].key, key.to_vec());
}


fn associate(state: &ServerState, key: &[u8]) -> Response {
    let nonce = [6u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(key, &nonce);
    handle_request(
        state,
        parse(json!({
            "RequestType": "associate",
            "Key": STANDARD.encode(key),
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "SortSelection": false
        })),
    )
}

#[test]
fn responses_carry_the_upstream_hmac() {
    let state = state();
    let key = [3u8; 32];
    let response = associate(&state, &key);
    assert!(response.success);
    let nonce = STANDARD.decode(response.nonce.as_deref().expect("nonce")).unwrap();
    let cipher = STANDARD
        .decode(response.verifier.as_deref().expect("verifier"))
        .unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).unwrap();
    mac.update(&nonce);
    mac.update(&cipher);
    let expected = STANDARD.encode(mac.finalize().into_bytes());
    assert_eq!(response.hmac.as_deref(), Some(expected.as_str()));

    // and a forged hmac on a follow-up request is rejected
    let forged = handle_request(
        &state,
        parse(json!({
            "RequestType": "test-associate",
            "Id": response.id.clone().unwrap(),
            "Nonce": STANDARD.encode([7u8; 16]),
            "Verifier": STANDARD.encode(encrypt(b"not-the-nonce", &key, &[7u8; 16])),
            "Hmac": "AAAA",
            "SortSelection": false
        })),
    );
    assert!(!forged.success);
}

#[test]
fn all_logins_and_lookup_by_name_are_supported() {
    let state = state();
    let key = [4u8; 32];
    let assoc = associate(&state, &key);
    let id = assoc.id.clone().unwrap();

    let nonce = [8u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(&key, &nonce);
    let all = handle_request(
        &state,
        parse(json!({
            "RequestType": "get-all-logins",
            "Id": id,
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "SortSelection": false
        })),
    );
    assert!(all.success, "get-all-logins failed");
    assert_eq!(all.count, 1);

    let nonce = [9u8; 16];
    let (nonce_b64, verifier) = nonce_and_verifier(&key, &nonce);
    let name_enc = STANDARD.encode(encrypt(b"Example", &key, &nonce));
    let by_name = handle_request(
        &state,
        parse(json!({
            "RequestType": "get-logins-by-names",
            "Id": id,
            "Nonce": nonce_b64,
            "Verifier": verifier,
            "Names": [name_enc],
            "SortSelection": false
        })),
    );
    assert!(by_name.success, "get-logins-by-names failed");
    assert_eq!(by_name.count, 1);
}
