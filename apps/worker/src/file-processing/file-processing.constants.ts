export const FILE_PROCESSING_QUEUE_NAME = 'file-processing';
export const PROCESS_FILE_JOB_NAME = 'process-file';

export type ProcessFileJob = {
  fileId: string;
  versionId: string;
  storedObjectId: string;
};
