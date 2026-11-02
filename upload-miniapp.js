const express = require("express");
const router = express.Router();

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const tar = require("tar");
const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024, // Tối đa 100MB
    },
});

const MAX_TAR_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_EXTRACTED_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_FILES = 1000;
const UPLOAD_PROGRESS_TTL = 30 * 60 * 1000;
const uploadProgress = new Map();

const miniappModel = require("./models/Miniapp");

const { v2: cloudinary } = require("cloudinary");

// Khởi tạo Cloudinary ngay trong file riêng
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Tìm tất cả file bên trong thư mục
async function getFilesRecursive(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...(await getFilesRecursive(fullPath)));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files;
}

// Upload một file lên Cloudinary
function updateUploadProgress(uploadId, updates) {
    if (!uploadId) return;

    uploadProgress.set(uploadId, {
        ...uploadProgress.get(uploadId),
        ...updates,
        updatedAt: Date.now(),
    });
}

function removeExpiredUploadProgress() {
    const expiresBefore = Date.now() - UPLOAD_PROGRESS_TTL;

    for (const [uploadId, progress] of uploadProgress) {
        if (progress.updatedAt < expiresBefore) {
            uploadProgress.delete(uploadId);
        }
    }
}

function uploadRawToCloudinary(buffer, publicId, assetFolder, onProgress) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: "raw",
                public_id: publicId,
                asset_folder: assetFolder,
                type: "upload",
                access_mode: "public",
                use_filename: false,
                unique_filename: false,
                overwrite: true,
                invalidate: true,
            },
            (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(result);
            }
        );

        let transferredBytes = 0;
        stream.on("data", (chunk) => {
            transferredBytes = Math.min(
                buffer.length,
                transferredBytes + chunk.length
            );
            onProgress(transferredBytes);
        });

        stream.end(buffer);
    });
}

router.get("/upload-v2/progress/:uploadId", (request, response) => {
    const { uploadId } = request.params;

    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
        return response.status(400).json({ error: "Invalid upload ID" });
    }

    removeExpiredUploadProgress();
    const progress = uploadProgress.get(uploadId);

    if (!progress) {
        return response.status(404).json({ error: "Upload progress not found" });
    }

    return response.status(200).json({
        progress: progress.progress,
        status: progress.status,
    });
});

router.post(
    "/upload-v2",
    (request, response, next) => {
        const uploadId =
            typeof request.query.uploadId === "string"
                ? request.query.uploadId
                : "";

        if (uploadId && !/^[0-9a-f-]{36}$/i.test(uploadId)) {
            return response.status(400).json({ error: "Invalid upload ID" });
        }

        request.uploadId = uploadId;
        if (uploadId) {
            removeExpiredUploadProgress();
            uploadProgress.set(uploadId, {
                progress: 0,
                status: "receiving",
                updatedAt: Date.now(),
            });

            response.on("finish", () => {
                const currentProgress = uploadProgress.get(uploadId);
                if (
                    currentProgress &&
                    !["complete", "failed"].includes(currentProgress.status)
                ) {
                    updateUploadProgress(uploadId, { status: "failed" });
                }
            });
        }

        return next();
    },
    upload.single("bundle"),
    async (request, response) => {
        let tempDir;
        const uploadedAssets = [];

        try {
            // 1. Validate file
            if (!request.file) {
                return response.status(400).json({
                    error: '"bundle" TAR file is required',
                });
            }

            if (request.file.size > MAX_TAR_SIZE) {
                return response.status(400).json({
                    error: "TAR file must not exceed 100 MB",
                });
            }

            const name =
                typeof request.body.name === "string"
                    ? request.body.name.trim()
                    : "";

            const version =
                typeof request.body.version === "string"
                    ? request.body.version.trim()
                    : "";

            if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
                return response.status(400).json({
                    error:
                        '"name" is required and may contain only letters, numbers, underscores, and hyphens',
                });
            }

            if (!/^\d+\.\d+\.\d+$/.test(version)) {
                return response.status(400).json({
                    error: '"version" must use the x.x.x format',
                });
            }

            const extension = path.extname(request.file.originalname).toLowerCase();

            if (extension !== ".tar") {
                return response.status(400).json({
                    error: 'Uploaded file must have ".tar" extension',
                });
            }

            // 2. Validate Cloudinary credentials
            if (
                !process.env.CLOUDINARY_CLOUD_NAME ||
                !process.env.CLOUDINARY_API_KEY ||
                !process.env.CLOUDINARY_API_SECRET
            ) {
                return response.status(500).json({
                    error: "Cloudinary credentials are not configured",
                });
            }

            const folder =
                process.env.CLOUDINARY_FOLDER || "miniapp-bundles";

            const assetFolder = `${folder}/${name}/${version}`;
            const publicIdFolder = `${folder}/${name}/${version}`;
            updateUploadProgress(request.uploadId, { status: "processing" });

            // 3. Tạo thư mục tạm và ghi TAR
            tempDir = await fs.mkdtemp(
                path.join(os.tmpdir(), "miniapp-upload-")
            );

            const tarPath = path.join(tempDir, "bundle.tar");
            const extractDir = path.join(tempDir, "extracted");

            await fs.mkdir(extractDir);

            await fs.writeFile(tarPath, request.file.buffer);

            // 4. Giải nén TAR
            // Chỉ cho phép file và thư mục thông thường, không giải nén symlink/hardlink.
            await tar.x({
                file: tarPath,
                cwd: extractDir,
                strict: true,
                preservePaths: false,
                filter: (filePath, entry) => {
                    return (
                        entry.type === "File" ||
                        entry.type === "Directory"
                    );
                },
            });

            // 5. Kiểm tra các file sau khi giải nén
            const extractedFiles = await getFilesRecursive(extractDir);

            if (extractedFiles.length === 0) {
                return response.status(400).json({
                    error: "TAR archive is empty",
                });
            }

            if (extractedFiles.length > MAX_FILES) {
                return response.status(400).json({
                    error: `TAR archive must not contain more than ${MAX_FILES} files`,
                });
            }

            let totalSize = 0;

            for (const filePath of extractedFiles) {
                const stat = await fs.lstat(filePath);

                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new Error("TAR contains an unsupported file type");
                }

                totalSize += stat.size;
            }

            if (totalSize > MAX_EXTRACTED_SIZE) {
                return response.status(400).json({
                    error: "Extracted files must not exceed 500 MB in total",
                });
            }

            // 6. Tìm mf-manifest.json
            const manifestFiles = extractedFiles.filter(
                (filePath) => path.basename(filePath) === "mf-manifest.json"
            );

            if (manifestFiles.length !== 1) {
                return response.status(400).json({
                    error:
                        "TAR archive must contain exactly one mf-manifest.json",
                });
            }

            const manifestFile = manifestFiles[0];
            const bundleRoot = path.dirname(manifestFile);

            // Kiểm tra manifest là JSON hợp lệ
            let manifest;

            try {
                manifest = JSON.parse(
                    await fs.readFile(manifestFile, "utf8")
                );
            } catch {
                return response.status(400).json({
                    error: "mf-manifest.json is invalid",
                });
            }

            // 7. Chỉ upload các file cùng thư mục gốc với manifest
            // Nếu TAR có thư mục PackageBundle bên ngoài thì bundleRoot sẽ là PackageBundle.
            const bundleFiles = await getFilesRecursive(bundleRoot);

            if (!bundleFiles.includes(manifestFile)) {
                throw new Error("Manifest is not inside bundle root");
            }

            const uploadTotalSize = (
                await Promise.all(
                    bundleFiles.map(async (filePath) => {
                        const stat = await fs.lstat(filePath);
                        return stat.size;
                    })
                )
            ).reduce((total, size) => total + size, 0);

            // Upload manifest trước để lấy CDN base URL
            bundleFiles.sort((a, b) => {
                if (a === manifestFile) return -1;
                if (b === manifestFile) return 1;
                return a.localeCompare(b);
            });

            let cdnPath = null;
            let manifestUrl = null;
            let uploadedBytes = 0;
            updateUploadProgress(request.uploadId, {
                progress: 0,
                status: "uploading",
            });

            // 8. Upload từng file lên Cloudinary
            for (const filePath of bundleFiles) {
                const relativePath = path
                    .relative(bundleRoot, filePath)
                    .split(path.sep)
                    .join("/");

                // Không cho phép đường dẫn thoát khỏi thư mục bundle
                if (
                    !relativePath ||
                    relativePath.startsWith("../") ||
                    path.posix.isAbsolute(relativePath)
                ) {
                    throw new Error(`Invalid bundle file path: ${relativePath}`);
                }

                const fileBuffer = await fs.readFile(filePath);

                // public_id phải giữ nguyên cấu trúc đường dẫn và phần mở rộng.
                const publicId = `${publicIdFolder}/${relativePath}`;

                const result = await uploadRawToCloudinary(
                    fileBuffer,
                    publicId,
                    assetFolder,
                    (fileBytesSent) => {
                        const progress =
                            uploadTotalSize === 0
                                ? 0
                                : Math.min(
                                      99,
                                      Math.floor(
                                          ((uploadedBytes + fileBytesSent) /
                                              uploadTotalSize) *
                                              100
                                      )
                                  );

                        updateUploadProgress(request.uploadId, {
                            progress,
                            status: "uploading",
                        });
                    }
                );
                uploadedBytes += fileBuffer.length;

                uploadedAssets.push({
                    publicId: result.public_id,
                    resourceType: "raw",
                });

                if (relativePath === "mf-manifest.json") {
                    // Bỏ version number của Cloudinary khỏi URL để mọi asset
                    // có thể được resolve từ cùng một CDN base.
                    manifestUrl = result.secure_url.replace(
                        /\/v\d+\//,
                        "/"
                    );

                    cdnPath = manifestUrl.replace(
                        /\/mf-manifest\.json$/,
                        ""
                    );
                }
            }

            if (!cdnPath || !manifestUrl) {
                throw new Error("Failed to determine CDN path");
            }

            // 9. Lưu metadata vào MongoDB
            updateUploadProgress(request.uploadId, { status: "saving" });
            const uploadedAt = new Date();

            const newVersion = {
                version,
                cdnPath,
                manifestUrl,
                createAt: uploadedAt,
                isActive: true,
            };

            const currentVersions = {
                $ifNull: ["$data", []],
            };

            const versionExists = {
                $in: [
                    { $literal: version },
                    {
                        $map: {
                            input: currentVersions,
                            as: "item",
                            in: "$$item.version",
                        },
                    },
                ],
            };

            const updatedVersions = {
                $map: {
                    input: currentVersions,
                    as: "item",
                    in: {
                        $mergeObjects: [
                            "$$item",
                            {
                                isActive: {
                                    $eq: [
                                        "$$item.version",
                                        { $literal: version },
                                    ],
                                },
                            },
                            {
                                $cond: [
                                    {
                                        $eq: [
                                            "$$item.version",
                                            { $literal: version },
                                        ],
                                    },
                                    {
                                        $literal: {
                                            cdnPath,
                                            manifestUrl,
                                            createAt: uploadedAt,
                                        },
                                    },
                                    {},
                                ],
                            },
                        ],
                    },
                },
            };

            await miniappModel.updateOne(
                { name },
                [
                    {
                        $set: {
                            name: { $literal: name },
                            createAt: {
                                $ifNull: [
                                    "$createAt",
                                    { $literal: uploadedAt },
                                ],
                            },
                            latestVersion: { $literal: version },
                            data: {
                                $let: {
                                    vars: {
                                        versions: currentVersions,
                                    },
                                    in: {
                                        $cond: [
                                            versionExists,
                                            updatedVersions,
                                            {
                                                $concatArrays: [
                                                    updatedVersions,
                                                    [{ $literal: newVersion }],
                                                ],
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    },
                ],
                { upsert: true }
            );

            updateUploadProgress(request.uploadId, {
                progress: 100,
                status: "complete",
            });

            // 10. Trả kết quả
            return response.status(201).json({
                message: "Mini App bundle uploaded successfully",
                progress: 100,
                status: "complete",
                object: {
                    name,
                    version,
                    cdnPath,
                    manifestUrl,
                    isActive: true,
                    uploadedAt,
                    fileCount: bundleFiles.length,
                    totalSize,
                },
            });
        } catch (error) {
            console.error("Failed to upload Mini App v2:", error);
            updateUploadProgress(request.uploadId, { status: "failed" });

            // Nếu upload thất bại giữa chừng, xóa những asset đã upload
            await Promise.allSettled(
                uploadedAssets.map((asset) =>
                    cloudinary.uploader.destroy(asset.publicId, {
                        resource_type: asset.resourceType,
                        type: "upload",
                        invalidate: true,
                    })
                )
            );

            return response.status(500).json({
                error: "Failed to upload Mini App bundle",
                detail:
                    process.env.NODE_ENV === "development"
                        ? error.message
                        : undefined,
            });
        } finally {
            // Xóa thư mục tạm sau khi xử lý
            if (tempDir) {
                await fs.rm(tempDir, {
                    recursive: true,
                    force: true,
                });
            }
        }
    }
);

module.exports = router;