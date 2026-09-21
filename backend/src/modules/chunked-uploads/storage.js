const { PassThrough } = require('stream');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const config = require('../../config');

const CLOUD_PART_SIZE = 5 * 1024 * 1024; // 5 MB
const QUEUE_SIZE = 1;

function isStorageConfigured() {
  return Boolean(
    config.storage.bucket &&
    config.storage.accessKeyId &&
    config.storage.secretAccessKey
  );
}

function createS3Client() {
  return new S3Client({
    region: config.storage.region,
    endpoint: config.storage.endpoint || undefined,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
  });
}

function sanitizeFileName(fileName) {
  return String(fileName || 'upload.bin')
    .replace(/[/\\]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 200);
}

function createObjectKey({ uploadId, userId, fileName }) {
  return `chunked-uploads/${userId}/${uploadId}-${sanitizeFileName(fileName)}`;
}

function createStorageUpload({ uploadId, userId, fileName, contentType }) {
  if (!isStorageConfigured()) {
    throw new Error('Cloud storage is not configured');
  }

  const body = new PassThrough({
    highWaterMark: CLOUD_PART_SIZE,
  });

  const objectKey = createObjectKey({
    uploadId,
    userId,
    fileName,
  });

  const client = createS3Client();

  const upload = new Upload({
    client,
    params: {
      Bucket: config.storage.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    },
    partSize: CLOUD_PART_SIZE,
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false,
  });

  const done = upload.done();

  // Always attach a rejection handler immediately.
  // The /complete route will still await the same promise.
  done.catch(() => {});

  return {
    body,
    done,
    objectKey,
    async abort(error) {
      body.destroy(error || new Error('Upload aborted'));
    },
  };
}

module.exports = {
  CLOUD_PART_SIZE,
  isStorageConfigured,
  createStorageUpload,
};
