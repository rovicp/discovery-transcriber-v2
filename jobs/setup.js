// Minimal setup: resolve the pasted folder's name and create (or reuse) a
// "Video/Audio Transcripts" subfolder INSIDE that same folder. All transcript
// Google Docs are written there.
const { getFolderName, findFolderByName, createFolder, getFileUrl } = require('../lib/drive');

const TRANSCRIPTS_SUBFOLDER = 'Video/Audio Transcripts';

module.exports = async function setup(job, addLog) {
  const folderId = job.folderId;

  job.folderName = await getFolderName(folderId);
  addLog(`Folder: ${job.folderName}`);

  let sub = await findFolderByName(folderId, TRANSCRIPTS_SUBFOLDER);
  if (!sub) {
    sub = await createFolder(TRANSCRIPTS_SUBFOLDER, folderId);
    addLog(`Created subfolder: ${TRANSCRIPTS_SUBFOLDER}`);
  } else {
    addLog(`Using existing subfolder: ${TRANSCRIPTS_SUBFOLDER}`);
  }
  job.transcriptsFolderId = sub.id;
  job.transcriptsFolderUrl = getFileUrl(sub.id);
};

module.exports.TRANSCRIPTS_SUBFOLDER = TRANSCRIPTS_SUBFOLDER;
