
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { performance } from "node:perf_hooks";

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

const storageNodes: StorageNode[] = [
    {
        id: "storage-node-1",
        url: "http://localhost:4001",
    },
    {
        id: "storage-node-2",
        url: "http://localhost:4002",
    },
    {
        id: "storage-node-3",
        url: "http://localhost:4003",
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

app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log("CloudFS API Coordinator");
    console.log(`Running on port: ${PORT}`);
    console.log("--------------------------------");
});
