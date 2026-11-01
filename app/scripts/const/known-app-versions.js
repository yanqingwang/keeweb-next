// What this app reports as its KeePassXC version. KeePassXC-Browser decides
// which protocol actions it may send by comparing the reported version with
// the release each action appeared in, so this is a capability statement, not
// a claim about upstream:
//   2.6.1  get-totp
//   2.7.0  generate-password, downloadFavicon
//   2.7.7  passkeys-get, passkeys-register
// 2.7.10 would also enable passkeysDefaultGroup, which is not implemented:
// the group for new passkeys is always the "Browser" group.
const KnownAppVersions = {
    KeePassXC: '2.7.7'
};

export { KnownAppVersions };
