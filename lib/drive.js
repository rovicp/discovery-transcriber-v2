const { google } = require('googleapis');
const { getAuthClient } = require('./auth');
const { withRetry } = require('./retry');

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuthClient() });
}

function extractFolderId(url) {
  if (!url) return null;
  const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(url.trim())) return url.trim();
  return null;
}

async function getFolderName(folderId) {
  const drive = getDrive();
  const res = await withRetry(() => drive.files.get({ fileId: folderId, fields: 'name', supportsAllDrives: true }), 'getFolderName');
  return res.data.name;
}

async function getParentFolderId(folderId) {
  const drive = getDrive();
  const res = await withRetry(() => drive.files.get({ fileId: folderId, fields: 'parents', supportsAllDrives: true }), 'getParentFolderId');
  return res.data.parents ? res.data.parents[0] : null;
}

async function listFilesInFolder(folderId) {
  const drive = getDrive();
  const files = [];
  let pageToken = null;

  do {
    const res = await withRetry(() => drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    }), 'listFilesInFolder');
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function findFolderByName(parentId, name) {
  const drive = getDrive();
  const escaped = name.replace(/'/g, "\\'");
  const res = await withRetry(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }), 'findFolderByName');
  return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
}

async function findFileByName(parentId, name) {
  const drive = getDrive();
  const escaped = name.replace(/'/g, "\\'");
  const res = await withRetry(() => drive.files.list({
    q: `'${parentId}' in parents and name = '${escaped}' and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  }), 'findFileByName');
  return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
}

async function createFolder(name, parentId) {
  const drive = getDrive();
  const res = await withRetry(() => drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  }), 'createFolder');
  return res.data;
}

function getFileUrl(fileId) {
  return `https://drive.google.com/drive/folders/${fileId}`;
}

function getDocUrl(fileId) {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

function getSheetUrl(fileId) {
  return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
}

async function getFileBlob(fileId, mimeType) {
  const drive = getDrive();

  const exportMap = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  if (exportMap[mimeType]) {
    const res = await withRetry(() => drive.files.export(
      { fileId, mimeType: exportMap[mimeType] },
      { responseType: 'arraybuffer' }
    ), 'export file');
    return Buffer.from(res.data);
  }

  const res = await withRetry(() => drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  ), 'download file');
  return Buffer.from(res.data);
}

// Streaming download — returns a readable stream instead of loading the whole
// file into memory. Used for large media files (video/audio) to avoid
// exceeding the server's RAM limit on files in the hundreds of MB.
async function getFileStream(fileId) {
  const drive = getDrive();
  const res = await withRetry(() => drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  ), 'download file stream');
  return res.data; // a Node.js readable stream
}

async function getFileAsBase64(fileId, mimeType) {
  const buffer = await getFileBlob(fileId, mimeType);
  return buffer.toString('base64');
}

async function getFileAsText(fileId, mimeType) {
  const buffer = await getFileBlob(fileId, mimeType);
  return buffer.toString('utf-8');
}

// Memory-safe text extraction — streams the file and stops reading
// as soon as MAX_CHARS is reached. Never loads the full file into RAM.
// Critical for large PDFs (50MB+) on memory-constrained servers.
async function getFileTextStreamed(fileId, mimeType, maxChars) {
  const drive = getDrive();

  const exportMap = {
    'application/vnd.google-apps.document': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  const exportMime = exportMap[mimeType];
  let res;

  if (exportMime) {
    res = await withRetry(() => drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: 'stream' }
    ), 'export file stream');
  } else {
    res = await withRetry(() => drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    ), 'download file stream');
  }

  // Read chunks from the stream until we have enough characters, then destroy
  return new Promise((resolve, reject) => {
    let text = '';
    const stream = res.data;

    stream.on('data', (chunk) => {
      text += chunk.toString('utf-8');
      if (text.length >= maxChars) {
        stream.destroy(); // stop reading — we have enough
      }
    });

    stream.on('end', () => {
      resolve(text.substring(0, maxChars));
    });

    stream.on('close', () => {
      resolve(text.substring(0, maxChars)); // triggered by stream.destroy()
    });

    stream.on('error', (err) => {
      // Ignore "premature close" errors — these are expected when we
      // destroy the stream early after getting enough characters
      if (err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
          err.message.includes('premature') ||
          err.message.includes('destroyed')) {
        resolve(text.substring(0, maxChars));
      } else {
        reject(err);
      }
    });
  });
}

module.exports = {
  getDrive,
  extractFolderId,
  getFolderName,
  getParentFolderId,
  listFilesInFolder,
  findFolderByName,
  findFileByName,
  createFolder,
  getFileUrl,
  getDocUrl,
  getSheetUrl,
  getFileBlob,
  getFileStream,
  getFileAsBase64,
  getFileAsText,
  getFileTextStreamed,
};
