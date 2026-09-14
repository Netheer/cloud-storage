import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import type { ObjectStorage } from './object-storage.interface';

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
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
