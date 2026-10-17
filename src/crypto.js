'use strict';

const crypto = require('crypto');
const { AES_KEY } = require('./config');

// Mirrors the site's A9(): AES-256-CBC, PKCS7, random 16-byte IV.
// Returns base64 iv + base64 ciphertext, which is the body /downloadData expects.
function encryptDownloadPayload(obj) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(AES_KEY, 'utf8'), iv);
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), encrypted: ciphertext.toString('base64') };
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

module.exports = { encryptDownloadPayload, sha1 };
