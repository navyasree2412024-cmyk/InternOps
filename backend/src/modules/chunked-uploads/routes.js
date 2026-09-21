const auth = require('../../middleware/auth');
const {
  createUploadId,
  createSession,
  getSession,
  updateProgress,
  subscribe,
  unsubscribe,
} = require('./progress');
const { isStorageConfigured, createStorageUpload } = require('./storage');

const CHUNK_SIZE = 1024 * 1024; // 1 MB

// Upload streams live for the lifetime of the backend process.
const storageSessions = new Map();

function parseInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return number;
}

async function abortUpload(uploadId, error) {
  const storageUpload = storageSessions.get(uploadId);

  if (storageUpload) {
    try {
      await storageUpload.abort(error);
    } catch {
      // Ignore secondary abort errors.
    }

    storageSessions.delete(uploadId);
  }

  await updateProgress(uploadId, {
    status: 'failed',
  }).catch(() => {});
}

async function routes(fastify) {
  // --------------------------------------------------------------------------
  // Initialize upload
  // --------------------------------------------------------------------------
  fastify.post(
    '/init',
    {
      preHandler: [auth],
      schema: {
        tags: ['Chunked Uploads'],
        description: 'Initialize a 1 MB chunked upload session',
      },
    },
    async (req, reply) => {
      const {
        fileName,
        contentType = 'application/octet-stream',
        totalSize,
        totalChunks,
      } = req.body || {};

      if (
        typeof fileName !== 'string' ||
        !fileName.trim() ||
        !Number.isSafeInteger(totalSize) ||
        totalSize <= 0
      ) {
        return reply.status(400).send({
          error: 'fileName and a valid totalSize are required',
        });
      }

      if (!Number.isSafeInteger(totalChunks) || totalChunks <= 0) {
        return reply.status(400).send({
          error: 'A valid totalChunks value is required',
        });
      }

      const expectedChunks = Math.ceil(totalSize / CHUNK_SIZE);

      if (totalChunks !== expectedChunks) {
        return reply.status(400).send({
          error: 'totalChunks does not match the file size',
          expectedChunks,
        });
      }

      if (!isStorageConfigured()) {
        return reply.status(503).send({
          error: 'Cloud storage is not configured',
        });
      }

      const uploadId = createUploadId();

      let storageUpload;

      try {
        storageUpload = createStorageUpload({
          uploadId,
          userId: req.user.id,
          fileName: fileName.trim(),
          contentType,
        });

        // Attach a rejection handler immediately so a cloud failure is never
        // reported later as an unhandled promise rejection.
        storageUpload.done.catch(() => {});

        await createSession({
          uploadId,
          userId: req.user.id,
          fileName: fileName.trim(),
          contentType,
          totalSize,
          totalChunks,
        });

        storageSessions.set(uploadId, storageUpload);
      } catch (error) {
        try {
          await storageUpload?.abort(error);
        } catch {
          // Ignore cleanup errors.
        }

        return reply.status(500).send({
          error: 'Unable to initialize cloud upload',
        });
      }

      return {
        success: true,
        uploadId,
        chunkSize: CHUNK_SIZE,
        totalChunks,
        progress: 0,
        status: 'initialized',
      };
    }
  );

  // --------------------------------------------------------------------------
  // Upload exactly one sequential chunk
  // --------------------------------------------------------------------------
  fastify.post(
    '/:uploadId/chunk',
    {
      preHandler: [auth],
      schema: {
        tags: ['Chunked Uploads'],
        description: 'Stream one 1 MB upload chunk directly to cloud storage',
      },
    },
    async (req, reply) => {
      const { uploadId } = req.params;

      const session = await getSession(uploadId);

      if (!session) {
        return reply.status(404).send({
          error: 'Upload session not found',
        });
      }

      if (session.userId !== req.user.id) {
        return reply.status(403).send({
          error: 'You do not have access to this upload',
        });
      }

      if (session.status !== 'initialized' && session.status !== 'uploading') {
        return reply.status(409).send({
          error: `Upload is already ${session.status}`,
        });
      }

      const chunkIndex = parseInteger(
        req.headers['x-chunk-index'],
        'x-chunk-index'
      );

      const declaredTotalChunks = parseInteger(
        req.headers['x-total-chunks'],
        'x-total-chunks'
      );

      if (declaredTotalChunks !== session.totalChunks) {
        return reply.status(400).send({
          error: 'x-total-chunks does not match the upload session',
        });
      }

      if (chunkIndex >= session.totalChunks) {
        return reply.status(400).send({
          error: 'Invalid chunk index',
        });
      }

      // The frontend is required to send chunks sequentially.
      // This prevents duplicated/out-of-order bytes from corrupting the
      // long-lived cloud stream.
      if (chunkIndex !== session.receivedChunks) {
        return reply.status(409).send({
          error: 'Chunks must be uploaded sequentially',
          expectedChunkIndex: session.receivedChunks,
        });
      }

      const storageUpload = storageSessions.get(uploadId);

      if (!storageUpload) {
        return reply.status(409).send({
          error: 'Cloud storage upload stream is not available',
        });
      }

      let part;

      try {
        part = await req.file();
      } catch (error) {
        await abortUpload(uploadId, error);

        return reply.status(400).send({
          error: 'Unable to read uploaded chunk',
        });
      }

      if (!part) {
        return reply.status(400).send({
          error: 'No chunk uploaded',
        });
      }

      const isLastChunk = chunkIndex === session.totalChunks - 1;

      const expectedChunkSize = isLastChunk
        ? session.totalSize - CHUNK_SIZE * (session.totalChunks - 1)
        : CHUNK_SIZE;

      let receivedBytes = 0;

      try {
        // Stream directly from Fastify multipart -> PassThrough -> S3.
        // No whole-chunk buffer is created here.
        for await (const chunk of part.file) {
          receivedBytes += chunk.length;

          if (receivedBytes > expectedChunkSize) {
            throw new Error('Chunk exceeds the expected size');
          }

          if (!storageUpload.body.write(chunk)) {
            await new Promise((resolve, reject) => {
              const onDrain = () => {
                cleanup();
                resolve();
              };

              const onError = (error) => {
                cleanup();
                reject(error);
              };

              const cleanup = () => {
                storageUpload.body.off('drain', onDrain);
                storageUpload.body.off('error', onError);
              };

              storageUpload.body.once('drain', onDrain);
              storageUpload.body.once('error', onError);
            });
          }
        }

        if (part.file.truncated) {
          throw new Error('Chunk exceeds the allowed size');
        }

        // We only know that a short chunk is invalid once the stream ends.
        if (receivedBytes !== expectedChunkSize) {
          throw new Error(
            `Invalid chunk size: expected ${expectedChunkSize}, received ${receivedBytes}`
          );
        }

        const nextReceivedChunks = session.receivedChunks + 1;
        const nextReceivedBytes = session.receivedBytes + receivedBytes;

        const progress = await updateProgress(uploadId, {
          receivedChunks: nextReceivedChunks,
          receivedBytes: nextReceivedBytes,
          status:
            nextReceivedChunks === session.totalChunks ? 'ready' : 'uploading',
        });

        return {
          success: true,
          uploadId,
          chunkIndex,
          receivedBytes,
          ...progress,
        };
      } catch (error) {
        await abortUpload(uploadId, error);

        return reply.status(400).send({
          error: error.message || 'Chunk upload failed',
        });
      }
    }
  );

  // --------------------------------------------------------------------------
  // Complete upload
  // --------------------------------------------------------------------------
  fastify.post(
    '/:uploadId/complete',
    {
      preHandler: [auth],
      schema: {
        tags: ['Chunked Uploads'],
        description: 'Finalize a completed chunked upload',
      },
    },
    async (req, reply) => {
      const { uploadId } = req.params;

      const session = await getSession(uploadId);

      if (!session) {
        return reply.status(404).send({
          error: 'Upload session not found',
        });
      }

      if (session.userId !== req.user.id) {
        return reply.status(403).send({
          error: 'You do not have access to this upload',
        });
      }

      if (
        session.receivedChunks !== session.totalChunks ||
        session.receivedBytes !== session.totalSize
      ) {
        return reply.status(409).send({
          error: 'Upload is incomplete',
          receivedChunks: session.receivedChunks,
          totalChunks: session.totalChunks,
          receivedBytes: session.receivedBytes,
          totalSize: session.totalSize,
        });
      }

      const storageUpload = storageSessions.get(uploadId);

      if (!storageUpload) {
        return reply.status(409).send({
          error: 'Cloud storage upload stream is not available',
        });
      }

      try {
        storageUpload.body.end();
        await storageUpload.done;
      } catch (error) {
        await abortUpload(uploadId, error);

        return reply.status(502).send({
          error: 'Cloud storage upload failed',
        });
      }

      storageSessions.delete(uploadId);

      const progress = await updateProgress(uploadId, {
        status: 'completed',
      });

      return {
        success: true,
        uploadId,
        ...progress,
      };
    }
  );

  // --------------------------------------------------------------------------
  // SSE progress stream
  // --------------------------------------------------------------------------
  fastify.get(
    '/:uploadId/progress',
    {
      preHandler: [auth],
      schema: {
        tags: ['Chunked Uploads'],
        description: 'Stream real-time upload progress using SSE',
      },
    },
    async (req, reply) => {
      const { uploadId } = req.params;

      const session = await getSession(uploadId);

      if (!session) {
        return reply.status(404).send({
          error: 'Upload session not found',
        });
      }

      if (session.userId !== req.user.id) {
        return reply.status(403).send({
          error: 'You do not have access to this upload',
        });
      }

      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendProgress = (payload) => {
        reply.raw.write(
          `event: progress\ndata: ${JSON.stringify(payload)}\n\n`
        );
      };

      sendProgress({
        uploadId: session.uploadId,
        progress: session.progress || 0,
        receivedBytes: session.receivedBytes,
        totalSize: session.totalSize,
        receivedChunks: session.receivedChunks,
        totalChunks: session.totalChunks,
        status: session.status,
      });

      subscribe(uploadId, reply);

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe(uploadId, reply);
      });
    }
  );
}

module.exports = routes;
