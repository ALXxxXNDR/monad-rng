import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { keccak256 } from "viem";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "public", "contracts");
await mkdir(outputDirectory, { recursive: true });

const contracts = [
  {
    contractName: "PlatformRandomness",
    sourceFile: "PlatformRandomness.sol",
    sourceFiles: ["PlatformRandomness.sol", "MonadHeaderReader.sol"],
  },
  {
    contractName: "RandomnessFactory",
    sourceFile: "RandomnessFactory.sol",
    sourceFiles: ["RandomnessFactory.sol", "PlatformRandomness.sol", "MonadHeaderReader.sol"],
  },
];

const sourceFiles = new Set();
const exported = [];

for (const contract of contracts) {
  const artifactPath = path.join(
    projectRoot,
    "contracts",
    "out",
    contract.sourceFile,
    `${contract.contractName}.json`,
  );
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
    throw new Error(`${contract.contractName} creation bytecode has unresolved library links`);
  }
  if (Object.keys(artifact.deployedBytecode?.linkReferences ?? {}).length !== 0) {
    throw new Error(`${contract.contractName} runtime bytecode has unresolved library links`);
  }

  const browserArtifact = {
    schemaVersion: 2,
    contractName: contract.contractName,
    sourceName: `contracts/src/${contract.sourceFile}`,
    compilerVersion: artifact.metadata?.compiler?.version ?? "unknown",
    abi: artifact.abi,
    bytecode,
    runtimeBytecode,
    runtimeBytecodeHash: keccak256(runtimeBytecode),
    sourceFiles: contract.sourceFiles.map((fileName) => `/contracts/${fileName}`),
  };

  await writeFile(
    path.join(outputDirectory, `${contract.contractName}.json`),
    `${JSON.stringify(browserArtifact, null, 2)}\n`,
  );

  contract.sourceFiles.forEach((fileName) => sourceFiles.add(fileName));
  exported.push({
    contractName: contract.contractName,
    creationBytes: bytecode.length / 2 - 1,
    runtimeBytes: runtimeBytecode.length / 2 - 1,
  });
}

for (const fileName of sourceFiles) {
  const source = await readFile(path.join(projectRoot, "contracts", "src", fileName), "utf8");
  await writeFile(
    path.join(outputDirectory, fileName),
    source.endsWith("\n") ? source : `${source}\n`,
  );
}

for (const artifact of exported) {
  console.log(
    `Exported ${artifact.contractName} ABI, ${artifact.creationBytes} creation bytes and ${artifact.runtimeBytes} runtime bytes.`,
  );
}
console.log(`Exported ${sourceFiles.size} Solidity source files.`);
