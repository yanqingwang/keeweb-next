use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keeweb_next_lib::keepasshttp::verify;
use keeweb_next_lib::keepasshttp::{
    handle_request, Association, Request, ServerState, Vault, VaultAnswer, VaultEntry,
    VaultRequest,
};
use sha1::{Digest, Sha1};

fn sha1_hex(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[derive(Clone)]
struct FakeVault {
    entries: Vec<VaultEntry>,
    allowed: bool,
    unlocked: bool,
}

impl Vault for FakeVault {
    fn request(&self, request: VaultRequest) -> Result<VaultAnswer, String> {
        match request {
            VaultRequest::ConfirmAssociation { key } => {
                assert_eq!(key.len(), 32);
                Ok(VaultAnswer {
                    entries: vec![],
                    allowed: self.allowed,
                    unlocked: true,
                })
            }
            VaultRequest::GetLogins(_) => Ok(VaultAnswer {
                entries: self.entries.clone(),
                allowed: self.allowed,
                unlocked: self.unlocked,
            }),
            VaultRequest::SetLogin { .. } => Ok(VaultAnswer {
                entries: vec![],
                allowed: self.allowed,
                unlocked: self.unlocked,
            }),
        }
    }

    fn database_hash(&self) -> Result<String, &'static str> {
        Ok("abc123".to_string())
    }
}

fn state(vault: FakeVault) -> ServerState {
    ServerState {
        associations: Mutex::new(HashMap::new()),
        vault: Box::new(vault),
    }
}

fn aes_encrypt(plain: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    type Enc = cbc::Encryptor<aes::Aes256>;
    use cbc::cipher::{block_padding::Pkcs7, BlockModeEncrypt, KeyIvInit};
    Enc::new_from_slices(key, iv)
        .expect("sizes")
        .encrypt_padded_vec::<Pkcs7>(plain)
}

fn aes_decrypt(cipher: &[u8], key: &[u8], iv: &[u8]) -> Vec<u8> {
    type Dec = cbc::Decryptor<aes::Aes256>;
    use cbc::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
    Dec::new_from_slices(key, iv)
        .expect("sizes")
        .decrypt_padded_vec::<Pkcs7>(cipher)
        .expect("padding")
}

fn key() -> [u8; 32] {
    let mut key = [7u8; 32];
    key[0] = 42;
    key
}

fn verifier(nonce_b64: &str) -> String {
    // KeePassHttp encrypts the base64 *text* of the nonce, so the verifier is
    // 32 bytes of ciphertext, not 16
    STANDARD.encode(aes_encrypt(
        nonce_b64.as_bytes(),
        &key(),
        &STANDARD.decode(nonce_b64).unwrap(),
    ))
}

fn nonce_b64() -> String {
    STANDARD.encode([1u8; 16])
}

fn request(request_type: &str, id: &str) -> Request {
    serde_json::from_value(serde_json::json!({
        "RequestType": request_type,
        "TriggerUnlock": false,
        "Nonce": nonce_b64(),
        "Verifier": verifier(&nonce_b64()),
        "Id": id,
    }))
    .unwrap()
}

fn associated_state_with(vault: FakeVault) -> (ServerState, String) {
    let key_b64 = STANDARD.encode(key());
    let id = sha1_hex(&key_b64);
    let state = state(vault);
    state.associations.lock().unwrap().insert(
        id.clone(),
        Association {
            id: id.clone(),
            key: key().to_vec(),
        },
    );
    (state, id)
}

#[test]
fn test_helpers_roundtrip() {
    let key = key();
    let nonce_b64 = STANDARD.encode([1u8; 16]);
    let nonce = STANDARD.decode(&nonce_b64).unwrap();
    let ct = aes_encrypt(&nonce, &key, &nonce);
    let pt = aes_decrypt(&ct, &key, &nonce);
    assert_eq!(pt, nonce, "test helpers must roundtrip");
}

#[test]
fn verifier_matches_the_module_decrypt() {
    let nonce_b64 = STANDARD.encode([1u8; 16]);
    let nonce = STANDARD.decode(&nonce_b64).unwrap();
    // the verifier covers the base64 *text* of the nonce (KeePassHttp C#
    // encrypts the string), which the module's verify expects
    let v = verifier(&nonce_b64);
    let v2 = STANDARD.encode(keeweb_next_lib::keepasshttp::encrypt(
        &nonce_b64.clone().into_bytes(),
        &key(),
        &nonce,
    ));
    assert_eq!(v, v2, "test helper must match the module encrypt");
    assert!(verify(&v, &nonce_b64, &key()).unwrap());
}

#[test]
fn associate_persists_a_key_after_user_approval() {
    let mut req: Request = request("associate", "client-1");
    req.key = Some(STANDARD.encode(key()));
    let state = state(FakeVault {
        entries: vec![],
        allowed: true,
        unlocked: true,
    });

    let response = handle_request(&state, req);
    assert!(response.success, "response: {:?}", response.id);
    let id = response.id.expect("id");
    assert_eq!(id, sha1_hex(&STANDARD.encode(key())));
    assert!(
        state.associations.lock().unwrap().contains_key(&id),
        "association must be stored"
    );
}

#[test]
fn associate_is_refused_when_the_user_rejects() {
    let mut req: Request = request("associate", "client-1");
    req.key = Some(STANDARD.encode(key()));
    let state = state(FakeVault {
        entries: vec![],
        allowed: false,
        unlocked: true,
    });

    let response = handle_request(&state, req);
    assert!(!response.success);
    assert!(state.associations.lock().unwrap().is_empty());
}

#[test]
fn a_stored_key_passes_test_associate() {
    let key_b64 = STANDARD.encode(key());
    let id = sha1_hex(&key_b64);
    let state = state(FakeVault {
        entries: vec![],
        allowed: true,
        unlocked: true,
    });
    state.associations.lock().unwrap().insert(
        id.clone(),
        Association {
            id: id.clone(),
            key: key().to_vec(),
        },
    );

    let response = handle_request(&state, request("test-associate", &id));
    assert!(response.success);
    assert_eq!(response.id.as_deref(), Some(id.as_str()));
}

#[test]
fn a_replayed_verifier_under_a_new_nonce_fails() {
    let key_b64 = STANDARD.encode(key());
    let id = sha1_hex(&key_b64);
    let state = state(FakeVault {
        entries: vec![],
        allowed: true,
        unlocked: true,
    });
    state.associations.lock().unwrap().insert(
        id.clone(),
        Association {
            id: id.clone(),
            key: key().to_vec(),
        },
    );

    // verifier computed over a *different* nonce than the request carries
    let mut req: Request = request("test-associate", &id);
    let stale_nonce = STANDARD.encode([9u8; 16]);
    req.nonce = Some(nonce_b64());
    req.verifier = Some(STANDARD.encode(aes_encrypt(
        STANDARD.decode(&stale_nonce).unwrap().as_slice(),
        &key(),
        &STANDARD.decode(&stale_nonce).unwrap(),
    )));

    let response = handle_request(&state, req);
    assert!(!response.success, "replay must not verify");
}

#[test]
fn get_logins_returns_encrypted_entries() {
    let (state, id) = associated_state_with(FakeVault {
        entries: vec![VaultEntry {
            uuid: "uuid-1".to_string(),
            name: "Example".to_string(),
            login: "user@example.org".to_string(),
            password: "hunter2".to_string(),
        }],
        allowed: true,
        unlocked: true,
    });

    let url = "https://example.org/login";
    let nonce = nonce_b64();
    let mut req: Request = request("get-logins", &id);
    req.url = Some(STANDARD.encode(aes_encrypt(
        url.as_bytes(),
        &key(),
        &STANDARD.decode(&nonce).unwrap(),
    )));

    let response = handle_request(&state, req);
    assert!(response.success, "get-logins must succeed");
    assert_eq!(response.count, 1);
    let entries = response.entries.expect("entries");
    assert_eq!(entries.len(), 1);

    let response_nonce = response.nonce.as_deref().expect("response nonce");
    let iv = STANDARD.decode(response_nonce).unwrap();
    let login = String::from_utf8(aes_decrypt(
        &STANDARD.decode(&entries[0].login).unwrap(),
        &key(),
        &iv,
    ))
    .unwrap();
    let password = String::from_utf8(aes_decrypt(
        &STANDARD.decode(entries[0].password.as_deref().unwrap()).unwrap(),
        &key(),
        &iv,
    ))
    .unwrap();
    assert_eq!(login, "user@example.org");
    assert_eq!(password, "hunter2");
}

#[test]
fn a_locked_vault_refuses_get_logins() {
    let key_b64 = STANDARD.encode(key());
    let id = sha1_hex(&key_b64);
    let state = state(FakeVault {
        entries: vec![VaultEntry {
            uuid: "u".to_string(),
            name: "n".to_string(),
            login: "l".to_string(),
            password: "p".to_string(),
        }],
        allowed: true,
        unlocked: false,
    });
    state.associations.lock().unwrap().insert(
        id.clone(),
        Association {
            id: id.clone(),
            key: key().to_vec(),
        },
    );

    let nonce = nonce_b64();
    let mut req: Request = request("get-logins", &id);
    req.url = Some(STANDARD.encode(aes_encrypt(
        b"https://example.org",
        &key(),
        &STANDARD.decode(&nonce).unwrap(),
    )));

    let response = handle_request(&state, req);
    assert!(!response.success);
    assert!(
        response
            .error
            .as_deref()
            .is_some_and(|e| e.contains("locked")),
        "error: {:?}",
        response.error
    );
}

#[test]
fn an_unknown_command_is_reported() {
    let state = state(FakeVault {
        entries: vec![],
        allowed: true,
        unlocked: true,
    });
    let response = handle_request(&state, request("bogus-command", "client-1"));
    assert!(!response.success);
    assert!(
        response
            .error
            .as_deref()
            .is_some_and(|e| e.contains("unknown command")),
        "error: {:?}",
        response.error
    );
}
