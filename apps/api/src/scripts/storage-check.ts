import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.interface';

type DuplicateStoredObject = {
  sha256: string;
  size: bigint;
  count: number;
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const prisma = app.get(PrismaService);
  const objectStorage = app.get<ObjectStorage>(OBJECT_STORAGE);

  try {
    const storedObjects = await prisma.storedObject.findMany({
      select: {
        id: true,
        objectKey: true,
        sha256: true,
        size: true,
        referenceCount: true,
        _count: {
          select: {
            versions: true,
          },
        },
      },
    });

    const previewVersions = await prisma.fileVersion.findMany({
      where: {
        previewObjectKey: {
          not: null,
        },
      },
      select: {
        id: true,
        previewObjectKey: true,
      },
    });

    const referenceCountMismatches = storedObjects.filter(
      (storedObject) =>
        storedObject.referenceCount !== storedObject._count.versions,
    );

    const orphanStoredObjects = storedObjects.filter(
      (storedObject) => storedObject._count.versions === 0,
    );

    const storedObjectGroups = new Map<string, DuplicateStoredObject>();

    for (const storedObject of storedObjects) {
      if (!storedObject.sha256) {
        continue;
      }

      const key = `${storedObject.sha256}:${storedObject.size.toString()}`;

      const existing = storedObjectGroups.get(key);

      if (existing) {
        existing.count += 1;
        continue;
      }

      storedObjectGroups.set(key, {
        sha256: storedObject.sha256,
        size: storedObject.size,
        count: 1,
      });
    }

    const duplicateStoredObjects = [...storedObjectGroups.values()].filter(
      (group) => group.count > 1,
    );

    let missingPhysicalObjects = 0;

    for (const storedObject of storedObjects) {
      const exists = await objectStorage.objectExists(storedObject.objectKey);

      if (!exists) {
        missingPhysicalObjects += 1;
        console.error(
          `Missing physical object: ${storedObject.objectKey} (${storedObject.id})`,
        );
      }
    }

    let missingPreviews = 0;

    for (const version of previewVersions) {
      if (!version.previewObjectKey) {
        continue;
      }

      const exists = await objectStorage.objectExists(version.previewObjectKey);

      if (!exists) {
        missingPreviews += 1;
        console.error(
          `Missing preview: ${version.previewObjectKey} (${version.id})`,
        );
      }
    }

    let continuationToken: string | undefined;
    const physicalObjectKeys = new Set<string>();

    do {
      const result = await objectStorage.listObjects({
        continuationToken,
        maxKeys: 1000,
      });

      for (const object of result.objects) {
        physicalObjectKeys.add(object.objectKey);
      }

      continuationToken = result.nextContinuationToken ?? undefined;
    } while (continuationToken);

    const referencedPhysicalKeys = new Set<string>();

    for (const storedObject of storedObjects) {
      referencedPhysicalKeys.add(storedObject.objectKey);
    }

    for (const version of previewVersions) {
      if (version.previewObjectKey) {
        referencedPhysicalKeys.add(version.previewObjectKey);
      }
    }

    const physicalOrphans = [...physicalObjectKeys].filter(
      (objectKey) => !referencedPhysicalKeys.has(objectKey),
    );

    for (const objectKey of physicalOrphans) {
      console.error(`Physical orphan: ${objectKey}`);
    }

    console.log('');
    console.log('Storage consistency check');
    console.log('-------------------------');
    console.log(`Stored objects checked: ${storedObjects.length}`);
    console.log(`Missing physical objects: ${missingPhysicalObjects}`);
    console.log(`Physical orphans: ${physicalOrphans.length}`);
    console.log(
      `Reference count mismatches: ${referenceCountMismatches.length}`,
    );
    console.log(
      `Stored objects without versions: ${orphanStoredObjects.length}`,
    );
    console.log(`Duplicate hashes: ${duplicateStoredObjects.length}`);
    console.log(`Missing previews: ${missingPreviews}`);

    for (const storedObject of referenceCountMismatches) {
      console.error(
        `Reference mismatch: ${storedObject.id} stored=${storedObject.referenceCount} actual=${storedObject._count.versions}`,
      );
    }

    for (const storedObject of orphanStoredObjects) {
      console.error(`StoredObject without versions: ${storedObject.id}`);
    }

    for (const duplicate of duplicateStoredObjects) {
      console.error(
        `Duplicate StoredObject: sha256=${duplicate.sha256} size=${duplicate.size.toString()} count=${duplicate.count.toString()}`,
      );
    }

    const issueCount =
      missingPhysicalObjects +
      physicalOrphans.length +
      referenceCountMismatches.length +
      orphanStoredObjects.length +
      duplicateStoredObjects.length +
      missingPreviews;

    if (issueCount === 0) {
      console.log('');
      console.log('Storage consistency: OK');
      return;
    }

    console.error('');
    console.error(`Storage consistency: ${issueCount} issue(s) found`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void bootstrap();
