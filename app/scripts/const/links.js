const Links = {
    Homepage: 'https://keeweb.info',
    Repo: 'https://github.com/yanqingwang/keeweb-next',
    UpstreamRepo: 'https://github.com/keeweb/keeweb',
    Desktop: 'https://github.com/keeweb/keeweb/releases/latest',
    WebApp: 'https://app.keeweb.info',
    BetaWebApp: 'https://beta.keeweb.info',
    License: 'https://github.com/yanqingwang/keeweb-next/blob/master/LICENSE',
    LicenseApache: 'https://opensource.org/licenses/Apache-2.0',
    LicenseLinkCCBY40: 'https://creativecommons.org/licenses/by/4.0/',
    UpdateBasePath: 'https://github.com/keeweb/keeweb/releases/download/v{ver}/',
    ReleaseNotes: 'https://github.com/keeweb/keeweb/blob/master/release-notes.md#release-notes',
    SelfHostedDropbox: 'https://github.com/keeweb/keeweb#self-hosting',
    UpdateJson: 'https://app.keeweb.info/update.json',
    AutoType: 'https://github.com/keeweb/keeweb/wiki/Auto-Type',
    AutoTypeMacOS: 'https://github.com/keeweb/keeweb/wiki/Auto-Type#macos',
    Translation: 'https://keeweb.oneskyapp.com/',
    Donation: 'https://opencollective.com/keeweb#support',
    // this fork ships its own signed plugin gallery under plugins/; jsDelivr
    // mirrors the repository and is reachable where raw.githubusercontent is
    // not, raw stays as the fallback
    Plugins: 'https://cdn.jsdelivr.net/gh/yanqingwang/keeweb-next@master/plugins',
    PluginsFallback: 'https://raw.githubusercontent.com/yanqingwang/keeweb-next/master/plugins',
    PluginDevelopStart: 'https://github.com/keeweb/keeweb/wiki/Plugins',
    YubiKeyManual: 'https://github.com/keeweb/keeweb/wiki/YubiKey',
    YubiKeyManagerInstall: 'https://github.com/Yubico/yubikey-manager#installation',
    HaveIBeenPwned: 'https://haveibeenpwned.com',
    HaveIBeenPwnedPrivacy: 'https://haveibeenpwned.com/Passwords',
    KphExtensions: [
        {
            name: 'chromeIPass (Chrome, Edge)',
            url:
                'https://chromewebstore.google.com/detail/chromeipass/bocdfmfhfcobbagfcbimemeclglilcbk'
        },
        {
            name: 'KeePassHttp-Connector (Firefox)',
            url: 'https://addons.mozilla.org/firefox/addon/keepasshttp-connector/'
        }
    ],
    ExtensionHelpForOtherBrowsers:
        'https://github.com/keeweb/keeweb/wiki/Browser-AutoFill#other-browsers',
    ExtensionHelpForKPXC:
        'https://github.com/keeweb/keeweb/wiki/Browser-AutoFill#keepassxc-browser',
    KWCForChrome:
        'https://chrome.google.com/webstore/detail/keeweb-connect/pikpfmjfkekaeinceagbebpfkmkdlcjk',
    KWCForFirefox: 'https://addons.mozilla.org/firefox/addon/keeweb-connect/',
    KWCForEdge:
        'https://microsoftedge.microsoft.com/addons/detail/keewebconnect/nmggpehkjmeaeocmaijenpejbepckinm',
    KWCForSafari: 'https://apps.apple.com/app/keeweb-connect/id1565748094'
};

export { Links };
