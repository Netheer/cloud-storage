import type { Readable } from 'node:stream';

export type PutObjectInput = {
  objectKey: string;
  body: Uint8Array;
  contentType: string;
};

export type AbortMultipartUploadInput = {
  objectKey: string;
  uploadId: string;
};

export type StoredObjectEntry = {
  objectKey: string;
  size: number;
  lastModified: Date | null;
};

export type ListObjectsInput = {
  continuationToken?: string;
  maxKeys?: number;
};

export type ListObjectsResult = {
  objects: StoredObjectEntry[];
  nextContinuationToken: string | null;
};

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectStorage {
  getObjectStream(objectKey: string): Promise<Readable>;

  putObject(input: PutObjectInput): Promise<void>;

  deleteObject(objectKey: string): Promise<void>;

  abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void>;

  listObjects(input?: ListObjectsInput): Promise<ListObjectsResult>;

  objectExists(objectKey: string): Promise<boolean>;
}

export class ObjectNotFoundError extends Error {
  constructor(objectKey: string) {
    super(`Object ${objectKey} was not found in object storage`);
    this.name = 'ObjectNotFoundError';
  }
}
