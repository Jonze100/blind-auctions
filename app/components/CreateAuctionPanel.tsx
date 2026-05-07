"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { awaitComputationFinalization, deserializeLE } from "@arcium-hq/client";
import { PROGRAM_ID, AUCTION_TYPES, AuctionType, getAuctionPDA } from "@/lib/program";
import { setupCipher, deserializeLE as deserLE } from "@/lib/arcium";
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

type Props = {
  onAuctionCreated: (type: AuctionType, slots: number, auctionPda: PublicKey) => void;
};

export function CreateAuctionPanel({ onAuctionCreated }: Props) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [auctionType, setAuctionType] = useState<AuctionType>("Sealed-Bid");
  const [slots, setSlots] = useState("2");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) return;
    setLoading(true);
    setStatus("Generating book keypair…");
    try {
      const provider = new AnchorProvider(connection, wallet as any, {
        commitment: "confirmed",
      });
      const program = new Program(idl as any, provider);

      const { publicKey: bookPubKey } = await setupCipher(provider);
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const bookNonce = deserLE(nonce);

      const auctionTypeNum = AUCTION_TYPES.indexOf(auctionType);
      const slotsNum = auctionType === "Uniform" ? parseInt(slots) || 2 : 1;
      const auctionPda = getAuctionPDA(wallet.publicKey);

      setStatus("Sending createAuction tx…");
      await (program.methods as any)
        .createAuction(
          auctionTypeNum,
          new BN(slotsNum),
          Array.from(bookPubKey),
          new BN(bookNonce.toString())
        )
        .accounts({ creator: wallet.publicKey })
        .rpc({ skipPreflight: true, commitment: "confirmed" });

      setStatus("Auction created ✓");
      onAuctionCreated(auctionType, slotsNum, auctionPda);
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? String(e)));
    } finally {
      setLoading(false);
    }
  }

  const connected = !!wallet.publicKey;

  return (
    <div style={CARD_STYLE}>
      <h2 style={{ margin: 0, fontSize: "1rem", color: "#fff", fontWeight: 600 }}>
        Create Auction
      </h2>

      <div>
        <div style={LABEL}>Auction Type</div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {AUCTION_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setAuctionType(t)}
              style={{
                flex: 1,
                padding: "0.5rem",
                borderRadius: "8px",
                border: auctionType === t ? "2px solid #9945FF" : "1px solid #333",
                background: auctionType === t ? "rgba(153,69,255,0.15)" : "#0a0a0a",
                color: auctionType === t ? "#9945FF" : "#888",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {auctionType === "Uniform" && (
        <div>
          <div style={LABEL}>Slots (units for sale)</div>
          <input
            type="number"
            min="1"
            max="4"
            value={slots}
            onChange={(e) => setSlots(e.target.value)}
            style={INPUT}
          />
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={!connected || loading}
        style={!connected || loading ? BTN_DISABLED : BTN}
      >
        {loading ? "Creating…" : !connected ? "Connect Wallet First" : "Create Auction"}
      </button>

      {status && (
        <div
          style={{
            fontSize: "0.8rem",
            color: status.startsWith("Error") ? "#ff6b6b" : "#14F195",
            background: status.startsWith("Error")
              ? "rgba(255,107,107,0.08)"
              : "rgba(20,241,149,0.08)",
            borderRadius: "6px",
            padding: "0.5rem 0.75rem",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
