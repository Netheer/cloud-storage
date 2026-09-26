import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  DeleteObjectCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  ObjectNotFoundError,
  type ObjectStorage,
  type PutObjectInput,
  type AbortMultipartUploadInput,
  type ListObjectsInput,
  type ListObjectsResult,
} from './object-storage.interface';

@Injectable()
export class S3ObjectStorageService implements ObjectStorage, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const host = configService.getOrThrow<string>('MINIO_ENDPOINT');
    const port = Number(configService.getOrThrow<string>('MINIO_PORT'));
    const useSsl = configService.getOrThrow<string>('MINIO_USE_SSL') === 'true';

    if (!Number.isInteger(port)) {
      throw new Error('MINIO_PORT must be an integer');
    }

    this.bucket = configService.getOrThrow<string>('MINIO_BUCKET');

    this.client = new S3Client({
      endpoint: `${useSsl ? 'https' : 'http'}://${host}:${port}`,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: {
        accessKeyId: configService.getOrThrow<string>('MINIO_ROOT_USER'),
        secretAccessKey: configService.getOrThrow<string>(
          'MINIO_ROOT_PASSWORD',
        ),
      },
    });
  }

  async getObjectStream(objectKey: string): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );

      if (!result.Body) {
        throw new Error('Object storage returned an empty object body');
      }

      if (!(result.Body instanceof Readable)) {
        throw new Error('Object storage returned an unsupported object body');
      }

      return result.Body;
    } catch (error: unknown) {
      if (
        error instanceof NoSuchKey ||
        (error instanceof S3ServiceException && error.name === 'NoSuchKey')
      ) {
        throw new ObjectNotFoundError(objectKey);
      }

      throw error;
    }
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
      }),
    );
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }),
    );
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return;
      }

      throw error;
    }
  }

  async listObjects(input: ListObjectsInput = {}): Promise<ListObjectsResult> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        ContinuationToken: input.continuationToken,
        MaxKeys: input.maxKeys,
      }),
    );

    const objects =
      result.Contents?.flatMap((object) => {
        if (!object.Key) {
          return [];
        }

        return [
          {
            objectKey: object.Key,
            size: object.Size ?? 0,
            lastModified: object.LastModified ?? null,
          },
        ];
      }) ?? [];

    return {
      objects,
      nextContinuationToken:
        result.IsTruncated && result.NextContinuationToken
          ? result.NextContinuationToken
          : null,
    };
  }

  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
      );

      return true;
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return false;
      }

      throw error;
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
