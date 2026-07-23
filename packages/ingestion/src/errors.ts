export type IngestionErrorCode = 'INVALID_KAGGLE_URL' | 'INVALID_MANIFEST' | 'UNSUPPORTED_TABULAR_FORMAT' | 'MANIFEST_TOO_LARGE';

export class IngestionError extends Error {
  constructor(public readonly code: IngestionErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IngestionError';
  }
}
