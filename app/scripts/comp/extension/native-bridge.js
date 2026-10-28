// Native-messaging transport for KeePassXC-Browser.
//
// The helper binary forwards each browser message to the shell over a Unix
// socket; the shell re-emits it as a Tauri event. The protocol itself (keys,
// encryption, actions) is the same implementation the in-page bridge uses, so
// the extension gets identical answers on both transports.

import { invoke, isTauri } from 'util/tauri';
import { ProtocolImpl } from './protocol-impl';
import { Logger } from 'util/logger';

const logger = new Logger('native-bridge');

let started = false;

function connectionFor(connectionId) {
    return {
        connectionId,
        extensionName: 'KeePassXC-Browser',
        appName: 'native messaging'
    };
}

function start() {
    if (!isTauri || started) {
        return;
    }
    started = true;
    window.__TAURI__.event.listen('browser-rpc', async (event) => {
        const { id, connection_id: connectionId, request } = event.payload;
        let result = null;
        let error = null;
        try {
            result = await ProtocolImpl.handleRequest(request, connectionFor(connectionId));
        } catch (e) {
            error = e && e.message ? e.message : String(e);
            logger.error('Request failed', request && request.action, error);
        }
        try {
            await invoke('browser_rpc_reply', { reply: { id, result, error } });
        } catch (e) {
            logger.error('Cannot deliver the reply', e);
        }
    });
    logger.info('Native messaging bridge started');
}

export { start as startNativeBridge };
