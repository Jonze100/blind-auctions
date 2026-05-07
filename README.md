# Blind Auctions on Solana × Arcium MPC

A Solana program that runs sealed-bid, Vickrey, and uniform-price auctions with fully encrypted bids. No participant — including the auctioneer — can see any bid until the auction closes. Winner resolution happens inside an MPC cluster (Arcium's arx nodes) and only the result is revealed on-chain.

---

## How the MPC circuits work

Arcium compiles the circuits in `encrypted-ixs/src/lib.rs` (written in the `arcis` DSL) into garbled-circuit bytecode executed across multiple arx nodes. Each node holds only a secret share of the data; no single node ever sees plaintext bids.

### Encrypted data structures

```rust
struct Bid     { amount: u64, bidder_lo: u128, bidder_hi: u128 }
struct BidBook { bids: [Bid; 4], count: u64 }
```

`BidBook` lives on-chain inside `AuctionState` as a `SharedEncryptedStruct`:

```
32 bytes  — x25519 public key (owner = MXE)
16 bytes  — nonce
13 × 32 bytes — Rescue ciphertexts  (4 bids × 3 fields + 1 count field)
────────
464 bytes total
```

Only the arx nodes can decrypt this blob. The Solana program never sees plaintext bid data.

---

### Circuit 1 — `submit_bid`

**Inputs:** encrypted `Bid`, encrypted `BidBook`, plaintext `bid_count` (on-chain slot index)  
**Output:** re-encrypted `BidBook`

The circuit decrypts the current book, writes the new bid at index `bid_count` (passed as plaintext to avoid relying on the encrypted `count` field, which is garbage when the account is zero-initialised), increments `count`, and re-encrypts the whole book under the same shared key.

```rust
for i in 0..MAX_BIDS {
    if i == bid_count { book.bids[i] = new_bid; }
}
book.count = bid_count + 1;
```

The Solana callback (`submit_bid_callback`) receives the new 464-byte encrypted blob and writes it back into `AuctionState.book_ciphertexts`.

> **Why MAX_BIDS = 4?**  
> Solana's max transaction size is 1232 bytes. At `MAX_BIDS = 32` the output is 3152 bytes — the arx node reports `OutputTooLarge` and the callback fails. With `MAX_BIDS = 4` the output is 464 bytes, which fits comfortably.

---

### Circuit 2 — `find_winner_sealed` (first-price sealed-bid)

**Input:** encrypted `BidBook`  
**Output:** `(clearing_price: u64, winner_lo: u128, winner_hi: u128)` — revealed in plaintext

Iterates all active slots in constant time (no early exit — MPC cannot branch on secret data), tracking the highest bid. Ties are broken with `ArcisRNG::bool()` so the winner is unpredictable. Only the winner identity and the price they pay are revealed on-chain via a `AuctionWinnerEvent`.

---

### Circuit 3 — `find_winner_vickrey` (second-price sealed-bid)

**Input:** encrypted `BidBook`  
**Output:** `(clearing_price: u64, winner_lo: u128, winner_hi: u128)`

Same oblivious scan, but tracks both the highest and second-highest amounts independently:

```
if bid > first:
    second = first
    first  = bid
    winner = bidder
elif bid > second and bid <= first:
    second = bid
```

The winner is the highest bidder; `clearing_price` is the second-highest bid. This is the incentive-compatible Vickrey rule — truthful bidding is a dominant strategy.

---

### Circuit 4 — `find_clearing_price` (uniform-price / multi-unit)

**Input:** encrypted `BidBook`, plaintext `slots` (number of units for sale)  
**Output:** `clearing_price: u64`

Copies all active bid amounts into a local array, runs a constant-time bubble sort (descending), and returns `top[slots - 1]` — the N-th highest bid. Every winning bidder pays this single clearing price.

---

## Auction flow

```
Client                      Solana program              Arcium arx nodes
──────                      ──────────────              ────────────────
encrypt bid with x25519
  shared secret  ────────►  submit_bid ix
                              queue_computation ──────►  decrypt BidBook
                                                          insert new Bid
                                                          re-encrypt BidBook
                            submit_bid_callback ◄──────  return encrypted BidBook
                              store ciphertexts

                            find_winner_* ix  ─────────► decrypt BidBook
                                                          compute winner
                                                          reveal result
                            callback ◄─────────────────  (price, winner_lo, winner_hi)
                              emit AuctionWinnerEvent
```

---

## Project layout

```
encrypted-ixs/src/lib.rs          ARCIS circuit definitions
programs/blind_auctions/src/lib.rs Anchor/Solana program (instructions + callbacks)
tests/blind_auctions.ts            End-to-end test suite
build/*.arcis                      Compiled circuit bytecode (git-ignored)
```

## Running the test suite

```bash
# Requires: Docker, Anchor CLI, Arcium CLI, Solana CLI
arcium test
```

Tests submit bids of 100, 250, 180 and assert:

| Auction type | Expected result |
|---|---|
| Sealed-bid | winner pays **250** (bidder lo=2) |
| Vickrey | winner pays **180** (second-highest) |
| Uniform (2 slots) | clearing price **180** |

All 4 tests pass in ~53 seconds on a 2-node localnet. End-to-end devnet tests require circuit upload (~60 SOL, see Deployment below).

## Deployment

### Devnet

| Component | Status |
|---|---|
| **Program** | `GLB8HNet6sGBBDLs6QW3sFFNxdLfKMUHSFAxpe9JWs6u` (Solana devnet) |
| **MXE** | Initialized on devnet cluster offset `456`, both arx nodes confirmed keygen |
| **x25519 pubkey** | `19c670ae25cee18ddd80165701b03e90e1ff09295a5d978b13aa0f98c6665760` |
| **Frontend** | `app/` — Next.js 14, connects to devnet, Phantom wallet |
| **Circuits** | Not yet uploaded to devnet (see note below) |

#### Circuit upload cost (devnet limitation)

The four compiled circuits total **8.7 MB** of bytecode. Storing them on-chain requires rent-exempt deposits:

```
submit_bid.arcis        ~3.0 MB  →  ~20.9 SOL
find_winner_sealed.arcis ~2.2 MB →  ~15.2 SOL
find_winner_vickrey.arcis ~2.2 MB → ~15.2 SOL
find_clearing_price.arcis ~1.3 MB → ~9.3 SOL
──────────────────────────────────────────────
Total                              ~60.6 SOL
```

Devnet airdrop is rate-limited to 2 SOL per request. Once the wallet is funded with ~60 SOL (via [faucet.solana.com](https://faucet.solana.com) with GitHub auth — up to 5 SOL per request), run `arcium test --cluster devnet` to upload all circuits. The test is idempotent and resumes from wherever it left off.

Until circuits are uploaded, the on-chain program and bid encryption both work normally — MPC *computations* will queue on-chain but arx nodes cannot execute them without the bytecode.

#### Deploy from scratch

```bash
# Switch to devnet and fund wallet first
solana config set --url devnet
solana airdrop 2

arcium build
arcium deploy --cluster devnet

# Initialize MXE (one-time, costs ~0.1 SOL)
arcium init-mxe --recovery-set-size 4 --cluster-offset 456 --rpc-url devnet

# Upload circuits and init computation definitions (~60 SOL required)
arcium test --cluster devnet
```

The devnet Arcium cluster offset is `456` (set in `Arcium.toml`).
