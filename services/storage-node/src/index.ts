import express from "express";

const app = express();

const PORT = Number(process.env.PORT) || 4001;
const NODE_ID = process.env.NODE_ID || "storage-node-1";

app.use(express.json());

app.get("/", (_req, res) => {
    res.json({
        name: "CloudFS",
        service: "Storage Node",
        nodeId: NODE_ID,
        status: "running",
    });
});

app.get("/health", (_req, res) => {
    res.status(200).json({
        success: true,
        nodeId: NODE_ID,
        status: "healthy",
        timestamp: new Date().toISOString(),
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("--------------------------------");
    console.log(`CloudFS ${NODE_ID}`);
    console.log(`Running on port: ${PORT}`);
    console.log("--------------------------------");
});