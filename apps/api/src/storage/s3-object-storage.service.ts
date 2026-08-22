import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type AbortMultipartUploadInput,
  type CompleteMultipartUploadInput,
  type CreateMultipartUploadInput,
  type CreateMultipartUploadResult,
  type CreatePresignedDownloadUrlInput,
  type CreatePresignedUploadPartUrlInput,
  type ListMultipartUploadPartsInput,
  type MultipartUploadPart,
  type ObjectStorage,
  type PutObjectInput,
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

  async checkHealth(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({
        Bucket: this.bucket,
      }),
    );
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

  async createPresignedDownloadUrl(
    input: CreatePresignedDownloadUrlInput,
  ): Promise<string> {
    const encodedFileName = encodeURIComponent(input.downloadFileName).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ResponseContentType: input.contentType ?? 'application/octet-stream',
        ResponseContentDisposition:
          `attachment; filename="download"; ` +
          `filename*=UTF-8''${encodedFileName}`,
      }),
      {
        expiresIn: input.expiresInSeconds,
      },
    );
  }

  async createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<CreateMultipartUploadResult> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error('Object storage did not return a multipart upload ID');
    }

    return {
      uploadId: result.UploadId,
    };
  }

  async createPresignedUploadPartUrl(
    input: CreatePresignedUploadPartUrlInput,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
      }),
      {
        expiresIn: input.expiresInSeconds,
      },
    );
  }

  async listMultipartUploadParts(
    input: ListMultipartUploadPartsInput,
  ): Promise<MultipartUploadPart[]> {
    const parts: MultipartUploadPart[] = [];
    let partNumberMarker: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );

      for (const part of result.Parts ?? []) {
        if (
          part.PartNumber === undefined ||
          part.ETag === undefined ||
          part.Size === undefined
        ) {
          throw new Error(
            'Object storage returned incomplete multipart part metadata',
          );
        }

        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size,
        });
      }

      isTruncated = result.IsTruncated === true;
      partNumberMarker = result.NextPartNumberMarker;

      if (isTruncated && !partNumberMarker) {
        throw new Error(
          'Object storage returned a truncated part list without a marker',
        );
      }
    }

    return parts;
  }

  async completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<void> {
    const parts = [...input.parts].sort(
      (left, right) => left.partNumber - right.partNumber,
    );

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        UploadId: input.uploadId,
      }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
