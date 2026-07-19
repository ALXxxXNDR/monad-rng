# Monad RNG V1 live Testnet deployment

> Tx1 locks the request; Tx2 finalizes and permanently stores the random result. A production integration must operate both as one flow.

This is the ownerless Monad Testnet V1 deployment for builders and reviewers.
It is a tested public canary, not a cryptographic VRF and not a Mainnet
approval. No external security audit is claimed.

## Addresses

| Contract | Monad Testnet address | Purpose |
| --- | --- | --- |
| `PlatformRandomness` | [`0x22A5Ed6bA91661cd06D68FBa5aae5015EDbF7DA1`](https://testnet.monadscan.com/address/0x22A5Ed6bA91661cd06D68FBa5aae5015EDbF7DA1) | Free public V1 canary for direct Tx1 and Tx2 testing |
| `RandomnessFactory` | [`0x75E6458DaA0c6152419e4617dcf4D459149C1530`](https://testnet.monadscan.com/address/0x75E6458DaA0c6152419e4617dcf4D459149C1530) | Ownerless Factory that lets a builder deploy an isolated instance |

Network: Monad Testnet, chain ID `10143`.

The machine-readable record is
[`deployments/monad-testnet-v1.json`](../deployments/monad-testnet-v1.json).

## Frozen public-canary settings

- `VERSION = 1`
- `CONFIGURATION_LOCKED = true`
- `protocolFee = 0`
- `platformName = "Monad RNG Public V1"`
- `requestPrice = 0`
- `maxPending = 0`, meaning unlimited
- `revenueRecipient = 0xE147A8c74c453227A5B84F18B512c31C20566090`

There is no owner, admin, pause, setter, proxy, upgrade, or privileged
finalizer. The deployment wallet cannot change the configuration or control a
result. A new design requires a new contract address.

## Deployment evidence

| Item | Evidence |
| --- | --- |
| Factory transaction | [`0x6e51…6f2f`](https://testnet.monadscan.com/tx/0x6e51d3cd5675c0e66933d787dd324cd1a6ce15fd60075fe29a79a1a77a616f2f) |
| Platform transaction | [`0xb9e9…e393`](https://testnet.monadscan.com/tx/0xb9e94f6691eed92065c73ca8f68a7c03f0f141d58ec1c939ab5e52596c3fe393) |
| Factory runtime hash | `0xd2d713b68539ca6949eeb072b607a77f8733a228ffb4f6abaa9603624268e28e` |
| Platform runtime hash | `0xe5bcd1470da3355bd74a1288e28dc12ab12e6906eeb49d54c9373234ddb55a61` |
| Release source commit | `fbded3748faab32f2b667bc8969d6fd6f84b865b` |

Two independently operated RPCs agreed at finalized block `46293609`. The
automated attestation matched both runtime bytecodes, deployment receipts,
Factory event, deployer, frozen settings, versions, zero protocol fee, and the
exact ownerless ABI. This bytecode attestation is separate from explorer source
verification.

Sourcify also returned `exact_match` for both contracts using the release
compiler settings and the Platform's frozen constructor arguments:

- [Verified Platform source on MonadVision](https://testnet.monadvision.com/address/0x22A5Ed6bA91661cd06D68FBa5aae5015EDbF7DA1)
- [Verified Factory source on MonadVision](https://testnet.monadvision.com/address/0x75E6458DaA0c6152419e4617dcf4D459149C1530)

## Live Tx1 and Tx2 evidence

Two requests were completed and permanent storage was read again afterward:

| Test | Tx1 | Tx2 | Finalizer | Stored draw |
| --- | --- | --- | --- | --- |
| Requester-window finalization | [`0xbe6d…147e`](https://testnet.monadscan.com/tx/0xbe6df9de02d42f46cda314eb67fa73a74277fa231065f04cd48e34f7cb67147e) | [`0x651a…850b`](https://testnet.monadscan.com/tx/0x651afddb7dda1fa838d8b12d3c2ac2ed49e4048821d0e619277726a19be2850b) | Original requester | `94` of `0–99` |
| Permissionless historical rescue | [`0x4043…40ba`](https://testnet.monadscan.com/tx/0x4043b3c318be4ec2d4414654545d9cdb4756add946927f28c1ecdc987d0840ba) | [`0x5140…ee31`](https://testnet.monadscan.com/tx/0x51408023884e9f5206be41870ea5b57ae79867fe7424fb6f959c9a8da306ee31) | Different funded address after `R+104` | `35` of `0–99` |

The second Tx2 authenticated three headers that were already more than 256
blocks old, so the contract necessarily used Monad's EIP-2935 historical hash
storage. Both results matched their events and permanent storage, repeated
`draw(requestId, 100)` calls were identical, and `pendingCount` returned to
zero. Both independent RPCs later agreed on finalized block `46296466` and
hash `0x211f5557928b6454dad9ed706604286b786204563825b91ed6589cef523174a8`,
which is after both Tx2 transactions.

## Builder paths

### Fastest Testnet experiment

1. Use the public `PlatformRandomness` address above.
2. Submit `requestRandomness()` as Tx1.
3. Save the emitted request ID and target blocks.
4. Fetch the three raw RLP headers after `R+42`.
5. Submit `finalizeRandomness(requestId, header1, header2, header3)` as Tx2.
6. Read `getRequest` and `draw`.

Tx2 is never automatic. The original requester may call it from `R+42` through
`R+103`; from `R+104`, any funded address may rescue it. A browser, script,
serverless job, keeper, or community caller can submit Tx2, so the protocol
does not require an always-on application server.

### Isolated platform instance

Call the Factory's
`deployPlatform(revenueRecipient, platformName, requestPrice, maxPending)`.
The caller pays deployment gas, and the returned contract is permanently
configured with those exact values. Neither the Factory nor the caller gains
owner or admin authority.

For paid entries or valuable prizes, integrate Tx1 with the business lock in a
wrapper and operate Tx2 as part of the same mandatory lifecycle. Read
[`integration-guide.md`](integration-guide.md) before using the primitive.
