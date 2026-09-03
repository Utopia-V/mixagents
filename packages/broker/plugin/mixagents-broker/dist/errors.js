export class BrokerError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "BrokerError";
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }
}
export function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
