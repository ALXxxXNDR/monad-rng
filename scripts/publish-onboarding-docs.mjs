import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const guideFiles = [
  "production-readiness.md",
  "integration-guide.md",
  "deployment-and-verification.md",
  "operations-runbook.md",
];

export async function publishOnboardingDocs({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  outputDirectory = resolve(root, "public/docs"),
} = {}) {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    guideFiles.map((file) =>
      copyFile(resolve(root, "docs", file), resolve(outputDirectory, file)),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishOnboardingDocs();
}
