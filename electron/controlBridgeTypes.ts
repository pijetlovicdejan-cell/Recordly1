export type ControlBridgeCommand = "record-start" | "record-stop";

export type ControlBridgeStatus = {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	sourceSelected: boolean;
	sourceName: string | null;
};
