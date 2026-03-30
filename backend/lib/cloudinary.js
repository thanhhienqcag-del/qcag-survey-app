// lib/cloudinary.js — Cloudinary upload helper
// Dùng signed upload thông qua Node.js SDK (server-side).
'use strict';

const cloudinary = require('cloudinary').v2;

// Cấu hình từ biến môi trường (không bao giờ hardcode key)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/**
 * Upload một buffer hoặc data URI lên Cloudinary.
 * @param {Buffer|string} source  - Buffer ảnh hoặc data URI base64
 * @param {object} [options]
 * @param {string} [options.folder='qcag']         - Thư mục trên Cloudinary
 * @param {string} [options.publicId]              - Đặt tên tùy chỉnh (tùy chọn)
 * @param {number} [options.maxWidthPx=1920]       - Resize chiều rộng tối đa
 * @returns {Promise<{ url: string; publicId: string; width: number; height: number }>}
 */
async function uploadImage(source, options = {}) {
  const {
    folder      = 'qcag',
    publicId,
    maxWidthPx  = 1920,
  } = options;

  const uploadOptions = {
    folder,
    resource_type: 'image',
    transformation: [
      { width: maxWidthPx, crop: 'limit' }, // giảm size nhưng không crop
      { quality: 'auto:good' },
      { fetch_format: 'auto' },
    ],
    overwrite: false,
  };

  if (publicId) uploadOptions.public_id = publicId;

  try {
    // Nếu source là Buffer, convert sang base64
    const uploadSource =
      Buffer.isBuffer(source)
        ? `data:image/jpeg;base64,${source.toString('base64')}`
        : source;

    const result = await cloudinary.uploader.upload(uploadSource, uploadOptions);

    return {
      url:      result.secure_url,
      publicId: result.public_id,
      width:    result.width,
      height:   result.height,
    };
  } catch (err) {
    console.error('[cloudinary] Upload error:', err.message);
    throw new Error(`Cloudinary upload failed: ${err.message}`);
  }
}

/**
 * Xóa ảnh khỏi Cloudinary theo publicId.
 * @param {string} publicId
 * @returns {Promise<boolean>}
 */
async function deleteImage(publicId) {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result.result === 'ok';
  } catch (err) {
    console.error('[cloudinary] Delete error:', err.message);
    return false;
  }
}

/**
 * Tạo signed upload URL (cho client-side direct upload).
 * @param {object} [params]
 * @param {string} [params.folder='qcag']
 * @returns {{ signature: string; timestamp: number; apiKey: string; cloudName: string; folder: string }}
 */
function generateSignedUploadParams(params = {}) {
  const { folder = 'qcag' } = params;
  const timestamp = Math.round(Date.now() / 1000);
  const toSign = { folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(toSign, process.env.CLOUDINARY_API_SECRET);

  return {
    signature,
    timestamp,
    apiKey:    process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    folder,
  };
}

module.exports = { uploadImage, deleteImage, generateSignedUploadParams };
