"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function Header() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 2rem",
        height: "64px",
        borderBottom: "1px solid #1a1a1a",
        background: "#0d0d0d",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span
          style={{
            fontSize: "1.25rem",
            fontWeight: 700,
            color: "#fff",
            letterSpacing: "-0.02em",
          }}
        >
          Blind<span style={{ color: "#9945FF" }}>Auctions</span>
        </span>
        <span
          style={{
            fontSize: "0.65rem",
            fontWeight: 600,
            color: "#14F195",
            background: "rgba(20,241,149,0.1)",
            border: "1px solid rgba(20,241,149,0.3)",
            borderRadius: "4px",
            padding: "2px 6px",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          Devnet
        </span>
      </div>
      <WalletMultiButton
        style={{
          background: "#9945FF",
          borderRadius: "8px",
          fontSize: "0.85rem",
          height: "36px",
          padding: "0 1rem",
        }}
      />
    </header>
  );
}
