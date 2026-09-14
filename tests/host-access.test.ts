import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPreimageManager: vi.fn() }));
vi.mock("@parity/product-sdk-host", () => ({
    getPreimageManager: mocks.getPreimageManager,
    requestPermission: vi.fn(),
}));
vi.mock("@parity/product-sdk-signer", () => ({
    SignerManager: class {}, HostProvider: class {}, DevProvider: class {},
    HostUnavailableError: class extends Error {}, NoAccountsError: class extends Error {},
}));
vi.mock("@parity/product-sdk-chain-client", () => ({ createChainClient: vi.fn() }));
vi.mock("@parity/product-sdk-contracts", () => ({
    ContractManager: {}, createContractRuntimeFromClient: vi.fn(), ensureContractAccountMapped: vi.fn(),
}));

let utils: typeof import("../src/utils");
const bytes = new TextEncoder().encode('{"title":"A survey"}');
let cid: string;
let onBytes: (value: Uint8Array | null) => void;
let interrupt: () => void;
const unsubscribe = vi.fn();
const removeInterrupt = vi.fn();
let lookup: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Direct network access is forbidden"); }));
    utils = await import("../src/utils");
    cid = utils.calculateCID(bytes);
    lookup = vi.fn((_key, callback) => {
        onBytes = callback;
        return {
            unsubscribe,
            onInterrupt: (callback: () => void) => { interrupt = callback; return removeInterrupt; },
        };
    });
    mocks.getPreimageManager.mockResolvedValue({ lookup });
});

afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function startRead(timeout?: number) {
    const pending = utils.fetchFromBulletin(cid, timeout);
    await Promise.resolve();
    return { pending };
}

describe("host Bulletin reads", () => {
    it("waits for content, checks its CID and releases the subscription", async () => {
        const { pending } = await startRead();
        onBytes(null);
        expect(unsubscribe).not.toHaveBeenCalled();
        onBytes(bytes);
        await expect(pending).resolves.toEqual(bytes);
        expect(lookup.mock.calls[0][0]).toMatch(/^0x[0-9a-f]{64}$/);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(removeInterrupt).toHaveBeenCalledTimes(1);
    });

    it("releases a subscription that supplies cached bytes synchronously", async () => {
        lookup.mockImplementation((_key, callback) => {
            callback(bytes);
            return { unsubscribe, onInterrupt: () => removeInterrupt };
        });
        await expect(utils.fetchFromBulletin(cid)).resolves.toEqual(bytes);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(removeInterrupt).toHaveBeenCalledTimes(1);
    });

    it("rejects absent hosts without opening another network path", async () => {
        mocks.getPreimageManager.mockResolvedValue(null);
        await expect(utils.fetchFromBulletin(cid)).rejects.toThrow("Polkadot host");
        expect(lookup).not.toHaveBeenCalled();
    });

    it("rejects malformed CIDs before starting host work", async () => {
        await expect(utils.fetchFromBulletin("not-a-cid")).rejects.toThrow();
        expect(mocks.getPreimageManager).not.toHaveBeenCalled();
    });

    it("rejects content with a different digest", async () => {
        const { pending } = await startRead();
        onBytes(new Uint8Array([1, 2, 3]));
        await expect(pending).rejects.toThrow("does not match");
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cleans up and rejects host interruption", async () => {
        const { pending } = await startRead();
        interrupt();
        await expect(pending).rejects.toThrow("interrupted");
        onBytes(bytes);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it("cleans up a lookup that never returns content", async () => {
        vi.useFakeTimers();
        const { pending } = await startRead(50);
        const rejection = expect(pending).rejects.toThrow("timed out");
        await vi.advanceTimersByTimeAsync(50);
        await rejection;
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears its timeout when subscription setup fails", async () => {
        vi.useFakeTimers();
        lookup.mockImplementation(() => { throw new Error("lookup failed"); });
        await expect(utils.fetchFromBulletin(cid)).rejects.toThrow("lookup failed");
        expect(vi.getTimerCount()).toBe(0);
    });
});


describe("existing history before saving", () => {
    it("starts a fresh history only for an explicit empty CID", async () => {
        await expect(utils.readPlayerData(async () => ({ success: true, value: "" }))).resolves.toBeNull();
        expect(mocks.getPreimageManager).not.toHaveBeenCalled();
    });

    it.each([{ success: false }, { success: true }])("rejects failed or malformed contract reads: %j", async (response) => {
        await expect(utils.readPlayerData(async () => response)).rejects.toThrow();
        expect(mocks.getPreimageManager).not.toHaveBeenCalled();
    });

    it("preserves existing history when host lookup fails", async () => {
        mocks.getPreimageManager.mockResolvedValue(null);
        await expect(utils.readPlayerData(async () => ({ success: true, value: cid }))).rejects.toThrow("Polkadot host");
    });

    it("returns stored game history after content validation", async () => {
        const data = { player: "0x1234", totalGames: 2, wins: 1, losses: 1, draws: 0, points: 1, games: [] };
        const payload = new TextEncoder().encode(JSON.stringify(data));
        const pending = utils.readPlayerData(async () => ({ success: true, value: utils.calculateCID(payload) }));
        await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
        onBytes(payload);
        await expect(pending).resolves.toEqual(data);
    });

    it("does not treat a stored null record as a first-time player", async () => {
        const payload = new TextEncoder().encode("null");
        const pending = utils.readPlayerData(async () => ({ success: true, value: utils.calculateCID(payload) }));
        await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
        onBytes(payload);
        await expect(pending).rejects.toThrow("Invalid existing player history");
    });
});
