use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keeweb_next_lib::keepasshttp::{
    encrypt, handle_request, Association, Request, ServerState, Vault, VaultAnswer, VaultEntry,
    VaultReply, VaultRequest,
};
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
