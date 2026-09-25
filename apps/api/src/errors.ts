export class AppError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503;

  constructor(message: string, status: AppError["status"] = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}
