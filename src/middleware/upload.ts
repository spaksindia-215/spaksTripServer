import multer from "multer";

// In-memory multipart parsing for partner listing uploads. Files are held in
// RAM only long enough to stream to Cloudinary (see ../lib/cloudinary.ts); no
// local disk is touched. Dynamic field names (e.g. taxi `vehiclePhotos`, doc
// fields, hotel `roomImages-<id>`) are handled by `.any()` at the route.

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "application/pdf",
]);

export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 40 }, // 8 MB/file, 40 files/request
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error("Only image or PDF uploads are allowed"));
  },
});
