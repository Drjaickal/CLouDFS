
import express, { type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT) || 4001;
const NODE_ID = process.env.NODE_ID || "storage-node-1";

const STORAGE_DIR = path.resolve("data", NODE_ID);
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

app.use(express.json());

/**
 * Validate file IDs to prevent path traversal.
 */
function isValidFileId(fileId: string): boolean {
    return /^[a-zA-Z0-9_-]{1,100}$/.test(fileId);
}

/**
 * Initialize storage directory.
 */
async function initializeStorage(): Promise<void> {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
}

/**
 * Generate SHA-256 hash using a readable stream.
 */
async function getFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);

        stream.on("data", (chunk: Buffer) => {
            hash.update(chunk);
        });

        stream.on("error", reject);

        stream.on("end", () => {
            resolve(hash.digest("hex"));
        });
    });
}

/**
 * Safely identify filesystem errors.
 */
function isNotFoundError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
    );
}

/**
 * Health check.
 */
app.get("/health", (_req: Request, res: Response) => {
    return res.status(200).json({
        success: true,
        nodeId: NODE_ID,
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

/**
 * Upload a file using raw binary data.
 */
app.put(
    "/files/:fileId",
    express.raw({
        type: "application/octet-stream",
        limit: MAX_FILE_SIZE,
    }),
    async (req: Request, res: Response) => {
        let tempPath: string | undefined;

        try {
            const fileId = String(req.params.fileId ?? "");

            if (!isValidFileId(fileId)) {
                return res.status(400).json({
                    success: false,
                    error: "Invalid file ID",
                });
            }

            if (!Buffer.isBuffer(req.body)) {
                return res.status(415).json({
                    success: false,
                    error: "Use application/octet-stream",
                });
            }

            const fileBuffer: Buffer = req.body;
            const filePath = path.join(STORAGE_DIR, fileId);

            tempPath = `${filePath}.${randomUUID()}.tmp`;

            // Generate checksum before writing.
            const sha256 = createHash("sha256")
                .update(fileBuffer)
                .digest("hex");

            // Write to a temporary file first.
            await fs.writeFile(tempPath, fileBuffer, {
                flag: "wx",
            });

            // Replace the destination file.
            await fs.rename(tempPath, filePath);

            tempPath = undefined;

            return res.status(201).json({
                success: true,
                message: "File stored successfully",
                fileId,
                nodeId: NODE_ID,
                size: fileBuffer.length,
                sha256,
                timestamp: new Date().toISOString(),
            });
        } catch (error: unknown) {
            // Remove incomplete temporary files.
            if (tempPath) {
                await fs.rm(tempPath, { force: true }).catch(() => { });
            }

            console.error("Upload error:", error);

            return res.status(500).json({
                success: false,
                error: "Unable to store file",
            });
        }
    }
);

/**
 * Download a stored file.
 */
app.get("/files/:fileId", async (req: Request, res: Response) => {
    try {
        const fileId = String(req.params.fileId ?? "");

        if (!isValidFileId(fileId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid file ID",
            });
        }

        const filePath = path.join(STORAGE_DIR, fileId);
        const stats = await fs.stat(filePath);

        if (!stats.isFile()) {
            return res.status(404).json({
                success: false,
                error: "File not found",
            });
        }

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", stats.size);

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileId}.bin"`
        );

        const stream = createReadStream(filePath);

        stream.on("error", (error: Error) => {
            console.error("Download stream error:", error);

            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.destroy(error);
            }
        });

        stream.pipe(res);
    } catch (error: unknown) {
        if (isNotFoundError(error)) {
            return res.status(404).json({
                success: false,
                error: "File not found",
            });
        }

        console.error("Download error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to retrieve file",
        });
    }
});

/**
 * List all files stored on this storage node.
 * Includes file size and SHA-256 checksum.
 */
app.get("/files", async (_req: Request, res: Response) => {
    try {
        const entries = await fs.readdir(STORAGE_DIR, {
            withFileTypes: true,
        });

        const files = await Promise.all(
            entries
                .filter(
                    (entry) =>
                        entry.isFile() && isValidFileId(entry.name)
                )
                .map(async (entry) => {
                    const filePath = path.join(STORAGE_DIR, entry.name);

                    try {
                        const stats = await fs.stat(filePath);
                        const sha256 = await getFileHash(filePath);

                        return {
                            fileId: entry.name,
                            size: stats.size,
                            sha256,
                            status: "available",
                        };
                    } catch (error: unknown) {
                        console.error(
                            `Failed to inspect ${entry.name}:`,
                            error
                        );

                        return {
                            fileId: entry.name,
                            size: null,
                            sha256: null,
                            status: "unavailable",
                        };
                    }
                })
        );

        return res.status(200).json({
            success: true,
            nodeId: NODE_ID,
            totalFiles: files.length,
            files,
            timestamp: new Date().toISOString(),
        });
    } catch (error: unknown) {
        console.error("File inventory error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to retrieve file inventory",
        });
    }
});

/**
 * Delete a stored file.
 */
app.delete("/files/:fileId", async (req: Request, res: Response) => {
    try {
        const fileId = String(req.params.fileId ?? "");

        if (!isValidFileId(fileId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid file ID",
            });
        }

        const filePath = path.join(STORAGE_DIR, fileId);

        await fs.unlink(filePath);

        return res.status(200).json({
            success: true,
            message: "File deleted successfully",
            fileId,
            nodeId: NODE_ID,
            timestamp: new Date().toISOString(),
        });
    } catch (error: unknown) {
        if (isNotFoundError(error)) {
            return res.status(404).json({
                success: false,
                error: "File not found",
            });
        }

        console.error("Delete error:", error);

        return res.status(500).json({
            success: false,
            error: "Unable to delete file",
        });
    }
});

/**
 * Start storage node.
 */
async function startServer(): Promise<void> {
    await initializeStorage();

    const server = app.listen(PORT, "0.0.0.0", () => {
        console.log("--------------------------------");
        console.log(`CloudFS Storage Node: ${NODE_ID}`);
        console.log(`Running on port: ${PORT}`);
        console.log(`Storage directory: ${STORAGE_DIR}`);
        console.log("--------------------------------");
    });

    /**
     * Graceful shutdown.
     */
    const shutdown = (signal: string) => {
        console.log(`\n${signal} received. Shutting down ${NODE_ID}...`);

        server.close((error) => {
            if (error) {
                console.error("Shutdown error:", error);
                process.exitCode = 1;
                return;
            }

            console.log(`${NODE_ID} stopped successfully.`);
        });
    };

    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error: unknown) => {
    console.error("Failed to start storage node:", error);
    process.exitCode = 1;
});
