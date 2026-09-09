const { listFilesInFolder, getFolderName } = require('../lib/drive');

const TEXT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'application/rtf',
];

const IMAGE_MIME_TYPES = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
];

// Audio/video file extensions — used as a fallback when Drive reports a generic
// or missing MIME type (e.g. application/octet-stream) so no media is missed
// among a folder full of documents.
const MEDIA_EXTENSIONS = new Set([
  // audio
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aiff', 'aif',
  'wma', 'amr', 'caf', 'ac3',
  // video
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpeg', 'mpg',
  '3gp', '3g2', 'mts', 'm2ts', 'ts', 'vob', 'mxf', 'asf',
]);

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// A file is media if Drive reports any audio/* or video/* MIME type, OR the
// filename has a known audio/video extension (covers octet-stream / unknown).
function isMediaFile(mimeType, name) {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return true;
  return MEDIA_EXTENSIONS.has(fileExt(name));
}

module.exports = async function crawler(job, addLog) {
  const files = [];
  await crawlFolder(job.folderId, '', files, addLog);
  const media = files.filter((f) => f.isMedia);
  addLog(`Crawl complete: ${files.length} file(s) found across all subfolders; ${media.length} audio/video to transcribe.`);
  if (media.length) {
    addLog(`Media to transcribe: ${media.slice(0, 25).map((f) => f.name).join(', ')}${media.length > 25 ? `, +${media.length - 25} more` : ''}`);
  } else {
    addLog('No audio/video files detected in this folder.');
  }
  return files;
};

module.exports.isMediaFile = isMediaFile;

async function crawlFolder(folderId, parentPath, files, addLog) {
  const items = await listFilesInFolder(folderId);
  const folderName = await getFolderName(folderId);
  const currentPath = parentPath ? `${parentPath} > ${folderName}` : folderName;

  for (const item of items) {
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      // Don't descend into our own output subfolder (avoids re-listing prior
      // transcript docs on a re-run).
      if (item.name === 'Video/Audio Transcripts') continue;
      await crawlFolder(item.id, currentPath, files, addLog);
    } else {
      const isMedia = isMediaFile(item.mimeType, item.name);
      const isImage = IMAGE_MIME_TYPES.includes(item.mimeType);
      const canExtract = TEXT_MIME_TYPES.includes(item.mimeType) || isImage;
      const size = parseInt(item.size || 0);

      files.push({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size,
        sizeFormatted: formatSize(size),
        parentFolder: folderName,
        path: currentPath,
        url: `https://drive.google.com/file/d/${item.id}/view`,
        isMedia,
        isImage,
        canExtract,
        summary: null,
        keyPeople: null,
        keyDates: null,
        duplicate: null,
        transcriptDocId: null,
        transcriptDocUrl: null,
        transcriptStatus: null,
      });
    }
  }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
