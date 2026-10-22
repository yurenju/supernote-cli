// Ported to TypeScript from rnbennett/supernote-cloud (supernote_cloud/exceptions.py),
// Apache-2.0, original work © Julian Prester. Modified by the supernote-cli authors.

export class ApiError extends Error {
  readonly errorCode: string | undefined;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.name = "ApiError";
    this.errorCode = errorCode;
  }
}

export class AuthenticationError extends ApiError {
  constructor(message: string, errorCode?: string) {
    super(message, errorCode);
    this.name = "AuthenticationError";
  }
}

/**
 * Supernote Cloud rejected the access token: it is missing, expired or wrong.
 * The only fix is a new token from a fresh login.
 */
export class AccessTokenRejected extends AuthenticationError {
  constructor(message = "Supernote Cloud rejected the access token", errorCode?: string) {
    super(message, errorCode);
    this.name = "AccessTokenRejected";
  }
}

/**
 * Login needs identity verification: a code emailed to the account owner.
 * Replaces the upstream `"__E1760__:<timestamp>"` string sentinel.
 */
export class IdentityVerificationRequired extends AuthenticationError {
  readonly timestamp: string;

  constructor(timestamp: string, message = "Identity verification required") {
    super(message, "E1760");
    this.name = "IdentityVerificationRequired";
    this.timestamp = timestamp;
  }
}

export class FileFolderNotFound extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = "FileFolderNotFound";
  }
}

/** A write would land on a name the target folder already has. */
export class FileFolderExists extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = "FileFolderExists";
  }
}

/** Deleting a folder that still has contents, without asking for a recursive delete. */
export class FolderNotEmpty extends ApiError {
  constructor(message: string) {
    super(message);
    this.name = "FolderNotEmpty";
  }
}

/** Supernote Cloud refuses to store content it already has, in any folder or even deleted. */
export class DuplicateContent extends ApiError {
  constructor(message: string) {
    super(message, "E0310");
    this.name = "DuplicateContent";
  }
}
