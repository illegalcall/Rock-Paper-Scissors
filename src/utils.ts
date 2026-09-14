import { useState, useEffect } from "react";
import {
    getPreimageManager,
    requestPermission,
    type HostSubscription,
} from "@parity/product-sdk-host";
import {
    SignerManager,
    HostProvider,
    DevProvider,
    HostUnavailableError,
    NoAccountsError,
    type SignerAccount,
} from "@parity/product-sdk-signer";
import { createChainClient } from "@parity/product-sdk-chain-client";
import { ContractManager, createContractRuntimeFromClient, ensureContractAccountMapped } from "@parity/product-sdk-contracts";
import type { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";
import type { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import type { PolkadotClient, PolkadotSigner } from "polkadot-api";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";
import type { Move, RoundResult, PlayerData } from "./types.ts";

/**
 * Unwrap a product-sdk `Result` to its value, re-throwing the `err` channel as
 * an `Error`. Since product-sdk 0.18 fallible calls return `Result` instead of
 * throwing; this bridges them back onto throw / try-catch control flow. Mirrors
 * the CLI's `unwrapResult` (playground-cli #470).
 */
export function unwrapResult<T>(
    result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
    if (!result.ok) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
    return result.value;
}

// ---------------------------------------------------------------------------
// Networks. "paseo-next" is the Paseo Next v2 preview network (para 1500) —
// that's what the CDM `paseo` preset targets, NOT the public Paseo testnet.
// "devnet" is the public products devnet on the Paseo testnet Asset Hub
// (para 1000), with the community-operated CDM registry (reference:
// contract-dependency-manager PR #61). Build with VITE_NETWORK=devnet to
// select it; the default stays paseo-next. Descriptors load dynamically so
// each build ships a single metadata chunk; chain identity comes from the
// descriptor (host-routed chain client, no endpoints or genesis to pin).
// ---------------------------------------------------------------------------

type AssetHubDescriptor = typeof devnet_asset_hub | typeof paseo_asset_hub;

interface NetworkConfig {
    label: string;
    /** CDM ContractRegistry address the leaderboard resolves against. */
    registry: string;
    loadDescriptor(): Promise<AssetHubDescriptor>;
}

// `import.meta.env.VITE_NETWORK` is inlined as a literal at build time, so this
// comparison folds and the unselected network's ~880 kB metadata chunk is
// dropped from the bundle. Keep it a direct literal comparison — routing the
// choice through a lookup table or a normalizing helper leaves both import()s
// reachable, so the build emits both metadata chunks.
export const NETWORK: NetworkConfig =
    import.meta.env.VITE_NETWORK === "devnet"
        ? {
              label: "Devnet (Paseo testnet)",
              registry: "0x59b0245778917af55224e5f8fb55f7f8d452619f",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/devnet-asset-hub")).devnet_asset_hub,
          }
        : {
              label: "Paseo Next",
              registry: "0xf62c2ece29cd8df2e10040ecfa5a894a5c5d9cb0",
              loadDescriptor: async () =>
                  (await import("@parity/product-sdk-descriptors/paseo-asset-hub")).paseo_asset_hub,
          };

// Dev only: a typo'd VITE_NETWORK silently falls back to paseo-next, so say so
// while developing. Kept out of the selection above to preserve the fold.
if (import.meta.env.DEV) {
    const configured = import.meta.env.VITE_NETWORK;
    if (configured && configured !== "devnet" && configured !== "paseo" && configured !== "paseo-next") {
        console.warn(`[Network] Unknown VITE_NETWORK "${configured}", falling back to paseo-next`);
    }
}

// ---------------------------------------------------------------------------
// Permissions (RFC-0002)
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.ok && result.value) {
            _grantedPermissions.add(tag);
            console.log(`[Permission] ${tag} granted`);
        } else {
            console.warn(`[Permission] ${tag} denied`, result.ok ? "user rejected" : result.error);
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

// ---------------------------------------------------------------------------
// Account flow — @parity/product-sdk-signer (SignerManager + HostProvider).
// ---------------------------------------------------------------------------

/**
 * Identifier the host uses to scope our app-scoped product account, following
 * the product-sdk convention (`"<name>.dot"`). It is a fixed constant, NOT
 * derived from `window.location.host` — the same identifier must resolve the
 * same product account whether the app runs on localhost, `<name>.dot` in
 * Polkadot Desktop, or `<name>.dot.li` in a browser. (Reading the host would
 * give `<name>.dot.li` on the gateway and break account resolution there.)
 * It also feeds the Statement Store identity in multiplayer, so keep it
 * consistent. When deploying your own mod, change it to `"<your-name>.dot"`.
 */
const PRODUCT_ID = "rps-game.dot";
const DERIVATION_INDEX = 0;

export function getAppAccountId(): [string, number] {
    return [PRODUCT_ID, DERIVATION_INDEX];
}

/**
 * SignerManager wired to the Host API. The host derives an app-scoped product
 * account from `dotNsIdentifier`; HostProvider pins signing to
 * `createTransaction`, so pallet-revive's Paseo Next v2 signed extensions
 * (AsPgas, AsRingAlias, CheckWeight, WeightReclaim) are forwarded to the host
 * as opaque bytes rather than going through the PJS bridge that rejects unknown
 * extensions. It also requests the host's `ChainSubmit` permission on connect.
 */
export const signerManager = new SignerManager({
    dappName: "rps-game",
    createProvider: (type) =>
        type === "host"
            ? new HostProvider({
                  productAccount: { dotNsIdentifier: PRODUCT_ID, derivationIndex: DERIVATION_INDEX },
              })
            : new DevProvider(),
});

export interface AppAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    /** EVM-style h160 (keccak256(publicKey)[12..]) for pallet-revive contract args. */
    h160Address: `0x${string}`;
    /** 32-byte public key. */
    publicKey: Uint8Array;
    /** Display name (optional). */
    name: string | null;
    /** PolkadotSigner ready for `tx.signSubmitAndWatch`. */
    signer: PolkadotSigner;
    /** [identifier, derivationIndex] used by host-mediated APIs (e.g. Statement Store). */
    productAccountId: [string, number];
    /** Backwards-compat: pages call account.getSigner(). */
    getSigner(): PolkadotSigner;
}

/** Adapt a SignerAccount from the SDK to the app's AppAccount shape. */
function toAppAccount(sa: SignerAccount): AppAccount {
    const signer = sa.getSigner();
    return {
        address: sa.address,
        h160Address: sa.h160Address,
        publicKey: sa.publicKey,
        name: sa.name,
        signer,
        productAccountId: [PRODUCT_ID, DERIVATION_INDEX],
        getSigner: () => signer,
    };
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        console.log(`[Account] Connecting product account ${PRODUCT_ID}#${DERIVATION_INDEX}`);
        const result = await signerManager.connect("host");

        if (!result.ok) {
            // Not inside a host / not signed in → prompt sign-in rather than error.
            if (result.error instanceof HostUnavailableError || result.error instanceof NoAccountsError) {
                setState({ status: "signed-out", account: null });
                return;
            }
            console.warn("[Account] connect error:", result.error.message);
            setState({ status: "error", account: null, error: result.error.message });
            return;
        }

        const accounts = result.value;
        if (accounts.length === 0) {
            setState({ status: "signed-out", account: null });
            return;
        }

        // Host product mode returns the single app-scoped account; select it so
        // `signerManager.getSigner()` and persistence track it.
        const selected = signerManager.selectAccount(accounts[0].address);
        const account = toAppAccount(selected.ok ? selected.value : accounts[0]);

        // Wire signer + origin defaults so contract queries don't fall back to
        // the dev Alice account and tx calls don't need explicit `{ signer }`.
        if (_contractManager) {
            _contractManager.setDefaults({ origin: account.address, signer: account.signer });
        }

        console.log(`[Account] Ready — ${account.address} (h160 ${account.h160Address}) (${account.name ?? PRODUCT_ID})`);
        setState({ status: "ready", account });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[Account] Connect failed:", msg);
        setState({ status: "error", account: null, error: msg });
    }
}

/** Retry the host connection. The host drives its own sign-in UI. */
export async function signIn(): Promise<void> {
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path (works in dev mode)
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(_account: AppAccount, bytes: Uint8Array): Promise<string> {
    await ensurePermission("PreimageSubmit");
    const cid = calculateCID(bytes);
    console.log("[Bulletin] Submitting preimage via host, size:", bytes.length, "expected CID:", cid);
    const preimageManager = await getPreimageManager();
    if (!preimageManager) {
        throw new Error("Preimage manager unavailable — open this app inside a Polkadot host.");
    }
    await preimageManager.submit(bytes);
    console.log("[Bulletin] Preimage stored.");
    return cid;
}

// ---------------------------------------------------------------------------
// Contract (sdk-ink + ContractManager). WS fallback handles dev mode
// where the host refuses to open Asset Hub chain provider.
// ---------------------------------------------------------------------------

let _contractManager: ContractManager | null = null;
let _contract: any = null;
let _polkadotClient: PolkadotClient | null = null;

/**
 * Wake the Asset Hub chain follow before a contract call. The host container
 * tears down the follow when the tab is backgrounded long enough; the first
 * request after wake bails with "No active follow for this chain" until we
 * touch the client to trigger a re-follow.
 */
export async function wakeChainFollow(): Promise<void> {
    if (!_polkadotClient) return;
    try {
        await _polkadotClient.getBestBlocks();
    } catch (err) {
        console.warn("[CDM] wakeChainFollow failed:", err);
    }
}

const NO_FOLLOW_RE = /no active follow/i;

/**
 * Wrap a contract method handle so each `query()` / `tx()` first wakes the
 * chain follow and retries once on "No active follow for this chain".
 */
function withFollowRetry<T extends Record<string, any>>(method: T): T {
    const wrap = <Fn extends (...a: any[]) => Promise<any>>(fn: Fn): Fn =>
        (async (...args: any[]) => {
            await wakeChainFollow();
            try {
                return await fn(...args);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!NO_FOLLOW_RE.test(msg)) throw err;
                console.warn("[CDM] follow lost mid-call, retrying once:", msg);
                await wakeChainFollow();
                return await fn(...args);
            }
        }) as Fn;

    return new Proxy(method, {
        get(target, prop) {
            const v = target[prop as keyof T];
            if (typeof v === "function") return wrap(v.bind(target));
            return v;
        },
    });
}

function wrapContract(contract: any): any {
    return new Proxy(contract, {
        get(target, prop) {
            const m = target[prop];
            if (m && typeof m === "object" && ("query" in m || "tx" in m)) {
                return withFollowRetry(m);
            }
            return m;
        },
    });
}

let _cdmJson: any = null;
let _contractInitPromise: Promise<void> | null = null;

/** Stage cdm.json without opening the Asset Hub chain client yet. */
export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
}

/**
 * Lazy contract init. Holding an Asset Hub PolkadotClient open (with its
 * chain-head follow) at app startup interferes with Bulletin preimage submits
 * — only spin up the chain client when a contract call
 * is actually about to happen. This defers `createChainClient`
 * until the first `getContract()` consumer calls a method.
 */
async function ensureContractsReady(): Promise<void> {
    if (_contractManager || !_cdmJson) return;
    if (_contractInitPromise) return _contractInitPromise;
    _contractInitPromise = (async () => {
        await ensurePermission("ChainSubmit");

        // Asset Hub access goes through the host's chain client — both dev
        // (localhost in Polkadot Desktop) and prod (dot.li) run inside a host.
        // `createChainClient` routes every connection through the host provider,
        // so the host never prompts "Allow Access to Web Domains" for a raw RPC
        // endpoint, and the chain identity comes from the descriptor — no
        // hardcoded genesis.
        const descriptor = await NETWORK.loadDescriptor();
        const chainClient = await createChainClient({
            chains: { assetHub: descriptor },
        });
        const client = chainClient.raw.assetHub;
        _polkadotClient = client;
        console.log(`[CDM] Asset Hub chain client ready (host-routed, ${NETWORK.label})`);

        console.log("[CDM] Waking Asset Hub chain follow...");
        await client.getChainSpecData();
        await client.getBestBlocks();
        console.log("[CDM] Chain follow active.");

        // @parity/product-sdk-contracts 0.7 wires through PAPI's typed API + revive
        // runtime API directly (no sdk-ink). `fromLiveClient` resolves the leaderboard
        // address from the live CDM registry on each init instead of trusting the
        // snapshot baked into cdm.json — so a redeploy is picked up without shipping a
        // new cdm.json. The registry lookup is itself a contract query, so it needs a
        // mapped origin.
        //
        // The app gates every page behind sign-in (see App.tsx — pages only render
        // when status === "ready" with a connected account), so contract init is never
        // reached before a mapped product account exists. We therefore always have an
        // account to use as both defaultOrigin and registryOrigin; there is no public
        // pre-auth read path that would need a separate READ_ONLY_QUERY_ORIGIN.
        if (!_state.account) {
            throw new Error("[CDM] Contract init reached without a connected account");
        }

        // Map the product account BEFORE live registry resolution. `fromLiveClient`
        // immediately calls `registry.getAddress("@rps/leaderboard")` as a view, and
        // pallet-revive dry-run-fails that call with `Revive::AccountUnmapped` when the
        // query origin isn't mapped — surfacing as ContractLiveAddressResolutionError.
        // Build a plain runtime (no registry query) to perform the mapping first.
        // (ChainSubmit permission already granted at the top of this init.)
        const initRuntime = createContractRuntimeFromClient(client, descriptor);
        await mapAccountWithRuntime(initRuntime, _state.account);

        // Since product-sdk 0.18, fromLiveClient returns a Result instead of
        // throwing on resolution failure. The registry address comes from the
        // selected network, so devnet resolves against the devnet registry.
        const live = await ContractManager.fromLiveClient(
            _cdmJson,
            client,
            descriptor,
            {
                defaultOrigin: _state.account.address as never,
                defaultSigner: _state.account.signer,
                registryAddress: NETWORK.registry as never,
                registryOrigin: _state.account.address as never,
                libraries: ["@rps/leaderboard"],
            },
        );
        if (!live.ok) throw live.error;
        _contractManager = live.value;
        _contract = wrapContract(_contractManager.getContract("@rps/leaderboard"));
        console.log("[CDM] Contract manager ready (live registry resolution)");
    })();
    return _contractInitPromise;
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

/**
 * Get a lazy-initialized contract handle. The Asset Hub chain client doesn't
 * spin up until a method is actually called, so Bulletin preimage submits at
 * startup don't compete with a leaderboard chain follow.
 */
export function getContract(): any {
    if (!_cdmJson) return null;
    // Return a proxy that defers chain init until first method call.
    return new Proxy({}, {
        get(_target, prop) {
            // sync property access (truthiness check) returns a stub method object
            return new Proxy({} as any, {
                get(_t, methodProp) {
                    if (methodProp !== "query" && methodProp !== "tx") return undefined;
                    return async (...args: any[]) => {
                        await ensureContractsReady();
                        if (!_contract) throw new Error("Contract init failed");
                        const real = _contract[prop as string];
                        if (!real) throw new Error(`Unknown method: ${String(prop)}`);
                        // Since product-sdk 0.18, `.tx(...)` returns a Result
                        // instead of throwing. Unwrap it (re-throw the `err`
                        // channel) so call sites keep their try/catch flow.
                        // `.query(...)` is unchanged upstream.
                        const outcome = await real[methodProp](...args);
                        return methodProp === "tx" ? unwrapResult(outcome) : outcome;
                    };
                },
            });
        },
    });
}

/**
 * Format a 20-byte H160 for a contract `address` parameter.
 *
 * The contract ABI now uses Solidity `address` (was `bytes20`); the product-sdk
 * encoder accepts a `0x...` hex string for both. Prior versions of this helper
 * returned a `Binary` instance, but multiple substrate-bindings versions hoisted
 * into `node_modules` cause the `asHex` duck-type check to occasionally fail
 * across realm boundaries. Returning the hex string is the most robust path —
 * the encoder handles it directly and there's no class identity to mis-match.
 */
export function asAddress(hexOrAccount: string | AppAccount): `0x${string}` {
    const hex = typeof hexOrAccount === "string" ? hexOrAccount : hexOrAccount.h160Address;
    if (!hex.startsWith("0x")) return ("0x" + hex) as `0x${string}`;
    return hex as `0x${string}`;
}

/** @deprecated ABI now uses `address`; kept so existing call sites keep working. Use {@link asAddress}. */
export const asBytes20 = asAddress;

// ---------------------------------------------------------------------------
// Account mapping (Revive)
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

// pallet-revive on Paseo Next v2 requires every SS58 origin that calls a contract to
// have an explicit Revive.map_account() entry. Product accounts are NOT pre-mapped by
// the host — first contract call from a fresh product account dry-run-fails with
// `Revive::AccountUnmapped` until we submit the mapping tx ourselves. The helper is
// idempotent (short-circuits when storage already has the entry), so the first-time
// path costs one signature and subsequent calls are free.
/**
 * Map an account using a pre-built ContractRuntime. Idempotent via
 * `_mappedAccounts`. Split out from `ensureMapping` so contract init can map
 * the origin *before* live registry resolution runs (see `ensureContractsReady`)
 * — `fromLiveClient`'s `registry.getAddress()` view call dry-run-fails with
 * `Revive::AccountUnmapped` if the query origin isn't mapped yet.
 */
async function mapAccountWithRuntime(
    runtime: Parameters<typeof ensureContractAccountMapped>[0],
    account: AppAccount,
): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    try {
        // Since product-sdk 0.18, ensureContractAccountMapped returns a Result
        // (ok(null) = already mapped) instead of throwing. Unwrap it so the
        // catch below handles both a returned `err` and any thrown failure with
        // the same cause-chain logging.
        const mapped = unwrapResult(
            await ensureContractAccountMapped(runtime, account.address as never, account.signer),
        );
        if (mapped === null) {
            console.log(`[Revive] Account ${account.address} already mapped`);
        } else {
            console.log(`[Revive] Account mapped in block #${mapped.block.number}`);
        }
        _mappedAccounts.add(account.address);
    } catch (err) {
        console.error("[Revive] ensureContractAccountMapped failed:", err);
        // TxAccountMappingError wraps the underlying storage-read failure in `cause`.
        // The top-level message alone hides whether it's a chainHead/runtime/decoder issue.
        const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
        if (cause) {
            console.error("[Revive] underlying cause:", cause);
            const rootCause = (cause as { cause?: unknown }).cause;
            if (rootCause) console.error("[Revive] root cause:", rootCause);
        }
        throw err;
    }
}

// pallet-revive on Paseo Next v2 requires every SS58 origin that calls a contract to
// have an explicit Revive.map_account() entry. The first-time path costs one signature;
// subsequent calls short-circuit. `ensureContractsReady()` already maps `_state.account`
// during init (before live registry resolution), so for the signed-in account this is a
// no-op — it stays public for tx call sites (register/updateResult) as an explicit guard.
export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;
    await ensureContractsReady();
    if (!_contractManager) throw new Error("Contract manager not ready");
    await mapAccountWithRuntime(_contractManager.getRuntime(), account);
}

// ---------------------------------------------------------------------------
// Bulletin reads through the host preimage subscription
// ---------------------------------------------------------------------------

export async function fetchFromBulletin(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const parsed = CID.parse(cid);
    // Survey uploads use raw blocks with a BLAKE2b-256 digest (calculateCID).
    if (parsed.code !== raw.code || parsed.multihash.code !== BLAKE2B_256_CODE || parsed.multihash.size !== 32) {
        throw new Error("Unsupported game CID: expected a raw BLAKE2b-256 block.");
    }
    const key = `0x${Array.from(parsed.multihash.digest, byte => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    const manager = await getPreimageManager();
    if (!manager) throw new Error("Bulletin storage is unavailable — open this app inside a Polkadot host.");

    return new Promise((resolve, reject) => {
        let done = false;
        let subscription: HostSubscription | undefined;
        let removeInterrupt: (() => void) | undefined;
        const cleanup = () => {
            clearTimeout(timer);
            removeInterrupt?.();
            subscription?.unsubscribe();
        };
        const fail = (error: unknown) => {
            if (done) return;
            done = true;
            cleanup();
            reject(error);
        };
        const timer = setTimeout(() => fail(new Error("Bulletin read timed out")), timeoutMs);
        try {
            subscription = manager.lookup(key, (bytes) => {
                if (done || bytes === null) return;
                if (calculateCID(bytes) !== parsed.toString()) {
                    fail(new Error("Bulletin content does not match the requested CID"));
                    return;
                }
                done = true;
                cleanup();
                resolve(bytes);
            });
            removeInterrupt = subscription.onInterrupt(() => fail(new Error("Bulletin host connection interrupted")));
            // A host may return its cached preimage synchronously during setup.
            if (done) cleanup();
        } catch (error) {
            fail(error);
        }
    });
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromBulletin(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Only an explicitly empty CID starts a new history; read failures must abort saving. */
export async function readPlayerData(
    queryCid: () => Promise<{ success: boolean; value?: string }>,
): Promise<PlayerData | null> {
    const result = await queryCid();
    if (!result.success) throw new Error("Unable to read the existing player history");
    if (result.value === "") return null;
    if (typeof result.value !== "string") throw new Error("Invalid player history CID response");
    const data = await fetchJsonFromBulletin<PlayerData>(result.value);
    if (!data || typeof data.player !== "string" || !Array.isArray(data.games) ||
        ![data.totalGames, data.wins, data.losses, data.draws, data.points].every(Number.isFinite)) {
        throw new Error("Invalid existing player history");
    }
    return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
    ]);
}

export function determineWinner(player: Move, opponent: Move): RoundResult {
    if (player === opponent) return "draw";
    if (
        (player === "rock" && opponent === "scissors") ||
        (player === "paper" && opponent === "rock") ||
        (player === "scissors" && opponent === "paper")
    ) {
        return "win";
    }
    return "loss";
}

export function pointsForResult(result: RoundResult): number {
    if (result === "win") return 2;
    if (result === "loss") return -1;
    return 0;
}

const MOVES: Move[] = ["rock", "paper", "scissors"];
export function randomMove(): Move {
    return MOVES[Math.floor(Math.random() * 3)];
}

export function generateRoomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}
