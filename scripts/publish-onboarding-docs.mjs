import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const guideFiles = [
  "testnet-deployment.md",
  "production-readiness.md",
  "integration-guide.md",
  "deployment-and-verification.md",
  "operations-runbook.md",
];
export const deploymentManifestFile = "monad-testnet-v1.json";

export async function publishOnboardingDocs({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  outputDirectory = resolve(root, "public/docs"),
  manifestOutputDirectory = resolve(root, "public/deployments"),
} = {}) {
  await Promise.all([
    mkdir(outputDirectory, { recursive: true }),
    mkdir(manifestOutputDirectory, { recursive: true }),
  ]);
  await Promise.all(
    [
      ...guideFiles.map((file) =>
        copyFile(resolve(root, "docs", file), resolve(outputDirectory, file)),
      ),
      copyFile(
        resolve(root, "deployments", deploymentManifestFile),
        resolve(manifestOutputDirectory, deploymentManifestFile),
      ),
    ],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishOnboardingDocs();
}
