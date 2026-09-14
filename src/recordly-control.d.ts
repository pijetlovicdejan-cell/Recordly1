type RecordlyControlCommand = "record-start" | "record-stop";

type RecordlyControlStatus = {
	recording: boolean;
	paused: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	sourceSelected: boolean;
	sourceName: string | null;
};

interface Window {
	recordlyControl?: {
		subscribe: (callback: (command: RecordlyControlCommand) => void | Promise<void>) => () => void;
		setStatus: (status: RecordlyControlStatus) => void;
	};
}
