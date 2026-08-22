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

export interface CreateMultipartUploadInput {
  objectKey: string;
  contentType?: string;
}

export interface CreateMultipartUploadResult {
  uploadId: string;
}

export interface CreatePresignedUploadPartUrlInput {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  expiresInSeconds: number;
}

export interface ListMultipartUploadPartsInput {
  objectKey: string;
  uploadId: string;
}

export interface MultipartUploadPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedMultipartUploadPart {
  partNumber: number;
  etag: string;
}

export interface CompleteMultipartUploadInput {
  objectKey: string;
  uploadId: string;
  parts: CompletedMultipartUploadPart[];
}

export interface AbortMultipartUploadInput {
  objectKey: string;
  uploadId: string;
}

export interface ObjectStorage {
  checkHealth(): Promise<void>;

  putObject(input: PutObjectInput): Promise<void>;

  deleteObject(objectKey: string): Promise<void>;

  createPresignedDownloadUrl(
    input: CreatePresignedDownloadUrlInput,
  ): Promise<string>;

  createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<CreateMultipartUploadResult>;

  createPresignedUploadPartUrl(
    input: CreatePresignedUploadPartUrlInput,
  ): Promise<string>;

  listMultipartUploadParts(
    input: ListMultipartUploadPartsInput,
  ): Promise<MultipartUploadPart[]>;

  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<void>;

  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void>;
}
