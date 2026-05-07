import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BlindAuctions } from "../target/types/blind_auctions";
import assert from "assert";
import {
  getArciumEnv,
  getArciumProgram,
  getCircuitState,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  awaitComputationFinalization,
  uploadCircuit,
  RescueCipher,
  x25519,
  deserializeLE,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as os from "os";
import * as fs from "fs";

function readKpJson(path: string): anchor.web3.Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: anchor.web3.PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (_) {}
    if (attempt < maxRetries)
      await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

describe("blind_auctions", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.BlindAuctions as Program<BlindAuctions>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);

  // Upload circuit and wait for the MPC finalization computation to complete.
  // uploadCircuit only waits for the finalizeComputationDefinition *instruction* to confirm —
  // not for the MPC to finish. We poll here until getCircuitState returns "OnchainFinalized".
  async function ensureCircuitUploaded(name: string) {
    const compDefPubkey = getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(name)).readUInt32LE()
    );

    // Already fully finalized? Nothing to do.
    try {
      const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
      if (getCircuitState((acc as any).circuitSource) === "OnchainFinalized") {
        console.log(`⏭  ${name} circuit already finalized`);
        return;
      }
    } catch (_) {}

    // Send upload + finalize instruction. On timeout the instruction may have landed;
    // skip retrying to avoid a double-finalize on-chain error — just fall through to poll.
    try {
      const raw = fs.readFileSync(`build/${name}.arcis`);
      await uploadCircuit(provider, name, program.programId, raw, true, 500, {
        skipPreflight: true,
        preflightCommitment: "processed",
        commitment: "processed",
      });
      console.log(`✅ circuit upload sent: ${name}`);
    } catch (e: any) {
      const isTimeout =
        e.name === "TransactionExpiredTimeoutError" ||
        e.message?.includes("was not confirmed") ||
        e.message?.includes("Blockhash");
      if (!isTimeout) throw e;
      console.log(`⚠  ${name} upload timed out, proceeding to finalization poll…`);
    }

    // Poll until the MPC finalization computation completes (up to 10 min).
    console.log(`  Waiting for ${name} circuit to finalize…`);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const acc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
        const state = getCircuitState((acc as any).circuitSource);
        if (state === "OnchainFinalized") {
          console.log(`✅ circuit finalized: ${name}`);
          return;
        }
      } catch (_) {}
    }
    throw new Error(`Circuit finalization timed out for ${name} after 600s`);
  }

  const arciumEnv = getArciumEnv();

  async function setupCipher() {
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const mxePublicKey = await getMXEPublicKeyWithRetry(provider, program.programId);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    return { privateKey, publicKey, cipher };
  }

  function encryptBid(
    cipher: RescueCipher,
    amount: bigint,
    bidderLo: bigint,
    bidderHi: bigint
  ) {
    const nonce = randomBytes(16);
    const ciphertexts = cipher.encrypt([amount, bidderLo, bidderHi], nonce);
    return { nonce, ciphertexts };
  }

  function getBaseAccounts(computationOffset: anchor.BN) {
    return {
      computationAccount: getComputationAccAddress(
        arciumEnv.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    };
  }

  function getCompDef(name: string) {
    return getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset(name)).readUInt32LE()
    );
  }

  const owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);

  it("inits all computation definitions", async () => {
    const mxeAccAddress = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccAddress);
    const addressLookupTable = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot
    );

    const names = [
      "submit_bid",
      "find_winner_sealed",
      "find_winner_vickrey",
      "find_clearing_price",
    ];

    // Phase 1: init all comp defs quickly, before any long waits.
    // All inits use skipPreflight + processed commitment to avoid blockhash expiry
    // issues that arise when previous circuit finalizations take many minutes.
    for (const name of names) {
      const methodName = `init${name
        .split("_")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join("")}CompDef`;

      let compDefExists = false;
      try {
        await arciumProgram.account.computationDefinitionAccount.fetch(getCompDef(name));
        compDefExists = true;
      } catch (_) {}

      if (compDefExists) {
        console.log(`⏭  ${name} comp def already exists`);
        continue;
      }

      let initialized = false;
      for (let attempt = 1; attempt <= 5 && !initialized; attempt++) {
        try {
          await (program.methods as any)
            [methodName]()
            .accountsPartial({
              compDefAccount: getCompDef(name),
              mxeAccount: mxeAccAddress,
              addressLookupTable,
            })
            .signers([owner])
            .rpc({
              skipPreflight: true,
              preflightCommitment: "processed",
              commitment: "processed",
            });
          console.log(`✅ init ${name} comp def`);
          initialized = true;
        } catch (e: any) {
          if (e.message?.includes("already in use")) {
            console.log(`⏭  ${name} comp def already exists`);
            initialized = true;
          } else if (
            attempt < 5 &&
            (e.message?.includes("Blockhash") ||
              e.message?.includes("was not confirmed") ||
              e.name === "TransactionExpiredTimeoutError")
          ) {
            console.log(`⚠  ${name} init attempt ${attempt} failed, retrying…`);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw e;
          }
        }
      }
      if (!initialized)
        throw new Error(`Failed to init ${name} comp def after 5 attempts`);
    }

    // Phase 2: upload each circuit and wait for OnchainFinalized before moving on.
    // This ensures all circuits are ready before the auction tests start.
    for (const name of names) {
      await ensureCircuitUploaded(name);
    }
  });

  it("runs a sealed-bid auction: 3 bidders, highest wins", async () => {
    const { publicKey, cipher } = await setupCipher();

    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), owner.publicKey.toBuffer()],
      program.programId
    );

    // Create auction (type 0 = sealed-bid, 1 slot)
    let auctionReady = false;
    for (let attempt = 1; attempt <= 5 && !auctionReady; attempt++) {
      try {
        await program.methods
          .createAuction(
            0,
            new anchor.BN(2),
            Array.from(publicKey),
            new anchor.BN(deserializeLE(randomBytes(16)).toString())
          )
          .accounts({ creator: owner.publicKey })
          .signers([owner])
          .rpc({
            skipPreflight: true,
            preflightCommitment: "processed",
            commitment: "processed",
          });
        console.log("✅ Auction created");
        auctionReady = true;
      } catch (e: any) {
        if (e.message?.includes("already in use")) {
          console.log("⏭  Auction already exists");
          auctionReady = true;
        } else if (
          attempt < 5 &&
          (e.message?.includes("Blockhash") ||
            e.message?.includes("was not confirmed") ||
            e.name === "TransactionExpiredTimeoutError")
        ) {
          console.log(`⚠  createAuction attempt ${attempt} failed, retrying…`);
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }

    // Submit 3 bids: 100, 250, 180
    const bids = [
      { amount: BigInt(100), lo: BigInt(1), hi: BigInt(0) },
      { amount: BigInt(250), lo: BigInt(2), hi: BigInt(0) },
      { amount: BigInt(180), lo: BigInt(3), hi: BigInt(0) },
    ];

    for (const bid of bids) {
      const { nonce, ciphertexts } = encryptBid(
        cipher,
        bid.amount,
        bid.lo,
        bid.hi
      );
      const computationOffset = new anchor.BN(randomBytes(8), "hex");

      let bidSent = false;
      for (let attempt = 1; attempt <= 5 && !bidSent; attempt++) {
        try {
          await program.methods
            .submitBid(
              computationOffset,
              Array.from(ciphertexts[0]),
              Array.from(ciphertexts[1]),
              Array.from(ciphertexts[2]),
              Array.from(publicKey),
              new anchor.BN(deserializeLE(nonce).toString())
            )
            .accountsPartial({
              ...getBaseAccounts(computationOffset),
              compDefAccount: getCompDef("submit_bid"),
              auctionState: auctionPda,
            })
            .signers([owner])
            .rpc({
              skipPreflight: true,
              preflightCommitment: "processed",
              commitment: "processed",
            });
          bidSent = true;
        } catch (e: any) {
          if (
            attempt < 5 &&
            (e.message?.includes("Blockhash") ||
              e.message?.includes("was not confirmed") ||
              e.name === "TransactionExpiredTimeoutError")
          ) {
            console.log(`⚠  submitBid attempt ${attempt} failed, retrying…`);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw e;
          }
        }
      }

      await awaitComputationFinalization(
        provider,
        computationOffset,
        program.programId,
        "confirmed",
        300_000
      );
      console.log(`✅ Bid submitted: ${bid.amount}`);
    }

    // Find winner (sealed-bid)
    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const winnerPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("auctionWinnerEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .findWinnerSealed(computationOffset)
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("find_winner_sealed"),
        auctionState: auctionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
      300_000
    );

    const event = await winnerPromise;
    console.log("✅ Sealed-bid winner found");
    console.log(
      "   Clearing price (pays own bid):",
      event.clearingPrice.toString()
    );
    console.log("   Winner lo:", event.winnerLo.toString());
    // Bids: 100 (lo=1), 250 (lo=2), 180 (lo=3) — winner is lo=2 paying 250
    assert.strictEqual(event.clearingPrice.toString(), "250");
    assert.strictEqual(event.winnerLo.toString(), "2");
    assert.strictEqual(event.winnerHi.toString(), "0");
  });

  it("runs a vickrey auction: winner pays second-highest price", async () => {
    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), owner.publicKey.toBuffer()],
      program.programId
    );

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const winnerPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("auctionWinnerEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .findWinnerVickrey(computationOffset)
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("find_winner_vickrey"),
        auctionState: auctionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
      300_000
    );

    const event = await winnerPromise;
    console.log("✅ Vickrey winner found");
    console.log(
      "   Clearing price (pays 2nd-highest):",
      event.clearingPrice.toString()
    );
    console.log("   Winner lo:", event.winnerLo.toString());
    // Highest bid was 250 (lo=2), second was 180 — winner pays 180
    assert.strictEqual(event.clearingPrice.toString(), "180");
    assert.strictEqual(event.winnerLo.toString(), "2");
    assert.strictEqual(event.winnerHi.toString(), "0");
  });

  it("runs a uniform-price auction: finds clearing price for N slots", async () => {
    const [auctionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), owner.publicKey.toBuffer()],
      program.programId
    );

    const computationOffset = new anchor.BN(randomBytes(8), "hex");

    const clearingPromise = new Promise<any>((resolve) => {
      const listener = program.addEventListener("clearingPriceEvent", (e) => {
        program.removeEventListener(listener);
        resolve(e);
      });
    });

    await program.methods
      .findClearingPrice(computationOffset)
      .accountsPartial({
        ...getBaseAccounts(computationOffset),
        compDefAccount: getCompDef("find_clearing_price"),
        auctionState: auctionPda,
      })
      .signers([owner])
      .rpc({ commitment: "confirmed" });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
      300_000
    );

    const event = await clearingPromise;
    console.log("✅ Uniform clearing price found");
    console.log("   Clearing price (2 slots):", event.clearingPrice.toString());
    // Top 2 bids: 250, 180 — clearing price is the 2nd highest = 180
    assert.strictEqual(event.clearingPrice.toString(), "180");
  });
});
