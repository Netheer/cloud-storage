import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type CreatePresignedDownloadUrlInput,
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

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
