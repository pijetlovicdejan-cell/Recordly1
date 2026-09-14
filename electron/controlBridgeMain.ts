import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { app, ipcMain, type WebContents } from "electron";
import type { ControlBridgeCommand, ControlBridgeStatus } from "./controlBridgeTypes";

const DEFAULT_PORT = 47831;
const LOOPBACK_HOST = "127.0.0.1";

const defaultStatus: ControlBridgeStatus = {
	recording: false,
	paused: false,
	finalizing: false,
	countdownActive: false,
	sourceSelected: false,
	sourceName: null,
};

let controlRenderer: WebContents | null = null;
let controlServer: Server | null = null;
let status: ControlBridgeStatus = { ...defaultStatus };

function parsePort(value: string | undefined): number {
	if (!value) return DEFAULT_PORT;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
	});
	response.end(JSON.stringify(payload));
}

function isAuthorized(request: IncomingMessage, token: string) {
	return request.headers.authorization === `Bearer ${token}`;
}

function normalizeStatus(value: unknown): ControlBridgeStatus | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<ControlBridgeStatus>;

	if (
		typeof candidate.recording !== "boolean" ||
		typeof candidate.paused !== "boolean" ||
		typeof candidate.finalizing !== "boolean" ||
		typeof candidate.countdownActive !== "boolean" ||
		typeof candidate.sourceSelected !== "boolean" ||
		!(typeof candidate.sourceName === "string" || candidate.sourceName === null)
	) {
		return null;
	}

	return {
		recording: candidate.recording,
		paused: candidate.paused,
		finalizing: candidate.finalizing,
		countdownActive: candidate.countdownActive,
		sourceSelected: candidate.sourceSelected,
		sourceName: candidate.sourceName,
	};
}

function registerControlRenderer(sender: WebContents) {
	if (controlRenderer === sender) return;
	controlRenderer = sender;

	sender.once("destroyed", () => {
		if (controlRenderer === sender) {
			controlRenderer = null;
			status = { ...defaultStatus };
		}
	});
}

ipcMain.on("control-bridge-renderer-ready", (event) => {
	registerControlRenderer(event.sender);
});

ipcMain.on("control-bridge-status", (event, nextStatus: unknown) => {
	const normalized = normalizeStatus(nextStatus);
	if (!normalized) {
		console.warn("[control-bridge] Ignored malformed renderer status payload.");
		return;
	}

	registerControlRenderer(event.sender);
	status = normalized;
});

function getControlRenderer(): WebContents | null {
	if (!controlRenderer || controlRenderer.isDestroyed()) {
		controlRenderer = null;
		return null;
	}
	return controlRenderer;
}

function dispatchCommand(command: ControlBridgeCommand): boolean {
	const renderer = getControlRenderer();
	if (!renderer) return false;
	renderer.send("control-bridge-command", command);
	return true;
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	port: number,
) {
	try {
		if (request.headers.origin) {
			writeJson(response, 403, {
				success: false,
				error: "Browser-origin requests are not allowed.",
			});
			return;
		}

		if (!isAuthorized(request, token)) {
			writeJson(response, 401, { success: false, error: "Unauthorized." });
			return;
		}

		const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
		const rendererReady = getControlRenderer() !== null;

		if (request.method === "GET" && url.pathname === "/status") {
			writeJson(response, 200, {
				success: true,
				bridge: "recordly-control",
				version: 1,
				appVersion: app.getVersion(),
				host: LOOPBACK_HOST,
				port,
				rendererReady,
				...status,
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/record/start") {
			if (status.recording) {
				writeJson(response, 200, {
					success: true,
					accepted: false,
					reason: "already-recording",
				});
				return;
			}
			if (status.finalizing || status.countdownActive) {
				writeJson(response, 409, { success: false, error: "Recorder is busy." });
				return;
			}
			if (!status.sourceSelected) {
				writeJson(response, 409, {
					success: false,
					error: "No recording source is selected.",
				});
				return;
			}
			if (!dispatchCommand("record-start")) {
				writeJson(response, 503, { success: false, error: "Recorder UI is not ready." });
				return;
			}

			writeJson(response, 202, {
				success: true,
				accepted: true,
				command: "record-start",
			});
			return;
		}

		if (request.method === "POST" && url.pathname === "/record/stop") {
			if (!status.recording) {
				writeJson(response, 200, {
					success: true,
					accepted: false,
					reason: "not-recording",
				});
				return;
			}
			if (!dispatchCommand("record-stop")) {
				writeJson(response, 503, { success: false, error: "Recorder UI is not ready." });
				return;
			}

			writeJson(response, 202, {
				success: true,
				accepted: true,
				command: "record-stop",
			});
			return;
		}

		writeJson(response, 404, { success: false, error: "Not found." });
	} catch (error) {
		console.error("[control-bridge] Request failed:", error);
		if (!response.headersSent) {
			writeJson(response, 500, { success: false, error: "Internal control bridge error." });
		} else {
			response.end();
		}
	}
}

function startControlBridge() {
	if (controlServer || process.env.RECORDLY_CONTROL_ENABLED !== "1") return;

	const token = process.env.RECORDLY_CONTROL_TOKEN?.trim() ?? "";
	if (!token) {
		console.warn(
			"[control-bridge] RECORDLY_CONTROL_ENABLED=1 but RECORDLY_CONTROL_TOKEN is missing; bridge will stay disabled.",
		);
		return;
	}

	const port = parsePort(process.env.RECORDLY_CONTROL_PORT);
	const server = createServer((request, response) => {
		void handleRequest(request, response, token, port);
	});

	server.once("error", (error) => {
		console.error(`[control-bridge] Failed to listen on ${LOOPBACK_HOST}:${port}:`, error);
		if (controlServer === server) controlServer = null;
	});

	server.listen(port, LOOPBACK_HOST, () => {
		controlServer = server;
		console.info(`[control-bridge] Listening on http://${LOOPBACK_HOST}:${port}`);
	});
}

void app.whenReady().then(startControlBridge);

app.on("before-quit", () => {
	if (controlServer) {
		controlServer.close();
		controlServer = null;
	}
});
