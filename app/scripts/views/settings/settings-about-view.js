import { View } from 'framework/views/view';
import { RuntimeInfo } from 'const/runtime-info';
import { Links } from 'const/links';
import { Features } from 'util/features';
import template from 'templates/settings/settings-about.hbs';

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
            year: new Date().getFullYear()
        });
    }
}

export { SettingsAboutView };
