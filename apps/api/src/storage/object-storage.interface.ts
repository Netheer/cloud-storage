export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface PutObjectInput {
  objectKey: string;
  body: Buffer;
  contentType?: string;
}

export interface CreatePresignedDownloadUrlInput {
  objectKey: string;
  downloadFileName: string;
  contentType?: string;
  expiresInSeconds: number;
}

export interface ObjectStorage {
  checkHealth(): Promise<void>;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(objectKey: string): Promise<void>;
  createPresignedDownloadUrl(
    input: CreatePresignedDownloadUrlInput,
  ): Promise<string>;
}
