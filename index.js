require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const mongoose = require("mongoose");
const { extname } = require("node:path");
require("./models/Miniapp");

const port = 3001;
const miniappModel = mongoose.model("Miniapp");
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function connect() {
  const { MONGO_USERNAME, MONGO_PASSWORD } = process.env;
  if (!MONGO_USERNAME || !MONGO_PASSWORD) {
    throw new Error("MONGO_USERNAME and MONGO_PASSWORD must be set in the environment");
  }

  const mongoUrl =
    `mongodb+srv://${encodeURIComponent(MONGO_USERNAME)}:${encodeURIComponent(MONGO_PASSWORD)}` +
    "@cluster0.pc9zh5i.mongodb.net/MiniAppShowcase";

  await mongoose.connect(mongoUrl);
  console.log("Ket noi database thanh cong");
}

app.get("/api/miniapp", async (request, response) => {
  try {
    const miniapps = await miniappModel.aggregate([
      {
        $set: {
          data: {
            $let: {
              vars: {
                versions: { $ifNull: ["$data", []] },
              },
              in: {
                $concatArrays: [
                  {
                    $filter: {
                      input: "$$versions",
                      as: "item",
                      cond: {
                        $and: [
                          { $ne: ["$latestVersion", null] },
                          { $eq: ["$$item.version", "$latestVersion"] },
                        ],
                      },
                    },
                  },
                  {
                    $sortArray: {
                      input: {
                        $filter: {
                          input: "$$versions",
                          as: "item",
                          cond: {
                            $ne: ["$$item.version", "$latestVersion"],
                          },
                        },
                      },
                      sortBy: { createAt: -1 },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        $addFields: {
          _latestVersionParts: {
            $split: [{ $ifNull: ["$latestVersion", "0.0.0"] }, "."],
          },
        },
      },
      {
        $addFields: {
          _latestVersionMajor: {
            $convert: {
              input: { $arrayElemAt: ["$_latestVersionParts", 0] },
              to: "int",
              onError: 0,
              onNull: 0,
            },
          },
          _latestVersionMinor: {
            $convert: {
              input: { $arrayElemAt: ["$_latestVersionParts", 1] },
              to: "int",
              onError: 0,
              onNull: 0,
            },
          },
          _latestVersionPatch: {
            $convert: {
              input: { $arrayElemAt: ["$_latestVersionParts", 2] },
              to: "int",
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      {
        $sort: {
          _latestVersionMajor: -1,
          _latestVersionMinor: -1,
          _latestVersionPatch: -1,
          createAt: -1,
          name: 1,
        },
      },
      {
        $project: {
          _latestVersionParts: 0,
          _latestVersionMajor: 0,
          _latestVersionMinor: 0,
          _latestVersionPatch: 0,
        },
      },
    ]);
    response.status(200).json(miniapps);
  } catch (error) {
    console.error("Failed to get miniapps:", error);
    response.status(500).json({ error: "Failed to get miniapps" });
  }
});


app.post("/api/miniapp/activate", async (request, response) => {
  const { name, version, isActive } = request.body || {};

  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(name.trim()) ||
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(version.trim()) ||
    typeof isActive !== "boolean"
  ) {
    return response.status(400).json({
      error: '"name", "version", and boolean "isActive" are required',
    });
  }

  const miniappName = name.trim();
  const miniappVersion = version.trim();

  try {
    // Tìm Mini App và tất cả các version
    const miniapp = await miniappModel.findOne({
      name: miniappName,
      "data.version": miniappVersion,
    });

    if (!miniapp) {
      return response.status(404).json({
        error: "Miniapp or version not found",
      });
    }

    let targetVersion = miniappVersion;

    if (!isActive) {
      // Tìm các version khác với version đang bị tắt
      const otherVersions = miniapp.data.filter(
        (item) => item.version !== miniappVersion
      );

      if (otherVersions.length > 0) {
        // So sánh version theo từng phần: major, minor, patch
        const compareVersions = (a, b) => {
          const partsA = a.split(".").map(Number);
          const partsB = b.split(".").map(Number);

          for (let i = 0; i < 3; i++) {
            if (partsA[i] !== partsB[i]) {
              return partsA[i] - partsB[i];
            }
          }

          return 0;
        };

        // Chọn version cao nhất trong các version còn lại
        otherVersions.sort((a, b) =>
          compareVersions(b.version, a.version)
        );

        targetVersion = otherVersions[0].version;
      }
    }

    // Cập nhật trạng thái tất cả version trong một thao tác
    const result = await miniappModel.updateOne(
      {
        _id: miniapp._id,
        "data.version": miniappVersion,
      },
      [
        {
          $set: {
            latestVersion: {
              $literal:
                isActive || targetVersion !== miniappVersion
                  ? targetVersion
                  : null,
            },
            data: {
              $map: {
                input: "$data",
                as: "item",
                in: {
                  $mergeObjects: [
                    "$$item",
                    {
                      isActive: {
                        $eq: [
                          "$$item.version",
                          { $literal: isActive ? miniappVersion : targetVersion },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ]
    );

    if (result.matchedCount === 0) {
      return response.status(404).json({
        error: "Miniapp or version not found",
      });
    }

    return response.status(200).json({
      message: isActive
        ? "Miniapp version activated"
        : targetVersion !== miniappVersion
          ? "Miniapp version deactivated and previous version activated"
          : "Miniapp version deactivated; no other version available",
      name: miniappName,
      version: miniappVersion,
      isActive,
      activeVersion: isActive || targetVersion !== miniappVersion
        ? targetVersion
        : null,
    });
  } catch (error) {
    console.error("Failed to update miniapp version status:", error);

    return response.status(500).json({
      error: "Failed to update miniapp version status",
    });
  }
});


app.post("/api/miniapp/get-latest", async (request, response) => {
  const appName =
    typeof request.body.appName === "string"
      ? request.body.appName.trim()
      : "";

  if (!appName) {
    return response.status(400).json({
      error: '"appName" is required',
    });
  }

  try {
    const [latestVersion] = await miniappModel.aggregate([
      {
        $match: {
          name: appName,
        },
      },
      {
        $unwind: "$data",
      },
      {
        $match: {
          "data.isActive": true,
        },
      },
      {
        $sort: {
          "data.createAt": -1,
        },
      },
      {
        $limit: 1,
      },
      {
        $project: {
          _id: 0,
          name: 1,
          version: "$data.version",
          cdnPath: "$data.cdnPath",
          manifestUrl: "$data.manifestUrl",
          bundleUrl: "$data.bundleUrl",
          createAt: "$data.createAt",
          isActive: "$data.isActive",
        },
      },
    ]);

    if (!latestVersion) {
      return response.status(404).json({
        error: "Miniapp or active version not found",
      });
    }

    return response.status(200).json({
      object: latestVersion,
    });

  } catch (error) {
    console.error("Failed to get latest miniapp version:", error);

    return response.status(500).json({
      error: "Failed to get latest miniapp version",
    });
  }
});

app.post(
  "/api/miniapp/upload",
  upload.single("bundle"),
  async (request, response) => {
    if (!request.file) {
      response.status(400).json({
        error: '"bundle" file is required',
      });
      return;
    }

    const name =
      typeof request.body.name === "string"
        ? request.body.name.trim()
        : "";

    const version =
      typeof request.body.version === "string"
        ? request.body.version.trim()
        : "";

    const extension = extname(request.file.originalname);

    // Validate Mini App name
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      response.status(400).json({
        error:
          '"name" is required and may contain only letters, numbers, underscores, and hyphens',
      });
      return;
    }

    // Validate version: x.x.x
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      response.status(400).json({
        error: '"version" is required and must use the x.x.x format',
      });
      return;
    }

    // Validate file extension
    if (!/^\.[A-Za-z0-9]+$/.test(extension)) {
      response.status(400).json({
        error: "Uploaded file must have a valid file extension",
      });
      return;
    }

    // Validate Cloudinary credentials
    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      response.status(500).json({
        error: "Cloudinary credentials are not configured",
      });
      return;
    }

    const folder =
      process.env.CLOUDINARY_FOLDER || "miniapp-bundles";

    // Folder lưu trữ trên Cloudinary
    const assetFolder = `${folder}/${name}`;

    // Tên asset, không chứa đường dẫn folder
    const publicId = `${name}-${version}${extension}`;

    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            asset_folder: `${folder}/${name}`,
            public_id: `${name}-${version}${extension}`,
            type: "upload",
            access_mode: "public",
            use_filename: false,
            unique_filename: false,
            overwrite: true,
          },
          (error, uploadResult) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(uploadResult);
          }
        );

        uploadStream.end(request.file.buffer);
      });

      const uploadedAt = new Date();
      const versions = { $ifNull: ["$data", []] };
      const versionExists = {
        $in: [
          { $literal: version },
          { $map: { input: versions, as: "item", in: "$$item.version" } },
        ],
      };
      const updatedVersions = {
        $map: {
          input: "$$versions",
          as: "item",
          in: {
            $mergeObjects: [
              "$$item",
              { isActive: false },
              {
                $cond: [
                  { $eq: ["$$item.version", { $literal: version }] },
                  {
                    bundleUrl: { $literal: result.secure_url },
                    createAt: { $literal: uploadedAt },
                    isActive: true,
                  },
                  {},
                ],
              },
            ],
          },
        },
      };

      try {
        await miniappModel.updateOne(
          { name },
          [
            {
              $set: {
                name: { $literal: name },
                createAt: { $ifNull: ["$createAt", { $literal: uploadedAt }] },
                data: {
                  $let: {
                    vars: { versions },
                    in: {
                      $cond: [
                        versionExists,
                        updatedVersions,
                        {
                          $concatArrays: [
                            updatedVersions,
                            [
                              {
                                $literal: {
                                  version,
                                  bundleUrl: result.secure_url,
                                  createAt: uploadedAt,
                                  isActive: true,
                                },
                              },
                            ],
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
      } catch (error) {
        console.error("Bundle uploaded but failed to update miniapp in MongoDB:", error);
        response.status(500).json({
          error: "Bundle uploaded to Cloudinary but failed to update miniapp in MongoDB",
          bundleUrl: result.secure_url,
        });
        return;
      }

      response.status(201).json({
        message: "Mini App bundle uploaded successfully",
        name,
        version,
        bundleUrl: result.secure_url,
        isActive: true,
        publicId: result.public_id,
        assetFolder: result.asset_folder,
        format: result.format,
      });
    } catch (error) {
      console.error(
        "Failed to upload bundle to Cloudinary:",
        error
      );

      response.status(502).json({
        error: "Failed to upload bundle to Cloudinary",
      });
    }
  }
);

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError) {
    const statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    response.status(statusCode).json({ error: error.message });
    return;
  }

  console.error("Request failed:", error);
  response.status(500).json({ error: "Internal server error" });
});

async function start() {
  try {
    await connect();
    app.listen(port, "0.0.0.0", () => {
      console.log(`Miniapp API is listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Ket noi database that bai:", error.message);
    process.exitCode = 1;
  }
}

const uploadMiniAppRouter = require("./upload-miniapp");
app.use("/api/miniapp", uploadMiniAppRouter);

start();
