import api, { getAccessToken } from './axios';

export const CHUNK_SIZE = 1024 * 1024; // 1 MB

function getProgressUrl(uploadId) {
  return `${api.defaults.baseURL.replace(/\/+$/, '')}/chunked-uploads/${uploadId}/progress`;
}

export async function subscribeToUploadProgress(uploadId, onProgress) {
  const controller = new AbortController();
  const token = getAccessToken();

  const response = await fetch(getProgressUrl(uploadId), {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Progress stream failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('SSE streaming is not supported by this browser');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';

  const readLoop = async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const dataLine = event
            .split('\n')
            .find((line) => line.startsWith('data:'));

          if (!dataLine) {
            continue;
          }

          try {
            const payload = JSON.parse(dataLine.slice(5).trim());

            onProgress?.(payload);
          } catch {
            // Ignore malformed SSE data.
          }
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        throw error;
      }
    }
  };

  void readLoop();

  return () => controller.abort();
}

export async function uploadFileInChunks(file, { onProgress } = {}) {
  if (!(file instanceof File)) {
    throw new TypeError('A File object is required');
  }

  if (file.size <= 0) {
    throw new Error('Cannot upload an empty file');
  }

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const { data: session } = await api.post('/chunked-uploads/init', {
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    totalSize: file.size,
    totalChunks,
  });

  const { uploadId } = session;

  let stopProgress = null;

  try {
    stopProgress = await subscribeToUploadProgress(uploadId, onProgress);

    // Required by Issue #1966:
    // send exactly one 1 MB chunk at a time, sequentially.
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);

      const chunk = file.slice(start, end);

      const formData = new FormData();

      formData.append('file', chunk, `${file.name}.part-${chunkIndex}`);

      await api.post(`/chunked-uploads/${uploadId}/chunk`, formData, {
        headers: {
          'X-Chunk-Index': String(chunkIndex),
          'X-Total-Chunks': String(totalChunks),
        },

        // Override the normal 15-second Axios timeout.
        // Large chunks may legitimately take longer.
        timeout: 0,
      });
    }

    const { data } = await api.post(`/chunked-uploads/${uploadId}/complete`);

    onProgress?.({
      uploadId,
      progress: 100,
      receivedBytes: file.size,
      totalSize: file.size,
      receivedChunks: totalChunks,
      totalChunks,
      status: 'completed',
    });

    return data;
  } finally {
    stopProgress?.();
  }
}

export async function uploadFilesInChunks(files, { onProgress } = {}) {
  const results = [];

  for (const file of files) {
    const result = await uploadFileInChunks(file, {
      onProgress: (progress) => {
        onProgress?.(file, progress);
      },
    });

    results.push({
      file,
      result,
    });
  }

  return results;
}
