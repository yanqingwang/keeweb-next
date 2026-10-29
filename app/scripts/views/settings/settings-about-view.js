import { View } from 'framework/views/view';
import { RuntimeInfo } from 'const/runtime-info';
import { Links } from 'const/links';
import { Features } from 'util/features';
import { LibraryVersions } from 'const/library-versions';
import template from 'templates/settings/settings-about.hbs';

// Versions come from the build (package.json), so the list tracks dependency
// bumps by itself instead of being retyped here.
const ver = (name) => ((LibraryVersions[name] || '') + '').replace(/^\^/, '');
const lib = (name, url, desc, version) => ({
    name,
    url,
    desc,
    version: version || ver(name)
});

const coreLibs = [
    lib('kdbxweb', 'https://github.com/keeweb/kdbxweb', 'web kdbx library, &copy; 2016 Antelle'),
    lib(
        'fflate',
        'https://github.com/101arrowz/fflate',
        'high performance (de)compression in an 8kB package, &copy; 2020 Arjun Barrett',
        'bundled'
    ),
    lib(
        '@xmldom/xmldom',
        'https://github.com/xmldom/xmldom',
        'a pure JS W3C Standard based DOMParser and XMLSerializer',
        ver('@xmldom/xmldom')
    ),
    lib(
        'argon2-browser',
        'https://github.com/antelle/argon2-browser',
        'Argon2 hashing algorithm for the browser, &copy; 2017 Antelle'
    )
];

const uiLibs = [
    lib(
        'handlebars',
        'https://handlebarsjs.com/',
        'minimal templating on steroids, &copy; 2011-2019 by Yehuda Katz'
    ),
    lib(
        'morphdom',
        'https://github.com/patrick-steele-idem/morphdom',
        'fast and lightweight DOM diffing/patching, &copy; Patrick Steele-Idem &lt;pnidem@gmail.com&gt;'
    ),
    lib(
        'lodash',
        'https://github.com/lodash/lodash',
        'a modern JavaScript utility library delivering modularity, performance & extras, &copy; OpenJS Foundation and other contributors'
    ),
    lib(
        'jquery',
        'https://github.com/jquery/jquery',
        'fast, small, and feature-rich JavaScript library, https://openjsf.org/'
    )
];

const utilLibs = [
    lib(
        'marked',
        'https://marked.js.org/',
        'a markdown parser and compiler, &copy; 2018+, MarkedJS (https://github.com/chjj/)',
        Links.LicenseApache
    ),
    lib(
        'dompurify',
        'https://github.com/cure53/dompurify',
        'a DOM-only, super-fast, uber-tolerant XSS sanitizer, &copy; 2015 Mario Heideleich,'
    ),
    lib(
        'jsqrcode',
        'https://github.com/antelle/jsqrcode',
        'javascript QR code scanner,',
        'git fork'
    ),
    lib(
        'tweetnacl',
        'https://tweetnacl.js.org/',
        'port of TweetNaCl cryptographic library to JavaScript, public domain'
    )
];

const styleLibs = [
    lib(
        'sass',
        'https://sass-lang.com/',
        'syntactically awesome stylesheets, &copy; 2012-2016 by the Sass Open Style Foundation'
    ),
    lib(
        'bourbon',
        'https://www.bourbon.io/',
        'a lightweight Sass tool set, &copy; 2011-2020 thoughtbot, inc.',
        '7'
    ),
    lib(
        'normalize.css',
        'https://necolas.github.io/normalize.css/',
        'a modern, HTML5-ready alternative to CSS resets, &copy; Nicolas Gallagher and Jonathan Neumeister'
    )
];

const graphicLibs = [
    lib(
        '@fortawesome/fontawesome-free',
        'https://fontawesome.com/',
        'the iconic SVG, font, and CSS toolkit,',
        '5.15'
    )
];

class SettingsAboutView extends View {
    template = template;

    render() {
        super.render({
            version: RuntimeInfo.version,
            // the KeeWeb release this fork is based on; the app version above
            // moves with the fork
            baseVersion: '1.18.9',
            licenseLink: Links.License,
            licenseLinkApache: Links.LicenseApache,
            licenseLinkCCBY40: Links.LicenseLinkCCBY40,
            repoLink: Links.Repo,
            upstreamRepoLink: Links.UpstreamRepo,
            isDesktop: Features.isDesktop,
            coreLibs,
            uiLibs,
            utilLibs,
            styleLibs,
            graphicLibs,
            year: new Date().getFullYear()
        });
    }
}

export { SettingsAboutView };
