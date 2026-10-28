import { Collection } from 'framework/collection';
import { SettingsStore } from 'comp/settings/settings-store';
import { FileInfoModel } from 'models/file-info-model';

class FileInfoCollection extends Collection {
    static model = FileInfoModel;

    load() {
        return SettingsStore.load('file-info').then((data) => {
            if (data) {
                for (const item of data) {
                    this.push(new FileInfoModel(item));
                }
                if (this.prune()) {
                    SettingsStore.save('file-info', this);
                }
            }
        });
    }

    prune() {
        // pinned entries are kept like bookmarks; the plain history keeps the
        // five most recent entries, newest first
        const recent = this.filter((fileInfo) => !fileInfo.pinned);
        let removed = 0;
        for (const fileInfo of recent.slice(FileInfoCollection.HistoryLimit)) {
            this.remove(fileInfo.id);
            removed++;
        }
        return removed;
    }

    save() {
        this.prune();
        SettingsStore.save('file-info', this);
    }

    getMatch(storage, name, path) {
        return this.find((fi) => {
            return (
                (fi.storage || '') === (storage || '') &&
                (fi.name || '') === (name || '') &&
                (fi.path || '') === (path || '')
            );
        });
    }

    getByName(name) {
        return this.find((file) => file.name.toLowerCase() === name.toLowerCase());
    }
}

FileInfoCollection.HistoryLimit = 5;

const instance = new FileInfoCollection();

export { instance as FileInfoCollection };
