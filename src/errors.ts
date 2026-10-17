export type ErrorCode =
	| "NOT_FOUND"
	| "SECTION_NOT_FOUND"
	| "INVALID_REVISION"
	| "INVALID_ARGUMENT"
	| "INVALID_PATH"
	| "INVALID_FILENAME"
	| "INVALID_FRONTMATTER"
	| "ALREADY_EXISTS"
	| "NAME_TAKEN"
	| "DUPLICATE_CANDIDATES"
	| "EDIT_NO_MATCH"
	| "EDIT_AMBIGUOUS"
	| "CONFLICT"
	| "REMOTE_CONFLICT"
	| "HAS_BACKLINKS"
	| "REVERT_CONFLICT"
	| "NOT_RESTORABLE"
	| "UPLOAD_NOT_FOUND"
	| "INVALID_BASE64"
	| "LFS_UNAVAILABLE"
	| "FORBIDDEN"
	| "INTERNAL";

/** An error a tool reports to the client as a structured result, not as a protocol failure. */
export class MemoryError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "MemoryError";
	}

	toJSON(): Record<string, unknown> {
		return { code: this.code, message: this.message, ...this.details };
	}
}
