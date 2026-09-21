const crypto = require('crypto');
const { getRedisClient } = require('../../config/redis');

const PROGRESS_TTL_SECONDS = 60 * 60; // 1 hour

const sessions = new Map();

function createUploadId() {
  return crypto.randomUUID();
}

function buildSession(data) {
  return {
    uploadId: data.uploadId,
    userId: data.userId,
    fileName: data.fileName,
    contentType: data.contentType,
    totalSize: data.totalSize,
    totalChunks: data.totalChunks,
    receivedChunks: 0,
    receivedBytes: 0,
    status: 'initialized',
    subscribers: new Set(),
  };
}

async function createSession(data) {
  const session = buildSession(data);

  sessions.set(session.uploadId, session);

  const redis = await getRedisClient();

  if (redis) {
    await redis.set(
      `chunked-upload:${session.uploadId}`,
      JSON.stringify({
        uploadId: session.uploadId,
        userId: session.userId,
        fileName: session.fileName,
        contentType: session.contentType,
        totalSize: session.totalSize,
        totalChunks: session.totalChunks,
        receivedChunks: 0,
        receivedBytes: 0,
        status: 'initialized',
      }),
      { EX: PROGRESS_TTL_SECONDS }
    );
  }

  return session;
}

async function getSession(uploadId) {
  const localSession = sessions.get(uploadId);

  if (localSession) {
    return localSession;
  }

  const redis = await getRedisClient();

  if (!redis) return null;

  const value = await redis.get(`chunked-upload:${uploadId}`);

  if (!value) return null;

  const data = JSON.parse(value);

  const session = {
    ...data,
    subscribers: new Set(),
  };

  sessions.set(uploadId, session);

  return session;
}

async function updateProgress(uploadId, update) {
  const session = await getSession(uploadId);

  if (!session) {
    throw new Error('Upload session not found');
  }

  Object.assign(session, update);

  const progress = Math.min(
    100,
    Math.round((session.receivedBytes / session.totalSize) * 100)
  );

  session.progress = progress;

  const payload = {
    uploadId: session.uploadId,
    progress,
    receivedBytes: session.receivedBytes,
    totalSize: session.totalSize,
    receivedChunks: session.receivedChunks,
    totalChunks: session.totalChunks,
    status: session.status,
  };

  const redis = await getRedisClient();

  if (redis) {
    await redis.set(
      `chunked-upload:${uploadId}`,
      JSON.stringify({
        uploadId: session.uploadId,
        userId: session.userId,
        fileName: session.fileName,
        contentType: session.contentType,
        totalSize: session.totalSize,
        totalChunks: session.totalChunks,
        receivedChunks: session.receivedChunks,
        receivedBytes: session.receivedBytes,
        progress,
        status: session.status,
      }),
      { EX: PROGRESS_TTL_SECONDS }
    );
  }

  notifySubscribers(session, payload);

  return payload;
}

function notifySubscribers(session, payload) {
  const message = `event: progress\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const reply of session.subscribers) {
    try {
      reply.raw.write(message);
    } catch {
      session.subscribers.delete(reply);
    }
  }
}

function subscribe(uploadId, reply) {
  const session = sessions.get(uploadId);

  if (!session) {
    return false;
  }

  session.subscribers.add(reply);

  return true;
}

function unsubscribe(uploadId, reply) {
  const session = sessions.get(uploadId);

  if (!session) return;

  session.subscribers.delete(reply);
}

function deleteSession(uploadId) {
  const session = sessions.get(uploadId);

  if (session) {
    for (const reply of session.subscribers) {
      try {
        reply.raw.end();
      } catch {
        // Ignore already-closed connections.
      }
    }
  }

  sessions.delete(uploadId);
}

function calculateProgress(session) {
  if (!session || !session.totalSize) return 0;

  return Math.min(
    100,
    Math.round((session.receivedBytes / session.totalSize) * 100)
  );
}

module.exports = {
  createUploadId,
  createSession,
  getSession,
  updateProgress,
  subscribe,
  unsubscribe,
  deleteSession,
  calculateProgress,
};
