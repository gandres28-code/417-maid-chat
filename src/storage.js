const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

function storageConfigured() {
  return Boolean(
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );
}

function getClient() {
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
}

async function createPresignedUpload({ userId, fileName, mimeType }) {
  if (!storageConfigured()) {
    const error = new Error('Storage no configurado');
    error.status = 503;
    throw error;
  }

  const safeName = String(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectKey = `${userId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;

  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: objectKey,
    ContentType: mimeType || 'application/octet-stream',
  });

  const uploadUrl = await getSignedUrl(getClient(), command, { expiresIn: 900 });
  const base = String(process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');

  return {
    objectKey,
    uploadUrl,
    publicUrl: base ? `${base}/${objectKey}` : '',
  };
}

module.exports = { createPresignedUpload, storageConfigured };
