# RPS Game

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Decentralized rock-paper-scissors game, with on-chain leaderboard and game history.

## Modes

- **Solo** — play against the computer, best-of-3
- **Multiplayer** — play against another player via Statement Store (commit-reveal anti-cheat)

Scoring: win **+2**, loss **−1**, draw **0**.

## How it works

**Solo:** You play locally → after the match, JSON with history is uploaded to Bulletin → contract stores CID + points.

**Multiplayer:** Create a room, get a code, share it with your opponent. Each round:
1. Both players send `commit = SHA256(move + salt)` over Statement Store
2. Once both commits arrive, they send `reveal = { move, salt }`
3. Hash is verified, round winner is determined

**Leaderboard:** Contract on Asset Hub stores a `address → (CID, points)` mapping. All games live on Bulletin (off-chain, content-addressed).

## Running

```bash
npm install

# Dev server
npm run dev
```
Open polkadot desktop on localhost.

> Deploying **your own copy** (own contract, own `.dot` name, published to the
> playground)? Follow the step-by-step [DEPLOYMENT.md](./DEPLOYMENT.md).

> Account needs PAS tokens on Asset Hub ([faucet](https://faucet.polkadot.io/)) and Bulletin chain ([faucet](https://paritytech.github.io/polkadot-bulletin-chain/authorizations?tab=faucet)).
> Multiplayer requires running inside the Polkadot Desktop container (Host API).

## Security

This is a reference proof-of-concept, **not a hardened production build**. Before
deploying it for any real use case, you are responsible for:

- Reviewing the code yourself.
- Checking that dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network configuration).
- Tracking the latest tagged release / commits for security fixes — older releases
  are not backported (exceptions might apply).

For Parity's security disclosure process and Bug Bounty program, see
[parity.io/bug-bounty](https://parity.io/bug-bounty).

## License

Licensed under the [GNU General Public License v3.0 or later](./LICENSE) (GPL-3.0-or-later).


## Host access and validation

Both network variants require a Polkadot host. Player history is read through
host preimage subscriptions and checked against its raw BLAKE2b-256 CID; no
public IPFS gateway is used. A failed history read stops saving a new result so
existing history is preserved. An empty CID starts a first-time history.

Run `npm test` and `npm run build` for local validation. Repeat with
`VITE_NETWORK=devnet` for the opt-in devnet build. These isolated tests and builds
do not establish live contract deployment or Desktop gameplay acceptance.
