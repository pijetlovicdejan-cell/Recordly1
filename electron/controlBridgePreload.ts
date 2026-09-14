import { ipcRenderer } from "electron";
import type { ControlBridgeCommand, ControlBridgeStatus } from "./controlBridgeTypes";

export function createControlBridgeApi() {
	return {
		subscribe(callback: (command: ControlBridgeCommand) => void | Promise<void>) {
			const listener = (_event: Electron.IpcRendererEvent, command: ControlBridgeCommand) => {
				void callback(command);
			};

			ipcRenderer.on("control-bridge-command", listener);
			ipcRenderer.send("control-bridge-renderer-ready");

			return () => {
				ipcRenderer.removeListener("control-bridge-command", listener);
			};
		},
		setStatus(status: ControlBridgeStatus) {
			ipcRenderer.send("control-bridge-status", status);
		},
	};
}
