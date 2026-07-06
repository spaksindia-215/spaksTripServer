import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";
import { HttpError } from "../middleware/error";

// Cloudinary is the single image/document store for partner listings. Configured
// once from env; uploads stream the in-memory multer buffer straight to
// Cloudinary and return the secure URL persisted on the model.

let configured = false;

function ensureConfigured(): void {
  if (configured) return;

  if (env.cloudinaryUrl) {
    // The SDK reads CLOUDINARY_URL from the environment automatically.
    cloudinary.config({ secure: true });
  } else if (env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret) {
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true,
    });
  } else {
    throw new HttpError(
      500,
      "Image upload is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET.",
    );
  }
  configured = true;
}

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

// Uploads one in-memory file to Cloudinary under `folder`. Images use the
// `image` resource type; everything else (PDFs, etc.) uses `raw`.
export async function uploadToCloudinary(file: UploadedFile, folder: string): Promise<string> {
  ensureConfigured();

  const resourceType = file.mimetype.startsWith("image/") ? "image" : "raw";

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (error, result) => {
        if (error || !result) {
          reject(new HttpError(502, `Cloudinary upload failed: ${error?.message ?? "unknown error"}`));
          return;
        }
        resolve(result.secure_url);
      },
    );
    stream.end(file.buffer);
  });
}

// Uploads many files in parallel, preserving order.
export function uploadManyToCloudinary(files: UploadedFile[], folder: string): Promise<string[]> {
  return Promise.all(files.map((f) => uploadToCloudinary(f, folder)));
}
