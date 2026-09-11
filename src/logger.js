// Request-local logging; never retain request IDs, credentials, query strings,
// signed URLs, response headers, or arbitrary upstream exception messages.
export class WorkerLogger {
	constructor(request, debug = false) {
		this.requestId = crypto.randomUUID();
		this.started = Date.now();
		this.method = request.method;
		this.debugEnabled = debug;
	}

	log(event, details = {}) {
		console.log(
			JSON.stringify({
				requestId: this.requestId,
				event,
				method: this.method,
				durationMs: Date.now() - this.started,
				...details,
			}),
		);
	}

	debug(event, details) {
		if (this.debugEnabled) this.log(event, details);
	}
}
