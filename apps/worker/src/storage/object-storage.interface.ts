import type { Readable } from 'node:stream';

export type PutObjectInput = {
  objectKey: string;
  body: Uint8Array;
  contentType: string;
};

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectStorage {
  getObjectStream(objectKey: string): Promise<Readable>;
  deleteObject(objectKey: string): Promise<void>;

  putObject(input: PutObjectInput): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor(objectKey: string) {
    super(`Object ${objectKey} was not found in object storage`);
    this.name = 'ObjectNotFoundError';
  }
}
