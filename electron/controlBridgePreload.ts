import http, { type IncomingMessage, type ServerResponse } from "node:http";

export type ControlBridgeCommand = "record-start" | "record-stop";

export type ControlBridgeStatus = {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	sourceSelected: boolean;
	sourceName: string | null;
};

type ControlBridgeListener = (command: ControlBridgeCommand) => void | Promise<void>;

const DEFAULT_PORT = 47831;
const LOOPBACK_HOST = "127.0.0.1";

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
	});
	response.end(JSON.stringify(payload));
}

function isAuthorized(request: IncomingMessage, token: string) {
	return request.headers.authorization === `Bearer ${token}`;
}

export function createControlBridgeApi() {
	let listener: ControlBridgeListener | null = null;
	let server: http.Server | null = null;
	let startAttempted = false;
	let status: ControlBridgeStatus = {
		recording: false,
		paused: false,
		finalizing: false,
		countdownActive: false,
		sourceSelected: false,
		sourceName: null,
	};

	const port = parsePort(process.env.RECORDLY_CONTROL_PORT);
	const enabled = process.env.RECORDLY_CONTROL_ENABLED === "1";
	const token = process.env.RECORDLY_CONTROL_TOKEN?.trim() ?? "";

	const ensureServer = () => {
		if (server || startAttempted || !enabled) return;
		startAttempted = true;

		if (!token) {
			console.warn(
				"[control-bridge] RECORDLY_CONTROL_ENABLED=1 but RECORDLY_CONTROL_TOKEN is missing; bridge will stay disabled.",
			);
			return;
		}

		server = http.createServer(async (request, response) => {
			if (request.headers.origin) {
				writeJson(response, 403, { success: false, error: "Browser-origin requests are not allowed." });
				return;
			}

			if (!isAuthorized(request, token)) {
				writeJson(response, 401, { success: false, error: "Unauthorized." });
				return;
			}

			const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);

			if (request.method === "GET" && url.pathname === "/status") {
				writeJson(response, 200, {
					success: true,
					bridge: "recordly-control",
					version: 1,
					host: LOOPBACK_HOST,
					port,
					...status,
				});
				return;
			}

			if (request.method === "POST" && url.pathname === "/record/start") {
				if (status.recording) {
					writeJson(response, 200, { success: true, accepted: false, reason: "already-recording" });
					return;
				}
				if (status.finalizing || status.countdownActive) {
					writeJson(response, 409, { success: false, error: "Recorder is busy." });
					return;
				}
				if (!status.sourceSelected) {
					writeJson(response, 409, { success: false, error: "No recording source is selected." });
					return;
				}
				if (!listener) {
					writeJson(response, 503, { success: false, error: "Recorder UI is not ready." });
					return;
				}

				await listener("record-start");
				writeJson(response, 202, { success: true, accepted: true, command: "record-start" });
				return;
			}

			if (request.method === "POST" && url.pathname === "/record/stop") {
				if (!status.recording) {
					writeJson(response, 200, { success: true, accepted: false, reason: "not-recording" });
					return;
				}
				if (!listener) {
					writeJson(response, 503, { success: false, error: "Recorder UI is not ready." });
					return;
				}

				await listener("record-stop");
				writeJson(response, 202, { success: true, accepted: true, command: "record-stop" });
				return;
			}

			writeJson(response, 404, { success: false, error: "Not found." });
		});

		server.on("error", (error) => {
			console.error(`[control-bridge] Failed to listen on ${LOOPBACK_HOST}:${port}:`, error);
			server = null;
		});

		server.listen(port, LOOPBACK_HOST, () => {
			console.info(`[control-bridge] Listening on http://${LOOPBACK_HOST}:${port}`);
		});
	};

	return {
		subscribe(callback: ControlBridgeListener) {
			listener = callback;
			ensureServer();
			return () => {
				if (listener === callback) listener = null;
			};
		},
		setStatus(nextStatus: ControlBridgeStatus) {
			status = { ...nextStatus };
		},
	};
}
