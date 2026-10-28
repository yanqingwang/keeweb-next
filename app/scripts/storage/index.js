import { Launcher } from 'comp/launcher';
import { StorageCache } from 'storage/impl/storage-cache';
import { StorageDropbox } from 'storage/impl/storage-dropbox';
import { StorageFile } from 'storage/impl/storage-file';
import { StorageFileCache } from 'storage/impl/storage-file-cache';
import { StorageGDrive } from 'storage/impl/storage-gdrive';
import { StorageOneDrive } from 'storage/impl/storage-onedrive';
import { StorageTeams } from 'storage/impl/storage-teams';
import { StorageWebDav } from 'storage/impl/storage-webdav';
import { createOAuthSession } from 'storage/pkce';

const BuiltInStorage = {
    file: new StorageFile(),
    // the file-backed cache needs a native file backend; without one (the
    // webview shell) the browser cache keeps offline copies in IndexedDB
    cache: Launcher && Launcher.fileStorageSupported ? new StorageFileCache() : new StorageCache()
};

const ThirdPartyStorage = {
    dropbox: new StorageDropbox(),
    gdrive: new StorageGDrive(),
    onedrive: new StorageOneDrive(),
    msteams: new StorageTeams(),
    webdav: new StorageWebDav()
};

const Storage = BuiltInStorage;
if (!Launcher || Launcher.thirdPartyStoragesSupported) {
    Object.assign(Storage, ThirdPartyStorage);
}

requestAnimationFrame(createOAuthSession);

export { Storage };
