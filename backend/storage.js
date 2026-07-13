const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

async function uploadBuffer(buffer, filename, mimetype) {
    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) {
        const err = new Error('GCS_BUCKET is not set');
        err.code = 'GCS_BUCKET_MISSING';
        throw err;
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filename);
    try {
        // Do not attempt to set legacy ACLs (public: true) because
        // buckets with Uniform Bucket-Level Access reject legacy ACL operations.
        await file.save(buffer, { contentType: mimetype });
    } catch (err) {
        // Re-throw with more context for the caller to handle/log
        err.message = `GCS_UPLOAD_FAILED: ${err.message}`;
        throw err;
    }

    return `https://storage.googleapis.com/${bucket.name}/${filename}`;
}

module.exports = { uploadBuffer };