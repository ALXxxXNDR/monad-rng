import { getAddress } from "viem";

export const TESTNET_CHAIN_ID = 10_143n;
export const HISTORY_STORAGE = "0x0000F90827F1C53a10cb7A02335B175320002935";
export const FINALIZE_SAFETY_BLOCKS = 64n;
export const CANONICAL_CANARY = Object.freeze({
  platformName: "Monad RNG Public V1",
  requestPrice: 0n,
  maxPending: 0n,
});

export const SCENARIO_NAMES = Object.freeze([
  "requester",
  "rescue",
  "historical",
  "expiry",
]);

export const SCENARIO_DEFINITIONS = Object.freeze({
  requester: Object.freeze({
    action: "finalize",
    actor: "requester",
    description: "Requester finalizes from R+42 through R+103.",
  }),
  rescue: Object.freeze({
    action: "finalize",
    actor: "rescuer",
    description: "A different address finalizes at or after R+104.",
  }),
  historical: Object.freeze({
    action: "finalize",
    actor: "requester",
    description:
      "Requester finalizes after all three targets are 257 blocks old, forcing EIP-2935 history.",
  }),
  expiry: Object.freeze({
    action: "expire",
    actor: "rescuer",
    description: "A different address expires the request at or after R+8200.",
  }),
});

export function assertTestnetChainId(value) {
  const chainId = BigInt(value);
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(
      `This helper is Testnet-only: expected chain ID ${TESTNET_CHAIN_ID}, received ${chainId}`,
    );
  }
  return chainId;
}

export function requireScenarioName(value) {
  if (!SCENARIO_NAMES.includes(value)) {
    throw new Error(
      `Unknown scenario "${value ?? ""}". Choose: ${SCENARIO_NAMES.join(", ")}`,
    );
  }
  return value;
}

export function scheduleForRequestBlock(requestBlockValue) {
  const requestBlock = BigInt(requestBlockValue);
  const firstTargetBlock = requestBlock + 8n;
  const secondTargetBlock = requestBlock + 24n;
  const thirdTargetBlock = requestBlock + 40n;
  const requesterFinalizationBlock = thirdTargetBlock + 2n;
  const permissionlessRescueBlock = thirdTargetBlock + 64n;
  const historicalProofBlock = thirdTargetBlock + 257n;
  const lastProofValidBlock = firstTargetBlock + 8_191n;
  const firstExpiryBlock = lastProofValidBlock + 1n;

  return {
    requestBlock,
    firstTargetBlock,
    secondTargetBlock,
    thirdTargetBlock,
    requesterFinalizationBlock,
    permissionlessRescueBlock,
    historicalProofBlock,
    lastProofValidBlock,
    firstExpiryBlock,
  };
}

export function readinessForScenario(
  scenarioValue,
  requestBlockValue,
  finalizedBlockValue,
) {
  const scenario = requireScenarioName(scenarioValue);
  const schedule = scheduleForRequestBlock(requestBlockValue);
  const finalizedBlock = BigInt(finalizedBlockValue);

  if (scenario === "expiry") {
    const ready = finalizedBlock >= schedule.firstExpiryBlock;
    return {
      ready,
      action: "expire",
      actor: "rescuer",
      firstEligibleBlock: schedule.firstExpiryBlock,
      blocksRemaining: ready ? 0n : schedule.firstExpiryBlock - finalizedBlock,
      schedule,
    };
  }

  const firstEligibleBlock =
    scenario === "requester"
      ? schedule.requesterFinalizationBlock
      : scenario === "rescue"
        ? schedule.permissionlessRescueBlock
        : schedule.historicalProofBlock;
  const ready = finalizedBlock >= firstEligibleBlock;
  const safelyBeforeExpiry =
    finalizedBlock <= schedule.lastProofValidBlock - FINALIZE_SAFETY_BLOCKS;
  const requesterWindowOpen =
    scenario !== "requester" ||
    finalizedBlock < schedule.permissionlessRescueBlock;

  return {
    ready: ready && safelyBeforeExpiry && requesterWindowOpen,
    action: "finalize",
    actor: SCENARIO_DEFINITIONS[scenario].actor,
    firstEligibleBlock,
    blocksRemaining: ready ? 0n : firstEligibleBlock - finalizedBlock,
    safelyBeforeExpiry,
    requesterWindowOpen,
    schedule,
  };
}

export function normalizeRoleAddresses(requesterValue, rescuerValue) {
  const requester = getAddress(requesterValue);
  const rescuer = getAddress(rescuerValue);
  if (requester === rescuer) {
    throw new Error(
      "Requester and rescuer must be different addresses to prove the permissionless boundary.",
    );
  }
  return { requester, rescuer };
}

export function assertCanonicalCanaryConfig(config, requesterValue) {
  const requester = getAddress(requesterValue);
  if (getAddress(config.revenueRecipient) !== requester) {
    throw new Error("Canonical canary revenueRecipient must equal the requester");
  }
  if (config.platformName !== CANONICAL_CANARY.platformName) {
    throw new Error(
      `Canonical canary platformName must be "${CANONICAL_CANARY.platformName}"`,
    );
  }
  if (BigInt(config.requestPrice) !== CANONICAL_CANARY.requestPrice) {
    throw new Error("Canonical canary requestPrice must be zero");
  }
  if (BigInt(config.maxPending) !== CANONICAL_CANARY.maxPending) {
    throw new Error("Canonical canary maxPending must be zero");
  }
  return true;
}

export function gasWithMargin(estimateValue, capValue) {
  const estimate = BigInt(estimateValue);
  const cap = BigInt(capValue);
  const gas = (estimate * 120n + 99n) / 100n;
  if (gas > cap) {
    throw new Error(
      `Gas estimate with 20% margin (${gas}) exceeds the reviewed cap (${cap})`,
    );
  }
  return gas;
}

export function safeCastEnvironment(baseEnvironment, values) {
  const environment = { ...baseEnvironment };
  for (const name of [
    "PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY",
    "ETH_PRIVATE_KEY",
    "MNEMONIC",
    "MNEMONIC_PATH",
    "ETH_KEYSTORE",
    "ETH_KEYSTORE_ACCOUNT",
    "ETH_PASSWORD",
  ]) {
    delete environment[name];
  }

  environment.ETH_RPC_URL = values.rpcUrl;
  environment.CHAIN = TESTNET_CHAIN_ID.toString();
  environment.ETH_FROM = values.address;
  environment.ETH_KEYSTORE = values.keystorePath;
  environment.ETH_PASSWORD = values.passwordFilePath;
  environment.NO_COLOR = "1";
  return environment;
}

export function publicRpcLabel(rpcUrl) {
  try {
    return new URL(rpcUrl).hostname;
  } catch {
    return "(configured RPC)";
  }
}

export function asJson(value) {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    2,
  );
}
