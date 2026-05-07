"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumProgram,
} from "@arcium-hq/client";
import {
  PROGRAM_ID,
  AuctionType,
  getBaseAccounts,
  COMP_DEFS,
} from "@/lib/program";
import { setupCipher, encryptBid, pubkeyToLoHi, deserializeLE } from "@/lib/arcium";
import idl from "@/lib/idl.json";

const CARD_STYLE: React.CSSProperties = {
  background: "#111",
  border: "1px solid #222",
  borderRadius: "12px",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const LABEL: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "#888",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  marginBottom: "4px",
};

const INPUT: React.CSSProperties = {
  background: "#0a0a0a",
  border: "1px solid #333",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "0.9rem",
  padding: "0.6rem 0.8rem",
  width: "100%",
  outline: "none",
  boxSizing: "border-box",
};

const BTN: React.CSSProperties = {
  background: "#9945FF",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "0.7rem 1.2rem",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
};

const BTN_DISABLED: React.CSSProperties = {
  ...BTN,
  background: "#3a1f6e",
  cursor: "not-allowed",
  opacity: 0.6,
};

const BTN_GREEN: React.CSSProperties = {
  ...BTN,
  background: "#0e8a55",
};

type Props = {
  auctionType: AuctionType;
  slots: number;
  bidCount: number;
  auctionPda: PublicKey;
  onBidSubmitted: () => void;
};

type Result = {
  clearingPrice: string;
  winnerLo?: string;
  winnerHi?: string;
};

function genComputationOffset(): BN {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return new BN(Buffer.from(buf).toString("hex"), "hex");
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: "12px",
        height: "12px",
        border: "2px solid rgba(255,255,255,0.3)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        marginRight: "6px",
        verticalAlign: "middle",
      }}
    />
  );
}

export function ActiveAuctionPanel({
  auctionType,
  slots,
  bidCount,
  auctionPda,
  onBidSubmitted,
}: Props) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState("");
  const [bidStatus, setBidStatus] = useState("");
  const [resolveStatus, setResolveStatus] = useState("");
  const [bidLoading, setBidLoading] = useState(false);
  const [resolveLoading, setResolveLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const connected = !!wallet.publicKey;

  function getProvider() {
    return new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  }

  async function handleSubmitBid() {
    if (!wallet.publicKey || !amount) return;
    setBidLoading(true);
    setBidStatus("Encrypting bid…");
    try {
      const provider = getProvider();
      const program = new Program(idl as any, provider);

      const { publicKey: bidPubKey, cipher } = await setupCipher(provider);
      const { lo, hi } = pubkeyToLoHi(wallet.publicKey);
      const { nonce, ciphertexts } = encryptBid(
        cipher,
        BigInt(amount),
        lo,
        hi
      );
      const bidNonce = deserializeLE(nonce);
      const computationOffset = genComputationOffset();

      // Read current auction state to get book pub key/nonce and bid count
      const stateRaw = await connection.getAccountInfo(auctionPda);
      if (!stateRaw) throw new Error("Auction state account not found");

      // AuctionState layout (after 8-byte discriminator):
      // [8..40]  creator
      // [40]     auction_type
      // [41..48] _pad0
      // [48..56] slots
      // [56..64] bid_count
      // [64..96] book_pub_key
      // [96..112] book_nonce
      // [112..]  book_ciphertexts
      const data = stateRaw.data;
      const bookPubKey = Array.from(data.slice(64, 96));
      const bookNonceBytes = data.slice(96, 112);
      const bookNonce = deserializeLE(bookNonceBytes);
      const currentBidCount = Number(data.readBigUInt64LE(56));

      // book_ciphertexts: 13 × 32 = 416 bytes starting at offset 112
      // Layout: [bid_0_amount, bid_0_lo, bid_0_hi, bid_1_amount, ...] then count_ct at index 12
      const ctBase = 112;
      const bidCts: number[][] = [];
      for (let i = 0; i < 4; i++) {
        const base = ctBase + i * 3 * 32;
        bidCts.push(Array.from(data.slice(base, base + 32)));
        bidCts.push(Array.from(data.slice(base + 32, base + 64)));
        bidCts.push(Array.from(data.slice(base + 64, base + 96)));
      }
      const countCt = Array.from(data.slice(ctBase + 12 * 32, ctBase + 13 * 32));

      setBidStatus("Sending bid tx…");
      await (program.methods as any)
        .submitBid(
          computationOffset,
          Array.from(ciphertexts[0]),
          Array.from(ciphertexts[1]),
          Array.from(ciphertexts[2]),
          Array.from(bidPubKey),
          new BN(bidNonce.toString())
        )
        .accountsPartial({
          ...getBaseAccounts(computationOffset),
          compDefAccount: COMP_DEFS.submit_bid,
          auctionState: auctionPda,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      setBidStatus("MPC computing…");
      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
        300_000
      );

      setBidStatus("Bid submitted ✓");
      onBidSubmitted();
    } catch (e: any) {
      setBidStatus("Error: " + (e?.message ?? String(e)));
    } finally {
      setBidLoading(false);
    }
  }

  async function handleResolve() {
    if (!wallet.publicKey) return;
    setResolveLoading(true);
    setResolveStatus("Queuing MPC computation…");
    setResult(null);
    try {
      const provider = getProvider();
      const program = new Program(idl as any, provider);
      const computationOffset = genComputationOffset();

      if (auctionType === "Uniform") {
        // Listen for ClearingPriceEvent
        const eventPromise = new Promise<any>((resolve) => {
          const listener = program.addEventListener("clearingPriceEvent", (e: any) => {
            program.removeEventListener(listener);
            resolve(e);
          });
          setTimeout(() => resolve(null), 120_000);
        });

        await (program.methods as any)
          .findClearingPrice(computationOffset)
          .accountsPartial({
            ...getBaseAccounts(computationOffset),
            compDefAccount: COMP_DEFS.find_clearing_price,
            auctionState: auctionPda,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        setResolveStatus("MPC computing…");
        await awaitComputationFinalization(
          provider,
          computationOffset,
          PROGRAM_ID,
          "confirmed",
          300_000
        );
        const ev = await eventPromise;
        if (ev) {
          setResult({ clearingPrice: ev.clearingPrice.toString() });
          setResolveStatus("Done ✓");
        }
      } else {
        const methodName =
          auctionType === "Vickrey" ? "findWinnerVickrey" : "findWinnerSealed";
        const compDef =
          auctionType === "Vickrey"
            ? COMP_DEFS.find_winner_vickrey
            : COMP_DEFS.find_winner_sealed;

        const eventPromise = new Promise<any>((resolve) => {
          const listener = program.addEventListener("auctionWinnerEvent", (e: any) => {
            program.removeEventListener(listener);
            resolve(e);
          });
          setTimeout(() => resolve(null), 120_000);
        });

        await (program.methods as any)
          [methodName](computationOffset)
          .accountsPartial({
            ...getBaseAccounts(computationOffset),
            compDefAccount: compDef,
            auctionState: auctionPda,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });

        setResolveStatus("MPC computing…");
        await awaitComputationFinalization(
          provider,
          computationOffset,
          PROGRAM_ID,
          "confirmed",
          300_000
        );
        const ev = await eventPromise;
        if (ev) {
          setResult({
            clearingPrice: ev.clearingPrice.toString(),
            winnerLo: ev.winnerLo.toString(),
            winnerHi: ev.winnerHi.toString(),
          });
          setResolveStatus("Done ✓");
        }
      }
    } catch (e: any) {
      setResolveStatus("Error: " + (e?.message ?? String(e)));
    } finally {
      setResolveLoading(false);
    }
  }

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={CARD_STYLE}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1rem", color: "#fff", fontWeight: 600 }}>
            Active Auction
          </h2>
          <span
            style={{
              fontSize: "0.75rem",
              color: "#9945FF",
              background: "rgba(153,69,255,0.12)",
              border: "1px solid rgba(153,69,255,0.3)",
              borderRadius: "6px",
              padding: "2px 8px",
              fontWeight: 600,
            }}
          >
            {auctionType}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.75rem",
          }}
        >
          <Stat label="Bids received" value={String(bidCount)} />
          {auctionType === "Uniform" && <Stat label="Slots" value={String(slots)} />}
        </div>

        {/* Submit Bid */}
        <div style={{ borderTop: "1px solid #1e1e1e", paddingTop: "1rem" }}>
          <div style={LABEL}>Submit Bid</div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "4px" }}>
            <input
              type="number"
              min="1"
              placeholder="Amount (lamports)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ ...INPUT, flex: 1 }}
            />
            <button
              onClick={handleSubmitBid}
              disabled={!connected || bidLoading || !amount}
              style={{
                ...((!connected || bidLoading || !amount) ? BTN_DISABLED : BTN),
                width: "auto",
                padding: "0 1rem",
                whiteSpace: "nowrap",
              }}
            >
              {bidLoading ? <><Spinner />Bidding…</> : "Bid"}
            </button>
          </div>
          {bidStatus && (
            <StatusLine status={bidStatus} loading={bidLoading} />
          )}
        </div>

        {/* Resolve */}
        <div style={{ borderTop: "1px solid #1e1e1e", paddingTop: "1rem" }}>
          <button
            onClick={handleResolve}
            disabled={!connected || resolveLoading || bidCount === 0}
            style={
              !connected || resolveLoading || bidCount === 0
                ? BTN_DISABLED
                : BTN_GREEN
            }
          >
            {resolveLoading ? (
              <><Spinner />MPC computing…</>
            ) : (
              `Resolve Auction (${auctionType})`
            )}
          </button>
          {resolveStatus && (
            <StatusLine status={resolveStatus} loading={resolveLoading} />
          )}
        </div>

        {/* Result */}
        {result && (
          <div
            style={{
              background: "rgba(20,241,149,0.06)",
              border: "1px solid rgba(20,241,149,0.25)",
              borderRadius: "10px",
              padding: "1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                color: "#14F195",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                fontWeight: 700,
              }}
            >
              Result
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "0.4rem",
              }}
            >
              <span style={{ fontSize: "2rem", fontWeight: 700, color: "#14F195" }}>
                {result.clearingPrice}
              </span>
              <span style={{ color: "#888", fontSize: "0.85rem" }}>
                {auctionType === "Uniform" ? "clearing price" : "SOL (lamports)"}
              </span>
            </div>
            {result.winnerLo !== undefined && (
              <div style={{ fontSize: "0.75rem", color: "#aaa", wordBreak: "break-all" }}>
                <span style={{ color: "#666" }}>Winner lo: </span>
                <span style={{ color: "#ddd" }}>{result.winnerLo}</span>
                {"  "}
                <span style={{ color: "#666" }}>hi: </span>
                <span style={{ color: "#ddd" }}>{result.winnerHi}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: "#0a0a0a",
        borderRadius: "8px",
        padding: "0.75rem",
        border: "1px solid #1e1e1e",
      }}
    >
      <div style={{ ...LABEL, marginBottom: "2px" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, color: "#fff" }}>{value}</div>
    </div>
  );
}

function StatusLine({ status, loading }: { status: string; loading: boolean }) {
  const isError = status.startsWith("Error");
  return (
    <div
      style={{
        marginTop: "0.5rem",
        fontSize: "0.8rem",
        color: isError ? "#ff6b6b" : loading ? "#aaa" : "#14F195",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      {loading && <Spinner />}
      {status}
    </div>
  );
}
