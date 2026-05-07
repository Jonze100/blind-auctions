"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { CreateAuctionPanel } from "@/components/CreateAuctionPanel";
import { ActiveAuctionPanel } from "@/components/ActiveAuctionPanel";
import { AuctionType } from "@/lib/program";

type AuctionState = {
  type: AuctionType;
  slots: number;
  pda: PublicKey;
  bidCount: number;
};

export default function Home() {
  const { publicKey } = useWallet();
  const [auction, setAuction] = useState<AuctionState | null>(null);

  function handleAuctionCreated(type: AuctionType, slots: number, pda: PublicKey) {
    setAuction({ type, slots, pda, bidCount: 0 });
  }

  function handleBidSubmitted() {
    setAuction((prev) => prev ? { ...prev, bidCount: prev.bidCount + 1 } : prev);
  }

  return (
    <main
      style={{
        maxWidth: "1100px",
        margin: "0 auto",
        padding: "2rem 1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "2rem",
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: "center", padding: "1rem 0 0.5rem" }}>
        <h1
          style={{
            fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
            fontWeight: 800,
            color: "#fff",
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
          }}
        >
          Encrypted auctions,{" "}
          <span style={{ color: "#9945FF" }}>private bids</span>
        </h1>
        <p style={{ color: "#666", fontSize: "0.9rem", marginTop: "0.5rem" }}>
          Powered by Arcium MPC — no one sees your bid until the auction closes
        </p>
      </div>

      {/* Two-column layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 380px) 1fr",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        {/* Left — Create / Join */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <CreateAuctionPanel onAuctionCreated={handleAuctionCreated} />

          {!publicKey && (
            <div
              style={{
                background: "rgba(153,69,255,0.06)",
                border: "1px solid rgba(153,69,255,0.2)",
                borderRadius: "10px",
                padding: "1rem",
                fontSize: "0.82rem",
                color: "#999",
                lineHeight: 1.6,
              }}
            >
              Connect your <strong style={{ color: "#9945FF" }}>Phantom</strong> wallet
              to create auctions and submit encrypted bids on Solana devnet.
            </div>
          )}
        </div>

        {/* Right — Active Auction */}
        <div>
          {auction ? (
            <ActiveAuctionPanel
              auctionType={auction.type}
              slots={auction.slots}
              bidCount={auction.bidCount}
              auctionPda={auction.pda}
              onBidSubmitted={handleBidSubmitted}
            />
          ) : (
            <EmptyAuction />
          )}
        </div>
      </div>
    </main>
  );
}

function EmptyAuction() {
  return (
    <div
      style={{
        background: "#111",
        border: "1px dashed #222",
        borderRadius: "12px",
        padding: "3rem 2rem",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        minHeight: "320px",
      }}
    >
      <div style={{ fontSize: "2.5rem" }}>🔒</div>
      <div style={{ color: "#555", fontSize: "0.9rem", textAlign: "center" }}>
        No active auction.
        <br />
        Create one on the left to get started.
      </div>
    </div>
  );
}
