import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = dirname(scriptDir);
const packageJsonPath = join(apiDir, "package.json");
const outputPath = join(apiDir, "src", "build-info.generated.ts");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));

function readGitCommit() {
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      cwd: apiDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return process.env.GIT_COMMIT_SHA?.trim() || "unknown";
  }
}

const buildInfo = {
  version: String(pkg.version || "0.0.0"),
  commit: readGitCommit(),
  builtAt: new Date().toISOString(),
};

const contents = `export const BUILD_INFO = ${JSON.stringify(buildInfo, null, 2)} as const;\n`;

writeFileSync(outputPath, contents, "utf8");
