export class MinkRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "MinkRequestError";
  }
}

export class MinkAgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryCount = 0,
  ) {
    super(message);
    this.name = "MinkAgentError";
  }
}

export class MinkToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinkToolInputError";
  }
}

export class MinkToolTimeoutError extends Error {
  constructor() {
    super("The tool exceeded its execution timeout.");
    this.name = "MinkToolTimeoutError";
  }
}
