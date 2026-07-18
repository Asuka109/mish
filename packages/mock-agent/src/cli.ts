import { startMockAgent } from "./index.ts";

const token = process.env.MISH_MOCK_TOKEN;
if (!token) throw new Error("MISH_MOCK_TOKEN is required");

const port = Number.parseInt(process.env.MISH_MOCK_PORT ?? "9098", 10);
const allowedOrigins = (process.env.MISH_MOCK_ORIGINS ?? "http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const agent = await startMockAgent({ allowedOrigins, authToken: token, port });
console.log(`Mish mock agent listening on ${agent.rpcUrl}`);

const stop = async () => {
  await agent.close();
  process.exitCode = 0;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
