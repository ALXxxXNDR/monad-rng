import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { keccak256 } from "viem";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(
  projectRoot,
  "contracts",
  "out",
  "PlatformRandomness.sol",
  "PlatformRandomness.json",
);
const outputDirectory = path.join(projectRoot, "public", "contracts");
const sourceFiles = ["PlatformRandomness.sol", "MonadHeaderReader.sol"];

const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const bytecode = artifact.bytecode?.object;
const runtimeBytecode = artifact.deployedBytecode?.object;

if (!Array.isArray(artifact.abi)) {
  throw new Error(`Forge artifact has no ABI: ${artifactPath}`);
}
if (typeof bytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) {
  throw new Error(`Forge artifact has invalid creation bytecode: ${artifactPath}`);
}
if (
  typeof runtimeBytecode !== "string" ||
  !/^0x(?:[0-9a-fA-F]{2})+$/.test(runtimeBytecode)
) {
  throw new Error(`Forge artifact has invalid deployed runtime bytecode: ${artifactPath}`);
}
if (Object.keys(artifact.bytecode?.linkReferences ?? {}).length !== 0) {
  throw new Error("PlatformRandomness creation bytecode has unresolved library links");
}
if (Object.keys(artifact.deployedBytecode?.linkReferences ?? {}).length !== 0) {
  throw new Error("PlatformRandomness runtime bytecode has unresolved library links");
}

const browserArtifact = {
  schemaVersion: 2,
  contractName: "PlatformRandomness",
  sourceName: "contracts/src/PlatformRandomness.sol",
  compilerVersion: artifact.metadata?.compiler?.version ?? "unknown",
  abi: artifact.abi,
  bytecode,
  runtimeBytecode,
  runtimeBytecodeHash: keccak256(runtimeBytecode),
  sourceFiles: sourceFiles.map((fileName) => `/contracts/${fileName}`),
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "PlatformRandomness.json"),
  `${JSON.stringify(browserArtifact, null, 2)}\n`,
);

for (const fileName of sourceFiles) {
  const source = await readFile(path.join(projectRoot, "contracts", "src", fileName), "utf8");
  await writeFile(
    path.join(outputDirectory, fileName),
    source.endsWith("\n") ? source : `${source}\n`,
  );
}

console.log(
  `Exported PlatformRandomness ABI, ${bytecode.length / 2 - 1} creation bytes, ${runtimeBytecode.length / 2 - 1} runtime bytes, and ${sourceFiles.length} source files.`,
);
