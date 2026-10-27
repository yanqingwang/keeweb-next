use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keeweb_next_lib::keepasshttp::{
    handle_request, Request, ServerState, Vault, VaultAnswer, VaultRequest,
};

struct AllowVault;
impl Vault for AllowVault {
    fn request(&self, _request: VaultRequest) -> Result<VaultAnswer, String> {
        Ok(VaultAnswer {
            entries: vec![],
            allowed: true,
            unlocked: true,
        })
    }
    fn database_hash(&self) -> Result<String, &'static str> {
        Ok("hash".to_string())
    }
}

fn state() -> ServerState {
    ServerState {
        associations: Mutex::new(HashMap::new()),
        vault: Box::new(AllowVault),
    }
}

fn parse(body: serde_json::Value) -> Request {
    serde_json::from_value(body).unwrap()
}

#[test]
fn a_request_with_a_broken_nonce_is_refused() {
    let response = handle_request(
        &state(),
        parse(serde_json::json!({
            "RequestType": "associate",
            "Key": STANDARD.encode([0u8; 32]),
            "Nonce": "!!!not base64!!!",
            "Verifier": "???",
        })),
    );
    assert!(!response.success);
}

#[test]
fn a_request_with_a_wrong_key_length_is_refused() {
    let nonce = STANDARD.encode([1u8; 16]);
    let response = handle_request(
        &state(),
        parse(serde_json::json!({
            "RequestType": "associate",
            "Key": STANDARD.encode([0u8; 16]), // 128-bit, not 256
            "Nonce": nonce,
            "Verifier": STANDARD.encode([2u8; 16]),
        })),
    );
    assert!(!response.success);
    assert!(
        state().associations.lock().unwrap().is_empty(),
        "nothing may be stored for a bad key"
    );
}

#[test]
fn a_get_logins_without_an_association_is_refused() {
    let nonce = STANDARD.encode([1u8; 16]);
    let response = handle_request(
        &state(),
        parse(serde_json::json!({
            "RequestType": "get-logins",
            "Nonce": nonce,
            "Verifier": STANDARD.encode([2u8; 16]),
            "Id": "nope",
            "Url": STANDARD.encode([3u8; 16]),
        })),
    );
    assert!(!response.success);
}

#[test]
fn an_oversized_field_does_not_reach_the_handler() {
    // 2 MB of base64 in a single field; the JSON parses but the request is
    // refused before any allocation amplification
    let big = "A".repeat(2 * 1024 * 1024);
    let response = handle_request(
        &state(),
        parse(serde_json::json!({
            "RequestType": "associate",
            "Key": STANDARD.encode([0u8; 32]),
            "Nonce": nonce_b64(),
            "Verifier": big,
        })),
    );
    assert!(!response.success);
}

fn nonce_b64() -> String {
    STANDARD.encode([1u8; 16])
}
