
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { performance } from "node:perf_hooks";
import { setInterval } from "node:timers";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

interface StorageNode {
    id: string;
    url: string;
}

interface InventoryFile {
    fileId: string;
    size: number | null;
    sha256: string | null;
    status: string;
}

interface StorageNodeInventoryResponse {
    success: boolean;
    nodeId: string;
    totalFiles: number;
    files: InventoryFile[];
}

interface NodeInventoryResult {
    nodeId: string;
    reachable: boolean;
    files: InventoryFile[];
    error?: string;
}


const storageNodes: StorageNode[] = [
    {
        id: "storage-node-1",
        url: process.env.STORAGE_NODE_1_URL || "http://localhost:4001",
    },
    {
        id: "storage-node-2",
        url: process.env.STORAGE_NODE_2_URL || "http://localhost:4002",
    },
    {
        id: "storage-node-3",
        url: process.env.STORAGE_NODE_3_URL || "http://localhost:4003",
    },
];

app.get("/", (_req, res) => {
    res.json({
        name: "CloudFS",
        service: "API Coordinator",
        version: "1.0.0",
        status: "running",
    });
});

app.get("/api/v1/health", (_req, res) => {
    res.status(200).json({
        success: true,
        service: "api-coordinator",
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

// Discover and monitor registered storage nodes
app.get("/api/v1/nodes", async (_req, res) => {
    const results = await Promise.all(
        storageNodes.map(async (node) => {
            const startTime = performance.now();

            try {
                const response = await fetch(`${node.url}/health`, {
                    signal: AbortSignal.timeout(2000),
                });

                return {
                    nodeId: node.id,
                    url: node.url,
                    status: response.ok ? "online" : "unhealthy",
                    httpStatus: response.status,
                    responseTimeMs: Math.round(
                        performance.now() - startTime
                    ),
                };
            } catch {
                return {
                    nodeId: node.id,
                    url: node.url,
                    status: "offline",
                    httpStatus: null,
                    responseTimeMs: Math.round(
                        performance.now() - startTime
                    ),
                };
            }
        })
    );

    const onlineNodes = results.filter(
        (node) => node.status === "online"
    ).length;

    res.status(200).json({
        success: true,
        totalNodes: results.length,
        onlineNodes,
        offlineNodes: results.length - onlineNodes,
        nodes: results,
        checkedAt: new Date().toISOString(),
    });
});
app.get("/api/v1/files/integrity", async (req, res) => {
    try {
        // Step 1: Get file inventory from all storage nodes
        const nodeResults = await Promise.all(
            storageNodes.map(async (node) => {
                try {
                    const response = await fetch(`${node.url}/files`, {
                        signal: AbortSignal.timeout(5000),
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data =
                        (await response.json()) as StorageNodeInventoryResponse;

                    return {
                        nodeId: node.id,
                        reachable: true,
                        files: data.files,
                    };
                } catch (error) {
                    return {
                        nodeId: node.id,
                        reachable: false,
                        files: [],
                        error:
                            error instanceof Error ? error.message : "Unknown error",
                    };
                }
            })
        );

        // Step 2: Store each node's file inventory
        const nodeFileMaps = new Map(
            nodeResults.map((node) => [
                node.nodeId,
                new Map(node.files.map((file) => [file.fileId, file])),
            ])
        );

        // Step 3: Collect all unique file IDs
        const allFileIds = new Set(
            nodeResults.flatMap((node) => node.files.map((file) => file.fileId))
        );

        // Step 4: Compare replicas
        const fileReports = Array.from(allFileIds).map((fileId) => {
            const replicas = storageNodes.map((node) => {
                const nodeResult = nodeResults.find(
                    (result) => result.nodeId === node.id
                );

                const file = nodeFileMaps.get(node.id)?.get(fileId);

                if (!nodeResult?.reachable) {
                    return {
                        nodeId: node.id,
                        status: "node_unavailable",
                        sha256: null,
                    };
                }

                if (!file) {
                    return {
                        nodeId: node.id,
                        status: "missing",
                        sha256: null,
                    };
                }

                return {
                    nodeId: node.id,
                    status: "available",
                    sha256: file.sha256,
                };
            });

            const availableHashes = new Set(
                replicas
                    .filter((replica) => replica.status === "available")
                    .map((replica) => replica.sha256)
            );

            let status = "healthy";

            if (replicas.some((replica) => replica.status === "node_unavailable")) {
                status = "node_unavailable";
            } else if (replicas.some((replica) => replica.status === "missing")) {
                status = "missing_replica";
            } else if (availableHashes.has(null)) {
                status = "hash_unavailable";
            } else if (availableHashes.size > 1) {
                status = "hash_mismatch";
            }

            return {
                fileId,
                status,
                replicas,
            };
        });

        // Step 5: Create summary
        const onlineNodes = nodeResults.filter((node) => node.reachable).length;

        const summary = {
            totalNodes: storageNodes.length,
            onlineNodes,
            offlineNodes: storageNodes.length - onlineNodes,
            totalFiles: fileReports.length,
            healthyFiles: fileReports.filter((file) => file.status === "healthy").length,
            corruptedFiles: fileReports.filter((file) => file.status === "hash_mismatch").length,
            missingReplicaFiles: fileReports.filter(
                (file) => file.status === "missing_replica"
            ).length,
            unavailableFiles: fileReports.filter(
                (file) =>
                    file.status === "node_unavailable" ||
                    file.status === "hash_unavailable"
            ).length,
            integrityStatus:
                fileReports.every((file) => file.status === "healthy") &&
                    onlineNodes === storageNodes.length
                    ? "healthy"
                    : "attention_required",
        };

        // Step 6: Send final response
        res.json({
            success: true,
            service: "cloudfs-integrity-monitor",
            summary,
            nodes: nodeResults,
            files: fileReports,
            checkedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Integrity check failed:", error);

        res.status(500).json({
            success: false,
            message: "Failed to check file integrity",
        });
    }
});


app.post("/api/v1/files/:fileId/repair", async (req, res) => {
    const { fileId } = req.params;

    try {
        // Step 1: Get inventories from all storage nodes.
        const nodeResults: NodeInventoryResult[] = await Promise.all(
            storageNodes.map(async (node) => {
                try {
                    const response = await fetch(`${node.url}/files`, {
                        signal: AbortSignal.timeout(5000),
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const data =
                        (await response.json()) as StorageNodeInventoryResponse;

                    return {
                        nodeId: node.id,
                        reachable: true,
                        files: data.files,
                    };
                } catch (error) {
                    return {
                        nodeId: node.id,
                        reachable: false,
                        files: [],
                        error:
                            error instanceof Error
                                ? error.message
                                : "Unknown error",
                    };
                }
            })
        );

        // Step 2: Collect available copies with valid SHA-256 hashes.
        const sourceCopies = nodeResults.flatMap((node) => {
            if (!node.reachable) return [];

            return node.files
                .filter((file) => file.fileId === fileId && file.sha256)
                .map((file) => ({
                    nodeId: node.nodeId,
                    sha256: file.sha256!,
                }));
        });

        if (sourceCopies.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No valid source copy found for this file.",
                fileId,
            });
        }

        // Step 3: Establish a strict majority quorum.
        // For 3 configured nodes, at least 2 must agree.
        const requiredQuorum = Math.floor(storageNodes.length / 2) + 1;

        const hashCounts = new Map<string, number>();

        for (const copy of sourceCopies) {
            hashCounts.set(
                copy.sha256,
                (hashCounts.get(copy.sha256) ?? 0) + 1
            );
        }

        const majorityEntry = [...hashCounts.entries()].find(
            ([, count]) => count >= requiredQuorum
        );

        if (!majorityEntry) {
            return res.status(409).json({
                success: false,
                message:
                    "No strict majority found. Repair stopped to prevent data loss.",
                fileId,
                requiredQuorum,
                sourceCopies,
            });
        }

        const [majorityHash] = majorityEntry;

        // Step 4: Select a source node belonging to the majority.
        const source = sourceCopies.find(
            (copy) => copy.sha256 === majorityHash
        );

        if (!source) {
            throw new Error("Majority source copy not found");
        }

        const sourceNode = storageNodes.find(
            (node) => node.id === source.nodeId
        );

        if (!sourceNode) {
            throw new Error("Source storage node not found");
        }

        // Step 5: Find missing or corrupted reachable replicas.
        const targets = nodeResults.filter((node) => {
            if (!node.reachable) return false;

            const existingFile = node.files.find(
                (file) => file.fileId === fileId
            );

            // Repair missing files and files whose hashes
            // do not match the trusted majority hash.
            return !existingFile || existingFile.sha256 !== majorityHash;
        });

        const offlineNodes = nodeResults
            .filter((node) => !node.reachable)
            .map((node) => node.nodeId);

        if (targets.length === 0) {
            return res.json({
                success: true,
                message: offlineNodes.length > 0
                    ? "All reachable replicas are healthy. Offline nodes were skipped."
                    : "All replicas are already healthy.",
                fileId,
                sourceNode: source.nodeId,
                expectedSha256: majorityHash,
                repairedNodes: [],
                offlineNodes,
            });
        }

        // Step 6: Download the trusted majority copy.
        const downloadResponse = await fetch(
            `${sourceNode.url}/files/${encodeURIComponent(fileId)}`,
            { signal: AbortSignal.timeout(10000) }
        );

        if (!downloadResponse.ok) {
            throw new Error("Could not download file from majority source node");
        }

        const fileBytes = new Uint8Array(
            await downloadResponse.arrayBuffer()
        );

        // Step 7: Upload the trusted copy to missing/corrupted replicas.
        const repairResults: Array<{
            nodeId: string;
            status: "repaired" | "failed";
            reason?: string;
            sha256?: string;
            error?: string;
        }> = [];

        for (const target of targets) {
            const targetNode = storageNodes.find(
                (node) => node.id === target.nodeId
            );

            if (!targetNode) continue;

            const existingFile = target.files.find(
                (file) => file.fileId === fileId
            );

            const reason = !existingFile ? "missing_replica" : "hash_mismatch";

            try {
                const uploadResponse = await fetch(
                    `${targetNode.url}/files/${encodeURIComponent(fileId)}`,
                    {
                        method: "PUT",
                        headers: {
                            "Content-Type": "application/octet-stream",
                        },
                        body: fileBytes as unknown as BodyInit,
                        signal: AbortSignal.timeout(15000),
                    }
                );

                if (!uploadResponse.ok) {
                    throw new Error(
                        `Upload failed: HTTP ${uploadResponse.status}`
                    );
                }

                const uploadResult = (await uploadResponse.json()) as {
                    sha256?: string;
                };

                if (uploadResult.sha256 !== majorityHash) {
                    throw new Error(
                        "SHA-256 verification failed after repair"
                    );
                }

                repairResults.push({
                    nodeId: target.nodeId,
                    status: "repaired",
                    reason,
                    sha256: uploadResult.sha256,
                });
            } catch (error) {
                repairResults.push({
                    nodeId: target.nodeId,
                    status: "failed",
                    reason,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                });
            }
        }

        // Step 8: Return the recovery report.
        const failedRepairs = repairResults.filter(
            (result) => result.status === "failed"
        );

        return res.status(failedRepairs.length > 0 ? 207 : 200).json({
            success: failedRepairs.length === 0,
            message:
                failedRepairs.length === 0
                    ? "Majority-based replica recovery completed successfully."
                    : "Replica recovery completed with some failures.",
            fileId,
            sourceNode: source.nodeId,
            majorityHash,
            requiredQuorum,
            repairedNodes: repairResults,
            offlineNodes,
            checkedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Replica repair failed:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to repair file replicas.",
            fileId,
        });
    }
});



// Validate file IDs before forwarding requests
function isValidFileId(fileId: string): boolean {
    return /^[a-zA-Z0-9_-]{1,100}$/.test(fileId);
}

// Upload and replicate files across all storage nodes
app.put(
    "/api/v1/files/:fileId",
    express.raw({
        type: "application/octet-stream",
        limit: "100mb",
    }),
    async (req, res) => {
        try {
            const fileId = String(req.params.fileId);

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

            // Send the same file to all registered storage nodes
            const replicationResults = await Promise.all(
                storageNodes.map(async (node) => {
                    try {
                        const response = await fetch(
                            `${node.url}/files/${fileId}`,
                            {
                                method: "PUT",
                                headers: {
                                    "Content-Type": "application/octet-stream",
                                },
                                body: fileBuffer as unknown as BodyInit,
                                signal: AbortSignal.timeout(10000),
                            }
                        );

                        const result = await response.json().catch(() => null);

                        return {
                            nodeId: node.id,
                            success: response.ok,
                            status: response.status,
                            result,
                        };
                    } catch (error) {
                        return {
                            nodeId: node.id,
                            success: false,
                            status: null,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : "Unknown replication error",
                        };
                    }
                })
            );

            const successfulNodes = replicationResults.filter(
                (node) => node.success
            );

            const failedNodes = replicationResults.filter(
                (node) => !node.success
            );

            const replicationComplete =
                successfulNodes.length === storageNodes.length;

            return res.status(
                successfulNodes.length > 0 ? 201 : 503
            ).json({
                success: successfulNodes.length > 0,
                message: replicationComplete
                    ? "File replicated successfully across all storage nodes"
                    : "File replication incomplete",
                fileId,
                size: fileBuffer.length,
                replicationFactor: successfulNodes.length,
                totalNodes: storageNodes.length,
                replicationComplete,
                successfulNodes: successfulNodes.map(
                    (node) => node.nodeId
                ),
                failedNodes,
                results: replicationResults,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error("Replication error:", error);

            return res.status(500).json({
                success: false,
                error: "Internal replication error",
            });
        }
    }
);


let automaticRecoveryRunning = false;

async function runAutomaticRecovery(): Promise<void> {
    if (automaticRecoveryRunning) {
        return;
    }

    automaticRecoveryRunning = true;

    try {
        console.log("[Auto Recovery] Checking file integrity...");

        const integrityResponse = await fetch(
            `http://127.0.0.1:${PORT}/api/v1/files/integrity`,
            {
                signal: AbortSignal.timeout(15000),
            }
        );

        if (!integrityResponse.ok) {
            throw new Error(
                `Integrity check failed: HTTP ${integrityResponse.status}`
            );
        }

        const report = (await integrityResponse.json()) as {
            success?: boolean;
            files?: Array<{
                fileId: string;
                status: string;
            }>;
        };

        if (!report.success || !Array.isArray(report.files)) {
            console.log("[Auto Recovery] Invalid integrity report.");
            return;
        }

        const filesNeedingRepair = report.files.filter(
            (file) =>
                file.status === "missing_replica" ||
                file.status === "hash_mismatch"
        );

        if (filesNeedingRepair.length === 0) {
            console.log("[Auto Recovery] All available replicas are healthy.");
            return;
        }

        console.log(
            `[Auto Recovery] Found ${filesNeedingRepair.length} file(s) requiring repair.`
        );

        for (const file of filesNeedingRepair) {
            try {
                console.log(`[Auto Recovery] Repairing: ${file.fileId}`);

                const repairResponse = await fetch(
                    `http://127.0.0.1:${PORT}/api/v1/files/${encodeURIComponent(
                        file.fileId
                    )}/repair`,
                    {
                        method: "POST",
                        signal: AbortSignal.timeout(60000),
                    }
                );

                const repairResult = await repairResponse.json();

                if (repairResponse.ok) {
                    console.log(
                        `[Auto Recovery] Repair completed: ${file.fileId}`,
                        repairResult
                    );
                } else {
                    console.error(
                        `[Auto Recovery] Repair failed: ${file.fileId}`,
                        repairResult
                    );
                }
            } catch (error) {
                console.error(
                    `[Auto Recovery] Error repairing ${file.fileId}:`,
                    error
                );
            }
        }
    } catch (error) {
        console.error("[Auto Recovery] Monitor error:", error);
    } finally {
        automaticRecoveryRunning = false;
    }
}

app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log("CloudFS API Coordinator");
    console.log(`Running on port: ${PORT}`);
    console.log("--------------------------------");

    console.log("[Auto Recovery] Background monitor started.");

    // Run one check immediately after startup.
    void runAutomaticRecovery();

    // Continue checking every 30 seconds.
    setInterval(() => {
        void runAutomaticRecovery();
    }, 30_000);
});
