import { fromRlp, keccak256 } from "viem";

const RPC_URL = "https://testnet-rpc.monad.xyz";
const CHAIN_ID = 10_143n;
const BROWSER_ORIGIN = "https://monad-rng.example";
const HISTORY_STORAGE = "0x0000F90827F1C53a10cb7A02335B175320002935";
const HISTORICAL_AGE = 300n;
const REQUEST_TIMEOUT_MS = 15_000;

let rpcRequestId = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalized(value) {
  return value.toLowerCase();
}

function isHexBytes(value, expectedBytes) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    return false;
  }
  return expectedBytes === undefined || (value.length - 2) / 2 === expectedBytes;
}

function allowsCorsOrigin(response) {
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  return allowedOrigin === "*" || allowedOrigin === BROWSER_ORIGIN;
}

function commaSeparatedHeaderIncludes(response, headerName, expectedValue) {
  return (response.headers.get(headerName) ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim())
    .includes(expectedValue.toLowerCase());
}

async function verifyBrowserCors() {
  const response = await fetch(RPC_URL, {
    method: "OPTIONS",
    headers: {
      Origin: BROWSER_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  assert(response.ok, `CORS preflight returned HTTP ${response.status}`);
  assert(allowsCorsOrigin(response), "CORS preflight did not allow the browser origin");
  assert(
    commaSeparatedHeaderIncludes(response, "access-control-allow-methods", "POST"),
    "CORS preflight did not allow POST",
  );
  assert(
    commaSeparatedHeaderIncludes(response, "access-control-allow-headers", "content-type"),
    "CORS preflight did not allow the Content-Type header",
  );
}

async function rpc(method, params = []) {
  rpcRequestId += 1;
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      Origin: BROWSER_ORIGIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcRequestId,
      method,
      params,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  assert(response.ok, `${method} returned HTTP ${response.status}`);
  assert(allowsCorsOrigin(response), `${method} POST response did not allow the browser origin`);

  const payload = await response.json();
  assert(payload && typeof payload === "object", `${method} returned invalid JSON`);
  assert(!payload.error, `${method} RPC error: ${JSON.stringify(payload.error)}`);
  assert("result" in payload, `${method} response omitted result`);
  return payload.result;
}

function requireBlock(block, label) {
  assert(block && typeof block === "object", `${label} block was not returned`);
  assert(typeof block.number === "string", `${label} block omitted number`);
  assert(isHexBytes(block.hash, 32), `${label} block omitted a 32-byte hash`);
  return block;
}

function blockNumberCalldata(blockNumber) {
  const encoded = blockNumber.toString(16);
  assert(encoded.length <= 64, "Historical block number does not fit in 32 bytes");
  return `0x${encoded.padStart(64, "0")}`;
}

async function main() {
  await verifyBrowserCors();

  const chainIdHex = await rpc("eth_chainId");
  assert(typeof chainIdHex === "string", "eth_chainId returned a non-string result");
  const liveChainId = BigInt(chainIdHex);
  assert(liveChainId === CHAIN_ID, `Wrong chain ID: expected ${CHAIN_ID}, received ${liveChainId}`);

  const finalized = requireBlock(
    await rpc("eth_getBlockByNumber", ["finalized", false]),
    "Finalized",
  );
  const finalizedNumber = BigInt(finalized.number);

  const rawHeader = await rpc("debug_getRawHeader", [finalized.number]);
  assert(isHexBytes(rawHeader), "debug_getRawHeader returned malformed or odd-length hex");

  let headerFields;
  try {
    headerFields = fromRlp(rawHeader, "hex");
  } catch (error) {
    throw new Error("debug_getRawHeader returned invalid RLP", { cause: error });
  }

  assert(Array.isArray(headerFields), "Raw header is not an RLP list");
  assert(headerFields.length > 13, `Raw header has only ${headerFields.length} fields`);
  assert(
    typeof headerFields[8] === "string" && isHexBytes(headerFields[8]),
    "RLP field 8 is not a byte string block number",
  );
  assert(
    BigInt(headerFields[8]) === finalizedNumber,
    "RLP field 8 does not match the finalized block number",
  );
  assert(isHexBytes(headerFields[13], 32), "RLP field 13 is not a 32-byte mixHash");
  assert(isHexBytes(finalized.mixHash, 32), "Finalized block omitted a 32-byte mixHash");
  assert(
    normalized(headerFields[13]) === normalized(finalized.mixHash),
    "RLP field 13 does not match the finalized block mixHash",
  );

  const computedHeaderHash = keccak256(rawHeader);
  assert(
    normalized(computedHeaderHash) === normalized(finalized.hash),
    "Raw-header Keccak does not match the finalized canonical block hash",
  );

  assert(finalizedNumber > HISTORICAL_AGE, "Finalized chain height is too low for history test");
  assert(
    HISTORICAL_AGE > 256n && HISTORICAL_AGE < 8_191n,
    "History test age must be outside BLOCKHASH and inside EIP-2935",
  );

  const historicalNumber = finalizedNumber - HISTORICAL_AGE;
  const historicalNumberHex = `0x${historicalNumber.toString(16)}`;
  const historicalBlock = requireBlock(
    await rpc("eth_getBlockByNumber", [historicalNumberHex, false]),
    "Historical",
  );
  const historyResult = await rpc("eth_call", [
    {
      to: HISTORY_STORAGE,
      data: blockNumberCalldata(historicalNumber),
    },
    "finalized",
  ]);

  assert(isHexBytes(historyResult, 32), "EIP-2935 returned a non-32-byte block hash");
  assert(
    normalized(historyResult) === normalized(historicalBlock.hash),
    "EIP-2935 history hash does not match the canonical historical block",
  );

  console.log("Monad testnet RPC smoke check passed");
  console.log(`chainId: ${liveChainId} (${chainIdHex})`);
  console.log(`browser CORS: OPTIONS and POST allowed for ${BROWSER_ORIGIN}`);
  console.log(
    `finalized block: ${finalizedNumber} (${finalized.hash}), raw RLP ${(
      (rawHeader.length - 2) /
      2
    ).toLocaleString()} bytes`,
  );
  console.log("header hash matched");
  console.log(`mixHash field matched: ${headerFields[13]}`);
  console.log(
    `EIP-2935 matched block ${historicalNumber} at age ${HISTORICAL_AGE}: ${historyResult}`,
  );
}

main().catch((error) => {
  console.error("Monad testnet RPC smoke check FAILED");
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
