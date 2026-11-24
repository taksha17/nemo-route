import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-route-test-"));
process.env.NEMO_DATA_DIR = tmp;
process.env.NEMO_ENCRYPTION_SECRET = "test-secret-for-vitest";
process.env.NEMO_ADMIN_TOKEN = "test-admin-token-vitest";
process.env.NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
