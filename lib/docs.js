const { google } = require('googleapis');
const { getAuthClient } = require('./auth');
const { withRetry } = require('./retry');

function getDocs() {
  return google.docs({ version: 'v1', auth: getAuthClient() });
}

function getDrive() {
  return google.drive({ version: 'v3', auth: getAuthClient() });
}

async function createDoc(title, parentFolderId) {
  const docs = getDocs();
  const drive = getDrive();

  const res = await withRetry(() => docs.documents.create({ requestBody: { title } }), 'createDoc');
  const docId = res.data.documentId;

  const file = await withRetry(() => drive.files.get({ fileId: docId, fields: 'parents' }), 'get doc parents');
  const prevParents = file.data.parents.join(',');
  await withRetry(() => drive.files.update({
    fileId: docId,
    addParents: parentFolderId,
    removeParents: prevParents,
    fields: 'id, parents',
    supportsAllDrives: true,
  }), 'move doc to folder');

  return docId;
}

async function getDoc(docId) {
  const docs = getDocs();
  const res = await withRetry(() => docs.documents.get({ documentId: docId }), 'getDoc');
  return res.data;
}

async function getDocContent(docId) {
  const doc = await getDoc(docId);
  let text = '';
  if (doc.body && doc.body.content) {
    for (const elem of doc.body.content) {
      if (elem.paragraph) {
        for (const pe of elem.paragraph.elements || []) {
          if (pe.textRun) text += pe.textRun.content;
        }
      }
    }
  }
  return text;
}

async function getEndIndex(docId) {
  const doc = await getDoc(docId);
  return doc.body.content[doc.body.content.length - 1].endIndex - 1;
}

async function batchUpdate(docId, requests) {
  if (!requests || requests.length === 0) return;
  const docs = getDocs();
  await withRetry(() => docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  }), 'docs batchUpdate');
}

async function clearDoc(docId) {
  const doc = await getDoc(docId);
  const endIdx = doc.body.content[doc.body.content.length - 1].endIndex;
  if (endIdx <= 1) return;
  await batchUpdate(docId, [{
    deleteContentRange: {
      range: { startIndex: 1, endIndex: endIdx - 1 },
    },
  }]);
}

function getDocUrl(docId) {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

module.exports = {
  getDocs,
  createDoc,
  getDoc,
  getDocContent,
  getEndIndex,
  batchUpdate,
  clearDoc,
  getDocUrl,
};
