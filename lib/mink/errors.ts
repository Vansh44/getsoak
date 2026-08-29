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
