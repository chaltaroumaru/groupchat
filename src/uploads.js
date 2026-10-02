'use strict';

const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const { HttpError, now, randomToken } = require('./util');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

// SVG はスクリプトを含められるため許可しない
const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** ファイル先頭のマジックナンバーで画像形式を確認する */
function sniffImageType(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  try {
    fs.readSync(fd, buf, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function createUploader(uploadDir) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => cb(null, randomToken(18) + (ALLOWED[file.mimetype] || '')),
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED[file.mimetype]) return cb(new HttpError(400, '添付できるのは JPEG / PNG / GIF / WebP 画像のみです'));
      cb(null, true);
    },
  });

  const images = upload.array('images', MAX_FILES);

  /** multipart の images フィールドを受け取り、中身を検証するミドルウェア */
  function imagesMiddleware(req, res, next) {
    images(req, res, (err) => {
      if (err) {
        cleanup(req.files);
        if (err instanceof multer.MulterError) {
          const msg =
            err.code === 'LIMIT_FILE_SIZE'
              ? `画像は1枚あたり${MAX_FILE_SIZE / 1024 / 1024}MBまでです`
              : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
                ? `画像は一度に${MAX_FILES}枚まで添付できます`
                : 'ファイルのアップロードに失敗しました';
          return next(new HttpError(400, msg));
        }
        return next(err);
      }
      for (const f of req.files || []) {
        if (sniffImageType(f.path) !== f.mimetype) {
          cleanup(req.files);
          return next(new HttpError(400, '画像ファイルの形式が正しくありません'));
        }
      }
      next();
    });
  }

  function cleanup(files) {
    for (const f of files || []) fs.rm(f.path, { force: true }, () => {});
  }

  function saveAttachments(db, files, { messageId = null, announcementId = null }) {
    const stmt = db.prepare(
      `INSERT INTO attachments (message_id, announcement_id, stored_name, original_name, mime_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of files || []) {
      // multer は latin1 としてファイル名を解釈するため UTF-8 に戻す
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8').slice(0, 255);
      stmt.run(messageId, announcementId, path.basename(f.path), original, f.mimetype, f.size, now());
    }
  }

  function removeStored(storedNames) {
    for (const name of storedNames) fs.rm(path.join(uploadDir, path.basename(name)), { force: true }, () => {});
  }

  return { imagesMiddleware, cleanup, saveAttachments, removeStored, uploadDir };
}

module.exports = { createUploader, MAX_FILE_SIZE, MAX_FILES };
